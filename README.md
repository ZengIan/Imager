# Harbor 镜像上传管理系统

生产级别的 Harbor 镜像上传管理工具，支持公网镜像同步和本地镜像包导入。

## 功能特性

- ✅ **多仓库管理**: 支持配置多个 Harbor 仓库，可删除和验证
- ✅ **安全的凭据管理**: Harbor 配置加密存储，密码不外泄
- ✅ **实时任务监控**: 任务状态实时更新，支持查看详细日志
- ✅ **公网镜像同步**: 从 Docker Hub 等公网源同步镜像到 Harbor
- ✅ **本地镜像包导入**: 支持上传本地镜像 tar 包并导入 Harbor
- ✅ **任务重新执行**: 失败的任务可重新执行，成功任务置灰不可点击
- ✅ **任务持久化**: 任务状态和日志持久化存储
- ✅ **连接验证**: 使用 Docker Login 验证 Harbor 连接和认证

## 系统要求

- Node.js >= 18.0.0
- Docker (需要在系统 PATH 中)
- Harbor 私有镜像仓库 (v2.x 版本)

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

### WSL 环境（推荐）
```bash
bash start.sh
```

### 直接启动
```bash
npm start
```

服务器将启动在 `http://localhost:8080`

## 使用说明

### 1. 配置 Harbor 连接

在"仓库源配置"区域：
- **Harbor 名称**: 给仓库起个名字（如 `prod`、`dev`）
- **仓库地址**: Harbor 服务的完整 URL（如 `https://harbor.example.com`）
- **用户名**: Harbor 用户名
- **密码/Token**: Harbor 密码或访问令牌

填写后点击"验证连接"，验证通过后点击"保存配置"。

已保存的仓库会显示在下方，支持验证和删除操作。

### 2. 镜像同步

在"镜像同步"区域：
1. 填写源镜像地址（如 `docker.io/library/nginx:1.27`）
2. 选择目标仓库
3. 填写目标项目（如 `library`）
4. 点击"创建同步任务"

系统会自动执行：
- `docker pull` 拉取源镜像
- `docker tag` 标记目标镜像
- `docker login` 登录 Harbor
- `docker push` 推送到 Harbor

### 3. 本地镜像包上传

在"本地镜像包上传"区域：
1. 选择本地镜像 tar 包文件
2. 选择目标仓库
3. 填写导入目标项目（如 `library`）
4. 点击"上传并导入"

系统会自动执行：
- 上传 tar 包到服务器（同名文件不会重复上传）
- `docker load` 加载镜像
- `docker tag` 标记目标镜像
- `docker login` 登录 Harbor
- `docker push` 推送到 Harbor
- 导入成功后自动删除 tar 包（失败则保留，可重新执行）

### 4. 任务管理

在"任务列表"区域：
- **时间**: 任务创建时间
- **类型**: 镜像同步 / 本地导入
- **来源**: 源镜像或 tar 包名称
- **目标**: 目标 Harbor 地址
- **状态**: 待执行 / 执行中 / 完成 / 失败
- **操作**: 查看 / 重新执行 / 删除

**重新执行规则**：
- 失败状态（橘色按钮）：可点击重新执行
- 成功状态（灰色按钮）：不可点击
- 本地导入任务失败后保留 tar 包，可重新执行

点击"查看"按钮可查看详细的执行日志。

## 安全说明

1. **配置加密**: Harbor 凭据使用 AES 加密存储在 `config.json` 文件中
2. **密钥管理**: 默认密钥 `harbor-manager-secret-key-change-in-production`，生产环境请修改
3. **日志记录**: 所有操作都会记录到 `app.log` 文件
4. **文件清理**: tar 包上传成功后会自动删除，失败则保留以便重新执行

## 文件结构

```
ai-zcx/
├── app.js           # 前端逻辑
├── index.html       # 页面结构
├── styles.css       # 样式文件
├── server.js        # 后端服务器
├── package.json     # 项目配置
├── README.md        # 文档
├── start.sh         # WSL 启动脚本
├── config.json      # 加密的配置文件 (自动生成，不提交 Git)
├── tasks.json       # 任务持久化文件 (自动生成，不提交 Git)
├── app.log          # 日志文件 (自动生成，不提交 Git)
└── uploads/         # 上传文件临时目录 (自动生成，不提交 Git)
```

## 生产环境部署建议

1. **修改加密密钥**: 在 `server.js` 中修改 `SECRET_KEY`
2. **配置 HTTPS**: 使用反向代理（如 Nginx）提供 HTTPS 访问
3. **进程管理**: 使用 PM2 或 systemd 管理服务
4. **日志轮转**: 配置日志轮转避免日志文件过大
5. **资源限制**: 设置上传文件大小限制（默认 10GB）和并发任务数限制
6. **备份策略**: 定期备份 `config.json` 和 `tasks.json`

## 故障排查

### Docker 命令失败
- 确保 Docker 已安装并在 PATH 中
- 检查 Docker 守护进程是否运行
- 确认当前用户有 Docker 执行权限

### Harbor 连接失败
- 检查 Harbor URL 是否正确（需包含 https:// 或 http://）
- 确认用户名和密码正确
- 检查网络连接和防火墙设置
- 使用"验证连接"按钮测试

### 文件上传失败
- 检查 `uploads` 目录是否有写权限
- 确认文件大小不超过限制（默认 10GB）
- 检查磁盘空间是否充足

### 任务执行失败
- 点击"查看"按钮查看详细日志
- 检查 Docker 是否能正常登录 Harbor
- 确认 Harbor 项目是否存在
- 检查 Harbor 是否有足够的存储空间

## 开发

```bash
# 安装依赖
npm install

# 启动开发服务器
npm start
```

## License

MIT
