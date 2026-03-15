# Harbor 镜像上传管理系统

生产级别的 Harbor 镜像上传管理工具,支持公网镜像同步和 tar 包导入。

## 功能特性

- ✅ **安全的凭据管理**: Harbor 配置加密存储
- ✅ **实时任务监控**: 任务状态实时更新和日志查看
- ✅ **公网镜像同步**: 从公网 Docker Hub 等源同步镜像到 Harbor
- ✅ **tar 包导入**: 支持上传本地镜像 tar 包并导入 Harbor
- ✅ **任务持久化**: 任务状态和日志持久化存储
- ✅ **日志系统**: 完整的操作日志记录
- ✅ **连接验证**: Harbor 连接和认证验证

## 系统要求

- Node.js >= 16.0.0
- Docker (需要在系统 PATH 中)
- Harbor 私有镜像仓库

## 安装

1. 克隆项目
```bash
git clone https://github.com/ZengIan/ai-zcx.git
cd ai-zcx
```

2. 安装依赖
```bash
npm install
```

## 启动

```bash
npm start
```

服务器将启动在 `http://localhost:8080`

## 使用说明

### 1. 配置 Harbor 连接

填写以下信息并点击"验证连接":
- 仓库地址: Harbor 服务的完整 URL (如 `https://harbor.example.com`)
- 项目名称: Harbor 中的项目名
- 用户名: Harbor 用户名
- 密码/Token: Harbor 密码或访问令牌

验证通过后点击"保存配置"。

### 2. 同步公网镜像

1. 填写源镜像地址 (如 `docker.io/library/nginx:1.27`)
2. 填写目标仓库 (如 `library/nginx`)
3. 填写目标标签 (如 `1.27`)
4. 点击"创建同步任务"

系统会自动执行:
- `docker pull` 拉取源镜像
- `docker tag` 标记目标镜像
- `docker push` 推送到 Harbor

### 3. 上传 tar 包

1. 选择本地镜像 tar 包文件
2. 填写导入目标仓库
3. 填写导入标签
4. 点击"上传并导入"

系统会自动执行:
- 上传 tar 包到服务器
- `docker load` 加载镜像
- `docker tag` 标记目标镜像
- `docker push` 推送到 Harbor

### 4. 查看任务状态

任务列表实时显示所有任务的状态:
- **待执行**: 任务已创建,等待执行
- **执行中**: 任务正在执行
- **完成**: 任务执行成功
- **失败**: 任务执行失败

点击"查看"按钮可查看详细的执行日志。

## API 接口

### 配置管理

#### POST /api/harbor/config
保存 Harbor 配置
```json
{
  "harborUrl": "https://harbor.example.com",
  "project": "library",
  "username": "admin",
  "password": "password"
}
```

#### POST /api/harbor/verify
验证 Harbor 连接
```json
{
  "harborUrl": "https://harbor.example.com",
  "username": "admin",
  "password": "password"
}
```

#### GET /api/config
获取当前 Harbor 配置 (不返回密码)

### 镜像操作

#### POST /api/images/sync
创建镜像同步任务
```json
{
  "sourceImage": "docker.io/library/nginx:1.27",
  "targetRepo": "library/nginx",
  "targetTag": "1.27"
}
```

#### POST /api/images/upload
上传 tar 包并导入 Harbor
- Content-Type: `multipart/form-data`
- Fields:
  - `imageTar`: 文件
  - `importRepo`: 目标仓库
  - `importTag`: 目标标签

### 任务管理

#### GET /api/tasks
获取所有任务列表

#### DELETE /api/tasks/:id
删除指定任务

## 安全说明

1. **配置加密**: Harbor 凭据使用 AES 加密存储在 `config.json` 文件中
2. **密钥管理**: 默认密钥 `harbor-manager-secret-key-change-in-production`,生产环境请修改
3. **日志记录**: 所有操作都会记录到 `app.log` 文件
4. **文件清理**: tar 包上传后会自动删除临时文件

## 文件结构

```
ai-zcx/
├── app.js           # 前端逻辑
├── index.html       # 页面结构
├── styles.css       # 样式文件
├── server.js        # 后端服务器
├── package.json     # 项目配置
├── README.md        # 文档
├── config.json      # 加密的配置文件 (自动生成)
├── tasks.json       # 任务持久化文件 (自动生成)
├── app.log          # 日志文件 (自动生成)
├── uploads/         # 上传文件临时目录 (自动生成)
└── start.sh         # WSL 启动脚本
```

## 生产环境部署建议

1. **修改加密密钥**: 在 `server.js` 中修改 `SECRET_KEY`
2. **配置 HTTPS**: 使用反向代理 (如 Nginx) 提供 HTTPS 访问
3. **进程管理**: 使用 PM2 或 systemd 管理服务
4. **日志轮转**: 配置日志轮转避免日志文件过大
5. **资源限制**: 设置上传文件大小限制和并发任务数限制
6. **备份策略**: 定期备份 `config.json` 和 `tasks.json`

## 故障排查

### Docker 命令失败
- 确保 Docker 已安装并在 PATH 中
- 检查 Docker 守护进程是否运行
- 确认 Docker 有足够的权限

### Harbor 连接失败
- 检查 Harbor URL 是否正确
- 确认用户名和密码正确
- 检查网络连接和防火墙设置

### 文件上传失败
- 检查 `uploads` 目录是否有写权限
- 确认文件大小不超过限制 (默认 10GB)
- 检查磁盘空间是否充足

## 开发

```bash
# 安装依赖
npm install

# 启动开发服务器
npm start
```

## License

MIT
