# Imager 镜像游侠 - 一站式容器镜像与文件传输管理平台
# 支持功能: Harbor镜像管理、SFTP文件传输、本地镜像导入

FROM --platform=$BUILDPLATFORM docker.1ms.run/library/node:18-alpine

# 注入 Buildx 自动提供的变量
ARG TARGETPLATFORM
ARG TARGETARCH

LABEL maintainer="Imager"
LABEL description="容器镜像与文件传输管理平台"
LABEL version="2.0"

# 设置时区
ENV TZ=Asia/Shanghai

# 配置 Alpine 阿里云镜像源（加速 apk 安装）
RUN sed -i 's/dl-cdn.alpinelinux.org/mirrors.aliyun.com/g' /etc/apk/repositories

# 安装系统依赖
# - bash: Shell 脚本支持
# - curl: HTTP 请求工具和健康检查
# - tar/gzip: 镜像包解压
# - skopeo: 镜像同步（支持多架构）
# - rclone: SFTP 文件传输（内置 SSH 实现）
RUN apk add --no-cache \
    bash \
    curl \
    tar \
    gzip \
    skopeo \
    rclone

# 设置工作目录
WORKDIR /app

# 配置 npm 淘宝镜像源
RUN npm config set registry https://registry.npmmirror.com

# 复制 package 文件，利用 Docker 缓存层
COPY package*.json ./

# 安装 Node.js 依赖
RUN npm install --production

# 复制应用代码
COPY . /app

# 修复 Windows 换行符并设置执行权限
RUN sed -i 's/\r$//' /app/entrypoint.sh && chmod +x /app/entrypoint.sh

# 设置默认环境变量（防止启动报错，默认指向回环地址或留空）
ENV HARBOR_IP=""

# 设置启动入口
ENTRYPOINT ["/app/entrypoint.sh"]

# 创建必要目录
RUN mkdir -p uploads/temp

# 暴露端口
EXPOSE 8080

# 启动命令
CMD ["node", "server.js"]
