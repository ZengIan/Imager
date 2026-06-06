#!/bin/bash
# ==========================================================
# upload-images.sh - 镜像批量自动化导入和更新工具 (架构双保险自适应版)
# ==========================================================
set -euo pipefail

# ── 颜色 ──────────────────────────────────────────────────
GREEN=$'\e[0;32m'
YELLOW=$'\e[1;33m'
RED=$'\e[0;31m'
CYAN=$'\e[0;36m'
NC=$'\e[0m'
BLUE='\033[1;34m'

# ── 交互式配置仓库 ────────────────────────────────────────
DEFAULT_REGISTRY="harbor.rise.io/camp"
echo -e "${CYAN}================================================${NC}"
echo -e "${CYAN}                镜像批量导入工具                ${NC}"
echo -e "${CYAN}================================================${NC}"
read -r -p "请输入目标仓库地址 [默认: $DEFAULT_REGISTRY]: " USER_REGISTRY

REGISTRY="${USER_REGISTRY:-$DEFAULT_REGISTRY}"
REGISTRY="${REGISTRY%/}" # 自动去掉末尾可能误输入的斜杠

TLS_FLAG="--tls-verify=false"
SUCCESS=0
FAILED=0
declare -a TAR_FILES
declare -a PUSHED_IMAGES  # 成功推送的镜像列表: "image_name|tag|full_ref"

# 检查依赖
check_deps() {
    if ! command -v skopeo &>/dev/null; then
        echo -e "${RED}[错误] 未找到 skopeo，请先安装 (apt/yum install skopeo)${NC}"
        exit 1
    fi
    if ! command -v tar &>/dev/null; then
        echo -e "${RED}[错误] 未找到 tar 命令${NC}"
        exit 1
    fi
}

# 登录检查
check_login() {
    local registry_domain="${REGISTRY%%/*}"
    local auth_file="${HOME}/.docker/config.json"
    [ ! -f "$auth_file" ] && auth_file="${XDG_RUNTIME_DIR}/containers/auth.json"
    [ ! -f "$auth_file" ] && auth_file="${HOME}/.config/containers/auth.json"
    
    if [ -f "$auth_file" ] && grep -q "$registry_domain" "$auth_file" 2>/dev/null; then
        echo -e "${GREEN}[✓] 镜像仓库 $registry_domain 已登录${NC}"
        return 0
    fi

    echo ""
    echo -e "${YELLOW}   请登录镜像仓库 $registry_domain${NC}"
    if skopeo login $TLS_FLAG "$registry_domain"; then
        echo -e "${GREEN}[✓] 登录成功${NC}"
    else
        echo -e "${RED}[错误] 登录失败${NC}"
        echo -n "是否忽略并继续？(y/N): "
        read -r ans
        [[ ! "$ans" =~ ^[Yy] ]] && exit 1
    fi
}

# 核心函数：解析并推送
process_and_push() {
    local tar_file="$1"
    local common_flags="--insecure-policy $TLS_FLAG"
    local errlog="/tmp/skopeo_$$_${RANDOM}.log"

    # 1. 直接输出当前正在处理的 tar 包名
    echo -e "    ${CYAN}当前处理文件:${NC} ${tar_file}"

    # 2. 极致纯净内存流盲捞：通过 tar -xOf 精准定位
    local raw_tag=""
    local meta_content=""

    # 优先捞 Docker 规范的 manifest.json
    meta_content=$(tar -xOf "$tar_file" manifest.json 2>/dev/null || true)
    if [ -n "$meta_content" ]; then
        raw_tag=$(echo "$meta_content" \
            | grep -oE '"RepoTags"\s*:\s*\[\s*"[^"]+"' 2>/dev/null \
            | head -1 \
            | awk -F'"' '{print $(NF-1)}' || true)
    fi

    # 降级一：如果没找到，说明是纯 OCI 格式，直接死磕 index.json
    if [ -z "$raw_tag" ] || [ "$raw_tag" = "null" ]; then
        meta_content=$(tar -xOf "$tar_file" index.json 2>/dev/null || true)
        if [ -n "$meta_content" ]; then
            # 优先匹配 containerd 长格式镜像名
            raw_tag=$(echo "$meta_content" \
                | grep -oE '"io.containerd.image.name"\s*:\s*"[^"]+"' 2>/dev/null \
                | head -1 \
                | awk -F'"' '{print $(NF-1)}' || true)
            
            # 其次匹配 OCI 标准的参考标签名
            if [ -z "$raw_tag" ] || [ "$raw_tag" = "null" ]; then
                raw_tag=$(echo "$meta_content" \
                    | grep -oE '"org.opencontainers.image.ref.name"\s*:\s*"[^"]+"' 2>/dev/null \
                    | head -1 \
                    | awk -F'"' '{print $(NF-1)}' || true)
            fi
        fi
    fi
    # ==================================================================
    # 2. 核心解构【纯内存流：物理落盘优先级与全自动套娃穿透（修复引号版）】
    # ==================================================================
    local raw_tag=""
    local arch_list=""
    local image_name="unknown"
    local tag="latest"

    # 🌟 优先分支：判定 manifest.json 是否存在 (传统 Docker 包或落盘单架构包)
    if tar -tf "$tar_file" manifest.json &>/dev/null; then
        local manifest_content
        manifest_content=$(tar -xOf "$tar_file" manifest.json 2>/dev/null || echo "")

        # 1. 捞取 RepoTags 名字
        raw_tag=$(echo "$manifest_content" | grep -oE '"RepoTags"\s*:\s*\[\s*"[^"]+"' 2>/dev/null | head -1 | awk -F'"' '{print $(NF-1)}' || echo "")

        # 2. 穿透 Config 配置文件路径 (🌟 修复此处 awk 的多余引号)
        local cfg_file
        cfg_file=$(echo "$manifest_content" | grep -oE '"Config"\s*:\s*"[^"]+"' 2>/dev/null | head -1 | awk -F'"' '{print $4}' || echo "")
        if [ -n "$cfg_file" ]; then
            arch_list=$(tar -xOf "$tar_file" "$cfg_file" 2>/dev/null \
                | grep -ioE '"architecture"\s*:\s*"[^"]+"' 2>/dev/null \
                | awk -F'"' '{print $4}' \
                | grep -vi "unknown" || echo "")
        fi
        
        if [ -n "$raw_tag" ] && [ "$raw_tag" != "null" ] && [ -n "$arch_list" ]; then
            : # 顺利锁定物理层，跳出
        fi
    fi

    # 🌟 降级分支：如果上面没捞全，死磕 OCI 规范 (index.json) —— 适用于现代 OCI 包 (如 coredns, tempo)
    if [ -z "$arch_list" ] && tar -tf "$tar_file" index.json &>/dev/null; then
        local index_content
        index_content=$(tar -xOf "$tar_file" index.json 2>/dev/null || echo "")
        
        # 1. 捞取引用名和 Tag
        if [ -z "$raw_tag" ] || [ "$raw_tag" = "null" ]; then
            raw_tag=$(echo "$index_content" | grep -oE '"io.containerd.image.name"\s*:\s*"[^"]+"' 2>/dev/null | head -1 | awk -F'"' '{print $(NF-1)}' || echo "")
            if [ -z "$raw_tag" ]; then
                raw_tag=$(echo "$index_content" | grep -oE '"org.opencontainers.image.ref.name"\s*:\s*"[^"]+"' 2>/dev/null | head -1 | awk -F'"' '{print $(NF-1)}' || echo "")
            fi
        fi

        # 2. 提取第一层 manifests 指向的物理文件路径 (形如 blobs/sha256/5a8129...)
        local layer1_blobs
        layer1_blobs=$(echo "$index_content" \
            | grep -oE '"digest"\s*:\s*"sha256:[a-f0-9]{64}"' 2>/dev/null \
            | awk -F'"' '{print $4}' \
            | sed 's|sha256:|blobs/sha256/|g' || echo "")
        
        if [ -n "$layer1_blobs" ]; then
            # 先读取第一层内容
            local layer1_content
            layer1_content=$(tar -xOf "$tar_file" $layer1_blobs 2>/dev/null || echo "")
            
            # 3. 深度自适应穿透：尝试从第一层内容中提取最终的 "config" 哈希路径 (针对 tempo 等套娃包)
            local layer2_blobs
            layer2_blobs=$(echo "$layer1_content" \
                | grep -oE '"config"\s*:\s*\{\s*"mediaType"[^}]+"digest"\s*:\s*"sha256:[a-f0-9]{64}"' 2>/dev/null \
                | grep -oE '"sha256:[a-f0-9]{64}"' \
                | awk -F'"' '{print $2}' \
                | sed 's|sha256:|blobs/sha256/|g' || echo "")
                
            # 合并所有可能包含架构信息的文件路径
            local final_blobs
            final_blobs=$(echo -e "${layer1_blobs}\n${layer2_blobs}" | grep -v '^$' | sort -u || echo "")
            
            # 4. 统一在内存中提取架构，多架构和单架构通杀 (🌟 顺手把此处的 awk 规范化)
            if [ -n "$final_blobs" ]; then
                arch_list=$(tar -xOf "$tar_file" $final_blobs 2>/dev/null \
                    | grep -ioE '"architecture"\s*:\s*"[^"]+"' 2>/dev/null \
                    | awk -F'"' '{print $4}' \
                    | grep -vi "unknown" \
                    | sort -u \
                    | paste -sd, - || echo "")
            fi
        fi
    fi

    # ── 统一提取规范化 ──
    if [ -n "$raw_tag" ] && [ "$raw_tag" != "null" ]; then
        if [[ "$raw_tag" == *":"* ]]; then
            tag="${raw_tag##*:}"
            local full_name="${raw_tag%:*}"
            image_name="${full_name##*/}"
        else
            image_name="${raw_tag##*/}"
        fi
    fi

    if [ "$image_name" = "unknown" ] || [ -z "$image_name" ]; then
        local base_name="${tar_file##*/}"
        base_name="${base_name%.tar}"
        if [[ "$base_name" == *"_"* ]]; then
            tag="${base_name##*_}"
            local name_part="${base_name%_*}"
            image_name="${name_part##*_}"
        else
            image_name="$base_name"
            tag="latest"
        fi
    fi
    
    image_name=$(echo "$image_name" | tr 'A-Z' 'a-z' | tr '_' '-')
    arch_list="${arch_list:-unknown}"

    # 根据包含的架构自适应着色提示
    local arch_color="$GREEN"
    if [[ "$arch_list" == *"arm64"* || "$arch_list" == *"aarch64"* ]]; then
        arch_color="$YELLOW"
    fi

    # 3. 组装最终的目标推送地址
    local target="${REGISTRY}/${image_name}:${tag}"
    echo -e "    ${GREEN}[确定引用]${NC} ${image_name}:${tag}  (检测架构: ${arch_color}${arch_list}${NC})"
    echo -e "    ${CYAN}目标推送地址:${NC} ${target}"


    # 4. 推送流程：根据精准检测到的架构数量，智能选择推送策略
    echo -e "    ${YELLOW}正在准备通过 oci-archive 推送镜像到 Harbor...${NC}"
    
    # 🌟 判断是单架构还是多架构 (检查 arch_list 中是否包含逗号)
    if [[ "$arch_list" == *","* ]]; then
        echo -e "    ${GREEN}[多架构流] 检测到物理多架构: ${arch_list}，执行全量多架构推送...${NC}"
        # 真正多架构包，带上 --multi-arch all 确保完整性
        skopeo copy $common_flags --multi-arch all "oci-archive:${tar_file}" "docker://${target}" 2>"$errlog" || true
    else
        echo -e "    ${BLUE}[单架构流] 检测到实际单架构: ${arch_list}，执行单架构层推送...${NC}"
        # 剥离多架构外壳，不带 --multi-arch 参数，100% 避免虚空多架构包（如 console-ui）在 2/2 时报错崩溃
        skopeo copy $common_flags "oci-archive:${tar_file}" "docker://${target}" 2>"$errlog" || true
    fi

    # 5. 双重校验上传结果
    if [ ! -s "$errlog" ] || grep -q -E "✓|success" "$errlog" 2>/dev/null; then
        rm -f "$errlog"
        echo -e "    ${GREEN}✓ 上传成功 [架构: ${arch_color}${arch_list}${GREEN}]${NC}"
        PUSHED_IMAGES+=("${image_name}|${tag}|${target}")
        return 0
    else
        if skopeo inspect $common_flags "docker://${target}" &>/dev/null; then
            rm -f "$errlog"
            echo -e "    ${GREEN}✓ 上传成功 (通过远端验证) [架构: ${arch_color}${arch_list}${GREEN}]${NC}"
            PUSHED_IMAGES+=("${image_name}|${tag}|${target}")
            return 0
        fi
    fi

    echo -e "    ${RED}✗ 镜像上传失败，错误日志:${NC}"
    sed 's/^/      /' "$errlog"
    rm -f "$errlog"
    return 1
}

# ── Kubernetes 工作负载更新 (实时回显 kubectl get pod 状态) ──
update_k8s_workloads() {
    if ! command -v kubectl &>/dev/null; then
        return
    fi
    if ! kubectl cluster-info &>/dev/null 2>&1; then
        return
    fi

    for entry in "${PUSHED_IMAGES[@]}"; do
        IFS='|' read -r img_name tag new_ref <<< "$entry"

        for kind in deploy sts ds; do
            local resources
            resources=$(kubectl get "$kind" -A -o jsonpath='{range .items[*]}{.metadata.namespace}{"\t"}{.metadata.name}{"\t"}{range .spec.template.spec.containers[*]}{.name}{"\t"}{.image}{"\n"}{end}{end}' 2>/dev/null || true)
            [ -z "$resources" ] && continue

            while IFS=$'\t' read -r ns name cname cur_img; do
                [ -z "$ns" ] && continue
                
                local img_base="${cur_img%:*}"
                img_base="${img_base##*/}"

                if [ "$img_base" = "$img_name" ]; then
                    echo ""
                    echo -e "${YELLOW}发现匹配的 K8s 工作负载:${NC}"
                    echo -e "  类型: ${kind} | 命名空间: ${ns} | 名称: ${name}"
                    echo -e "  容器: ${cname} | 当前镜像: ${cur_img}"
                    echo -e "  新镜像: ${new_ref}"
                    
                    echo -n "是否执行 K8s 工作负载更新并滚动查看 Pod 状态？(y/N): "
                    read -r confirm </dev/tty
                    
                    if [[ "$confirm" =~ ^[Yy]$ ]]; then
                        local exec_cmd="kubectl set image ${kind}/${name} ${cname}=${new_ref} -n ${ns}"
                        
                        echo -e "    ${CYAN}[执行指令] ${exec_cmd}${NC}"
                        echo -e "    ${YELLOW}正在下发镜像更新指令...${NC}"
                        
                        if eval "$exec_cmd" &>/dev/null; then
                            # ==================================================================
                            # ✨ 替换开始：抗滚动更新背刺、支持套娃及自适应异常检测监控流 ✨
                            # ==================================================================
                            echo -e "    ${GREEN}→ 指令已下发，开始实时监控 Pod 状态（已开启新老更替过滤）...${NC}"
                            echo -e "    ${CYAN}------------------------------------------------------------${NC}"
                            
                            local start_time=$(date +%s)
                            local timeout=300              # 超时时间调整为硬核 5 分钟
                            local is_running=false
                            
                            while true; do
                                local current_time=$(date +%s)
                                local elapsed=$((current_time - start_time))
                                
                                # 1. 精准抓取当前命名空间下匹配该镜像名的所有 Pod
                                local pod_raw_list
                                pod_raw_list=$(kubectl get pod -n "${ns}" 2>/dev/null | grep "${img_name}" || true)
                                
                                if [ -z "$pod_raw_list" ]; then
                                    echo -e "    ${YELLOW}[等待] 尚未捕获到相关 Pod... (${elapsed}s)${NC}"
                                    sleep 3
                                    continue
                                fi
                                
                                # 2. 实时打印当前集群的真实风云变幻（红绿高亮回显）
                                echo -e "${pod_status:-$pod_raw_list}"
                                
                                # 3. 实时熔断检测：如果新 Pod 刚诞生就卡在错误状态，立刻警报并跳出
                                if echo "$pod_raw_list" | grep -qE "ErrImagePull|ImagePullBackOff|CrashLoopBackOff"; then
                                    echo ""
                                    echo -e "    ${RED}✗ 检测到新 Pod 出现异常状态！可能存在拉包或启动错误，请尽快排查。${NC}"
                                    break
                                fi
                                
                                # 4. 核心过滤基因：剔除 Terminating，且 AGE 尾部必须是 s 或 m（绝不吃老 Pod 9d/74m 的安利）
                                local active_new_pods
                                active_new_pods=$(echo "$pod_raw_list" \
                                    | grep -v "Terminating" \
                                    | grep "1/1" \
                                    | grep "Running" \
                                    | grep -E "[0-9]+(s|m)$" || echo "")
                                    
                                # 5. 终验成功判定：只要发现了完全健康、刚出生的新 Pod，并且确认通过就绪检查
                                if [ -n "$active_new_pods" ]; then
                                    is_running=true
                                    break
                                fi
                                
                                # 6. 超时兜底
                                if [ "$elapsed" -ge "$timeout" ]; then
                                    echo ""
                                    echo -e "    ${RED}✗ 监控超时 (${timeout}s)，新 Pod 未能在规定时间内完全就绪，请手动核对。${NC}"
                                    break
                                fi
                                
                                sleep 3
                                echo -e "    ${CYAN}- - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -${NC}"
                            done
                            
                            echo -e "    ${CYAN}------------------------------------------------------------${NC}"
                            if [ "$is_running" = true ]; then
                                echo -e "    ${GREEN}✓ 终验成功：检测到全新 Pod 已经成功运行且通过就绪检查！${NC}"
                            fi
                            # ==================================================================
                            # ✨ 替换结束 ✨
                            # ==================================================================
                        else
                            echo -e "    ${RED}✗ 指令下发失败，请检查配置或权限。${NC}"
                        fi
                    else
                        echo -e "    ${YELLOW}已跳过当前负载更新${NC}"
                    fi
                fi
            done <<< "$resources"
        done
    done
}

# ── 主流程 ────────────────────────────────────────────────
check_deps

shopt -s nullglob
TAR_FILES=(*.tar *.tgz *.tar.gz)
if [ ${#TAR_FILES[@]} -eq 0 ]; then
    echo -e "${RED}[错误] 当前目录下未找到任何 .tar/.tgz/.tar.gz 镜像文件${NC}"
    exit 1
fi

check_login

echo ""
echo -e "${YELLOW}即将开始处理 ${#TAR_FILES[@]} 个镜像文件...${NC}"
echo ""

TOTAL=${#TAR_FILES[@]}
INDEX=0

for tar_file in "${TAR_FILES[@]}"; do
    INDEX=$((INDEX + 1))
    echo -e "${YELLOW}[${INDEX}/${TOTAL}] 正在处理第 ${INDEX} 个文件...${NC}"
    
    if process_and_push "$tar_file"; then
        SUCCESS=$((SUCCESS + 1))
    else
        FAILED=$((FAILED + 1))
    fi
    echo ""
done

if [ "$SUCCESS" -gt 0 ]; then
    update_k8s_workloads
fi

echo "================================================"
if [ "$FAILED" -eq 0 ]; then
    echo -e " ${GREEN}全部完成! 成功推送 ${SUCCESS} 个镜像${NC}"
else
    echo -e " ${YELLOW}完成: 成功 ${SUCCESS} 个, 失败 ${FAILED} 个${NC}"
fi

if [ ${#PUSHED_IMAGES[@]} -gt 0 ]; then
    for entry in "${PUSHED_IMAGES[@]}"; do
        IFS='|' read -r _ _ full_target <<< "$entry"
        echo -e "   ${GREEN}→${NC} ${full_target}"
    done
fi
echo "=================================================="

exit $([ "$FAILED" -eq 0 ] && echo 0 || echo 1)