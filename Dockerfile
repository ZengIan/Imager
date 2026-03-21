# Imager 镜像游侠 - 一站式容器镜像与文件传输管理平台
# 支持功能: Harbor镜像管理、SFTP文件传输、本地镜像导入

FROM docker.1ms.run/library/node:18-alpine

LABEL maintainer="Imager"
LABEL description="容器镜像与文件传输管理平台"
LABEL version="2.0"

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

# 安装依赖
RUN npm install

# 复制应用代码
COPY . .

# 创建必要目录
RUN mkdir -p uploads/temp

# 暴露端口
EXPOSE 8080

# 启动命令
CMD ["node", "server.js"]
