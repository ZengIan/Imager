#!/bin/bash
# Imager 多架构构建脚本
# 用法: ./buildx.sh [push|load|save]

set -e

IMAGE="zengian/imager"
VERSION=$2

# 安装 QEMU 支持（多架构必需）
#docker run --privileged --rm tonistiigi/binfmt --install all

# 创建构建器（如已存在则跳过）
docker buildx create --name imager-builder --driver docker-container --use 2>/dev/null || true
docker buildx inspect --bootstrap

case "$1" in
    push)
        # 构建并推送到 Docker Hub
        docker buildx build \
            --platform linux/amd64,linux/arm64 \
            --provenance=false \
            --tag ${IMAGE}:${VERSION} \
            --tag ${IMAGE}:latest \
            --push .
        echo "推送完成: ${IMAGE}:${VERSION}"
        ;;
    load)
        # 构建并加载到本地（仅 amd64）
        docker buildx build \
            --platform linux/amd64 \
            --provenance=false \
            --tag ${IMAGE}:${VERSION} \
            --load .
        echo "本地镜像: ${IMAGE}:${VERSION}"
        ;;
    save)
        # 构建并导出为 tar 文件
        docker buildx build \
            --platform linux/amd64,linux/arm64 \
            --tag ${IMAGE}:${VERSION} \
            --provenance=false \
            --output type=oci,dest=imager-${VERSION}.tar .
        echo "导出文件: imager-${VERSION}.tar"
        ;;
    *)
        # 默认：构建但不推送
        docker buildx build \
            --platform linux/amd64,linux/arm64 \
            --provenance=false \
            --tag ${IMAGE}:${VERSION} \
            --tag ${IMAGE}:latest .
        echo "构建完成: ${IMAGE}:${VERSION}"
        ;;
esac
