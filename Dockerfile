# Imager 镜像上传管理工具
FROM docker.1ms.run/library/node:18-alpine

# 安装必要的系统工具
RUN apk add --no-cache \
    bash \
    curl \
    tar \
    skopeo \
    gzip

# 设置工作目录
WORKDIR /app

# 复制 package.json 和 package-lock.json
COPY package*.json ./

# 安装依赖
RUN npm install

# 复制应用代码
COPY . .

# 创建 uploads 目录
RUN mkdir -p uploads

# 暴露端口
EXPOSE 8080

# 启动命令
CMD ["node", "server.js"]
