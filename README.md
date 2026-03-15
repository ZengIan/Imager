# Harbor 镜像上传管理界面（含后端 API）

现在项目包含一个可运行的 **前端 + Node.js 后端**：

- Harbor 连接配置（后端内存保存）
- 同步公网镜像任务创建
- 手动上传 tar 包任务创建（当前为元数据提交）
- 任务列表查询

> 说明：当前后端是开发原型，主要用于打通 UI 与 API 流程，还未执行真实 `docker pull/tag/push` 与二进制文件落盘。

## 启动

```bash
node server.js
```

然后访问 <http://localhost:8080>。

## API

- `POST /api/harbor/config`
- `POST /api/images/sync`
- `POST /api/images/upload`
- `GET /api/tasks`

## API 调用示例

```bash
curl -X POST http://127.0.0.1:8080/api/harbor/config \
  -H 'Content-Type: application/json' \
  -d '{"harborUrl":"https://harbor.example.com","project":"library","username":"admin","password":"***"}'

curl -X POST http://127.0.0.1:8080/api/images/sync \
  -H 'Content-Type: application/json' \
  -d '{"sourceImage":"docker.io/library/nginx:1.27","targetRepo":"library/nginx","targetTag":"1.27"}'

curl http://127.0.0.1:8080/api/tasks
```

## 生产化建议

1. 将 Harbor 凭据改为安全存储（如 Vault/KMS）。
2. `POST /api/images/upload` 改为 multipart 上传并接入 `docker load`。
3. `POST /api/images/sync` 接入任务队列，执行 `pull/tag/push` 并持久化任务状态。
4. 增加 Harbor 项目/仓库/标签存在性校验与 RBAC。
