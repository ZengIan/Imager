#!/bin/bash

# 获取脚本所在目录
cd "$(dirname "$0")"

echo "================================"
echo " Imager 镜像游侠管理工具"
echo "================================"

# 查找并停止占用 8080 端口的进程
echo "检查端口 8080..."
PID=$(lsof -ti:8080 2>/dev/null)
if [ -n "$PID" ]; then
    echo "停止占用 8080 端口的进程 (PID: $PID)..."
    kill -9 $PID 2>/dev/null || true
    sleep 1
    echo "已停止"
else
    echo "端口 8080 未被占用"
fi

# 检查 node_modules 是否存在
if [ ! -d "node_modules" ]; then
    echo "安装依赖..."
    npm install
fi

echo ""
echo "启动服务器..."
echo "访问地址: http://localhost:8080"
echo "================================"
node server.js
