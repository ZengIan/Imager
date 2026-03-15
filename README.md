# Harbor 镜像上传管理界面

一个轻量级前端原型，提供以下功能：

- Harbor 连接配置。
- 同步公网镜像到 Harbor 私有仓库（任务创建层）。
- 手动上传 tar 包并导入 Harbor（任务创建层）。
- 任务列表展示。

## 本地运行

```bash
python3 -m http.server 8080
```

然后访问 <http://localhost:8080>。

## 后续对接建议

前端已预留典型接口：

- `POST /api/harbor/config`
- `POST /api/images/sync`
- `POST /api/images/upload`
- `GET /api/tasks`

实际接入 Harbor 时，建议在后端执行：

1. `docker pull <public-image>`
2. `docker tag <public-image> <harbor-repo>`
3. `docker login <harbor>`
4. `docker push <harbor-repo>`

上传 tar 包则可使用：

1. `docker load -i image.tar`
2. 重打 tag 并 push 到 Harbor。
