#!/bin/bash
set -e

# 如果传入了 HARBOR_IP 环境变量，则写入 /etc/hosts
if [ -n "$HARBOR_IP" ]; then
    echo "正在映射 $HARBOR_DOMAIN 到 $HARBOR_IP ..."
    # 使用 sed 确保不会重复添加，或者直接追加
    echo "$HARBOR_IP $HARBOR_DOMAIN" >> /etc/hosts
fi

# 执行 Dockerfile 中 CMD 传进来的命令 (即 node server.js)
exec "$@"