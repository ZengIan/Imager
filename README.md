# Imager 镜像游侠

一站式容器镜像与文件传输管理平台，支持 Harbor 私有仓库管理和 SFTP 文件传输。

## 功能特性

### 🐳 Harbor 镜像管理

- **多仓库管理**: 配置多个 Harbor 仓库，支持验证、删除操作
- **公网镜像同步**: 从 Docker Hub 等公网源同步镜像到 Harbor，支持多架构镜像
- **本地镜像导入**: 上传 tar 包自动导入到 Harbor，支持 OCI/Docker 格式
- **项目创建**: 直接在界面创建 Harbor 项目，支持私有/公开可见性
- **智能工具选择**: 自动检测 skopeo，优先使用 skopeo 提升传输效率

### 📁 SFTP 文件传输

- **配置管理**: 保存多个 SFTP 服务器配置，支持密码和密钥认证
- **多文件上传**: 支持多文件、文件夹批量上传，最大支持 30GB 单文件
- **断点续传**: 自动跳过已存在的文件，支持任务中断后恢复
- **SHA-256 校验**: 可选开启文件完整性校验，确保传输可靠
- **并发上传**: 最多 3 个文件并行传输，提升上传效率
- **文件管理**: 内置文件管理器，支持浏览目录、查看文件、删除文件
- **实时进度**: 上传进度、速度、状态实时显示
- **任务取消**: 随时取消正在进行的上传任务

### 🎯 通用特性

- **安全凭据**: Harbor/SFTP 凭据 AES 加密存储
- **任务持久化**: 任务状态自动保存，刷新页面不丢失
- **详细日志**: 每个任务都有完整执行日志，便于故障排查
- **连接验证**: 保存配置前可测试连接有效性

## 系统要求

- Node.js >= 18.0.0
- Docker 或 Skopeo（镜像同步功能需要）
- Rclone（SFTP 传输功能需要）

## 安装

```bash
git clone https://github.com/ZengIan/Imager.git
cd Imager
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

服务启动后访问 `http://localhost:8080`

## 使用指南

### Harbor 配置

1. 填写 Harbor 名称、地址、用户名、密码
2. 点击"验证连接"测试配置有效性
3. 验证通过后点击"保存配置"

### 镜像同步

1. 填写源镜像地址（如 `docker.io/library/nginx:1.27`）
2. 选择目标仓库和项目
3. 选择架构：多架构（保留所有架构）或系统自匹配
4. 点击"创建同步任务"

### 本地镜像包上传

1. 选择本地 tar 包文件
2. 选择目标仓库和项目
3. 点击"上传并导入"

### SFTP 文件上传

1. **配置 SFTP**: 填写服务器地址、端口、用户名、密码，测试连接后保存
2. **选择文件**: 点击"上传文件"或"上传文件夹"
3. **设置路径**: 选择 SFTP 配置，填写远程目标路径
4. **可选校验**: 勾选 SHA-256 校验确保文件完整性
5. **开始上传**: 点击"开始上传"，实时查看进度

### 文件管理

在已保存的 SFTP 配置中点击"文件管理"按钮，可以：
- 浏览远程目录
- 进入子目录、返回上级
- 删除文件或目录
- 刷新目录列表

## 技术架构

```
┌─────────────────────────────────────────────────────────┐
│                     前端 (HTML/CSS/JS)                   │
├─────────────────────────────────────────────────────────┤
│                      后端 (Node.js)                      │
├─────────────────┬─────────────────┬─────────────────────┤
│   Docker CLI    │    Skopeo       │      Rclone         │
│   (镜像导入)     │   (镜像同步)     │   (SFTP 传输)        │
└─────────────────┴─────────────────┴─────────────────────┘
```

## 文件结构

```
Imager/
├── app.js              # 前端交互逻辑
├── index.html          # 页面结构
├── styles.css          # 样式文件
├── server.js           # 后端服务器
├── rclone.js           # Rclone 封装模块
├── package.json        # 项目配置
├── start.sh            # WSL 启动脚本
├── Dockerfile          # Docker 构建文件
│
├── config.json         # Harbor 配置 (加密存储)
├── sftp-configs.json   # SFTP 配置 (加密存储)
├── tasks.json          # Harbor 任务记录
├── sftp-tasks.json     # SFTP 任务记录
├── app.log             # 运行日志
└── uploads/            # 上传临时目录
```

## 生产部署

### Docker 部署

```bash
docker build -t imager .
docker run -d -p 8080:8080 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v imager-data:/app/data \
  imager
```

### 安全建议

1. **修改密钥**: 在 `server.js` 中修改 `SECRET_KEY`
2. **配置 HTTPS**: 使用 Nginx 反向代理
3. **进程管理**: 使用 PM2 管理服务进程
4. **日志轮转**: 配置日志轮转避免文件过大

## API 接口

### Harbor 相关

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/config` | 获取仓库列表 |
| POST | `/api/harbor/config` | 保存仓库配置 |
| POST | `/api/harbor/verify` | 验证连接 |
| DELETE | `/api/harbor/config/:name` | 删除配置 |
| POST | `/api/images/sync` | 创建同步任务 |
| POST | `/api/images/upload` | 上传镜像包 |
| POST | `/api/harbor/project` | 创建项目 |

### SFTP 相关

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/sftp/configs` | 获取配置列表 |
| POST | `/api/sftp/config` | 保存配置 |
| POST | `/api/sftp/test` | 测试连接 |
| DELETE | `/api/sftp/config/:name` | 删除配置 |
| POST | `/api/sftp/upload` | 上传文件 |
| GET | `/api/sftp/upload-status/:id` | 查询上传状态 |
| POST | `/api/sftp/upload-cancel/:id` | 取消上传 |
| POST | `/api/sftp/list` | 列出远程目录 |
| POST | `/api/sftp/delete` | 删除远程文件 |

### 任务管理

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/tasks` | 获取任务列表 |
| DELETE | `/api/tasks/:id` | 删除任务 |
| POST | `/api/tasks/:id/retry` | 重试任务 |

## 故障排查

### Docker 命令失败
- 确保 Docker 已安装且运行
- 检查当前用户是否有 Docker 执行权限

### Skopeo 未找到
- 安装 Skopeo: `apt install skopeo` (Debian/Ubuntu)
- 不安装也可使用，会自动降级到 Docker 命令

### Rclone 未找到
- 安装 Rclone: `curl https://rclone.org/install.sh | sudo bash`
- SFTP 功能依赖 Rclone，必须安装

### SFTP 连接失败
- 检查服务器地址和端口是否正确
- 确认用户名密码或密钥有效
- 使用"测试连接"按钮验证

## License

MIT
