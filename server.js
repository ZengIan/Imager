// 设置 UTF-8 编码，解决 Windows 命令行中文乱码
process.env.CHARSET = 'UTF-8';
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { formidable } = require('formidable');
const CryptoJS = require('crypto-js');
const rclone = require('./rclone');

const PORT = process.env.PORT || 8080;
const ROOT = __dirname;
const CONFIG_FILE = path.join(ROOT, 'config.json');
const TASKS_FILE = path.join(ROOT, 'tasks.json');
const SFTP_TASKS_FILE = path.join(ROOT, 'sftp-tasks.json');
const UPLOAD_DIR = path.join(ROOT, 'uploads');

const SECRET_KEY = 'harbor-manager-secret-key-change-in-production';

let harborConfigs = [];
let tasks = [];
let sftpUploadTasks = new Map(); // SFTP 上传任务状态
let modelscopeTasks = new Map(); // ModelScope 下载任务状态

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = fs.readFileSync(CONFIG_FILE, 'utf8');
      const decrypted = CryptoJS.AES.decrypt(data, SECRET_KEY);
      harborConfigs = JSON.parse(decrypted.toString(CryptoJS.enc.Utf8)) || [];
    }
  } catch (error) {
    console.error('加载配置失败:', error.message);
    harborConfigs = [];
  }
}

function saveConfig() {
  try {
    const encrypted = CryptoJS.AES.encrypt(JSON.stringify(harborConfigs), SECRET_KEY);
    fs.writeFileSync(CONFIG_FILE, encrypted.toString(), 'utf8');
  } catch (error) {
    console.error('保存配置失败:', error.message);
  }
}

function loadTasks() {
  try {
    if (fs.existsSync(TASKS_FILE)) {
      tasks = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
    }
  } catch (error) {
    console.error('加载任务失败:', error.message);
    tasks = [];
  }
}

function saveTasks() {
  try {
    fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2));
  } catch (error) {
    console.error('保存任务失败:', error.message);
  }
}

function loadSftpTasks() {
  try {
    if (fs.existsSync(SFTP_TASKS_FILE)) {
      const data = JSON.parse(fs.readFileSync(SFTP_TASKS_FILE, 'utf8'));
      const allTasks = new Map(data);
      
      // 只加载未完成的任务（uploading 状态）
      sftpUploadTasks = new Map();
      for (const [id, task] of allTasks) {
        if (task.status === 'uploading') {
          // 解密密码
          if (task.config && task.config.password) {
            try {
              const decrypted = CryptoJS.AES.decrypt(task.config.password, SECRET_KEY);
              task.config.password = decrypted.toString(CryptoJS.enc.Utf8);
            } catch (e) {
              log('WARN', `解密任务密码失败: ${task.id}`);
            }
          }
          // 重置运行时状态
          task._uploadRunning = false;
          task._stopUploading = false;
          task.processedFiles = new Set();
          sftpUploadTasks.set(id, task);
        }
      }
      
      // 清理已完成/失败的任务记录
      if (sftpUploadTasks.size < allTasks.size) {
        const filteredData = Array.from(sftpUploadTasks.entries());
        fs.writeFileSync(SFTP_TASKS_FILE, JSON.stringify(filteredData, null, 2));
        log('INFO', `清理了 ${allTasks.size - sftpUploadTasks.size} 个已完成/失败的 SFTP 任务记录`);
      }
      
      log('INFO', `加载了 ${sftpUploadTasks.size} 个进行中的 SFTP 上传任务`);
    }
  } catch (error) {
    console.error('加载 SFTP 任务失败:', error.message);
    sftpUploadTasks = new Map();
  }
}

function saveSftpTasks() {
  try {
    // 创建数据副本，加密密码，过滤内部字段
    const data = Array.from(sftpUploadTasks.entries()).map(([id, task]) => {
      const taskCopy = JSON.parse(JSON.stringify(task));
      
      // 删除内部状态字段（不需要持久化）
      delete taskCopy._uploadRunning;
      delete taskCopy._stopUploading;
      delete taskCopy.processedFiles; // Set 无法正确序列化
      
      // 清理文件对象，只保留必要字段
      if (taskCopy.files && Array.isArray(taskCopy.files.files)) {
        taskCopy.files.files = taskCopy.files.files.map(f => ({
          originalFilename: f.originalFilename,
          filepath: f.filepath,
          size: f.size
        }));
      }
      
      // 加密密码
      if (taskCopy.config && taskCopy.config.password) {
        taskCopy.config.password = CryptoJS.AES.encrypt(taskCopy.config.password, SECRET_KEY).toString();
      }
      return [id, taskCopy];
    });
    fs.writeFileSync(SFTP_TASKS_FILE, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error('保存 SFTP 任务失败:', error.message);
  }
}

function log(level, message) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] [${level}] ${message}\n`;
  console.log(logMessage.trim());
  fs.appendFileSync(path.join(ROOT, 'app.log'), logMessage);
}

function sendJson(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 10 * 1024 * 1024) {
        reject(new Error('Body too large'));
      }
    });
    req.on('end', () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function updateTaskStatus(taskId, status, message = '') {
  const task = tasks.find(t => t.id === taskId);
  if (task) {
    task.status = status;
    task.message = message;
    task.updatedAt = new Date().toISOString();
    saveTasks();
    log('INFO', `任务 ${taskId} 状态更新: ${status} - ${message}`);
  }
}

function createTask(type, source, target, arch = 'all') {
  const task = {
    id: Date.now().toString(36),
    time: new Date().toLocaleString('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }),
    type,
    source,
    target,
    arch,
    status: '待执行',
    logs: []
  };
  tasks.unshift(task);
  saveTasks();
  return task;
}

function addTaskLog(taskId, message) {
  // 更新任务列表中的日志
  const task = tasks.find(t => t.id === taskId);
  if (task) {
    task.logs.push({
      time: new Date().toISOString(),
      message
    });
    saveTasks();
  }

  // 同时更新 SFTP 上传任务的日志（如果存在）
  const sftpTask = sftpUploadTasks.get(taskId);
  if (sftpTask) {
    const timestamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    sftpTask.logs = sftpTask.logs || [];
    sftpTask.logs.push(`[${timestamp}] ${message}`);
    // 最多保留100条日志
    if (sftpTask.logs.length > 100) {
      sftpTask.logs = sftpTask.logs.slice(-100);
    }
  }
}

async function verifyHarborConnection(harborUrl, username, password) {
  log('INFO', `开始验证 Harbor 连接: ${harborUrl}`);
  
  // 优先使用 skopeo 验证，如果不可用则回退到 docker login
  const hasSkopeo = await checkSkopeo();
  if (hasSkopeo) {
    return await trySkopeoLogin(harborUrl, username, password);
  }
  return await tryDockerLogin(harborUrl, username, password);
}

// 创建 Harbor 项目
async function createHarborProject(config, projectName, isPublic = false) {
  log('INFO', `开始创建 Harbor 项目: ${config.harborUrl}/${projectName} (${isPublic ? '公开' : '私有'})`);
  
  try {
    // 1. 先检查项目是否已存在
    const checkResult = await checkProjectExists(config, projectName);
    if (checkResult.exists) {
      return { success: false, error: `项目 "${projectName}" 已存在` };
    }
    
    // 2. 创建项目
    const createResult = await requestCreateProject(config, projectName, isPublic);
    if (createResult.success) {
      return { success: true };
    } else {
      return { success: false, error: createResult.error };
    }
  } catch (error) {
    log('ERROR', `创建项目异常: ${error.message}`);
    return { success: false, error: error.message };
  }
}

// 检查 Harbor 项目是否存在
async function checkProjectExists(config, projectName) {
  try {
    const url = new URL(config.harborUrl);
    const port = url.port || (url.protocol === 'https:' ? 443 : 80);
    
    const apiPath = `/api/v2.0/projects/${encodeURIComponent(projectName)}`;
    
    const options = {
      protocol: url.protocol,
      hostname: url.hostname,
      port: port,
      path: apiPath,
      method: 'HEAD',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${config.username}:${config.password}`).toString('base64')
      },
      rejectUnauthorized: false
    };
    
    const result = await requestWithRedirect(options, null);
    
    if (result.statusCode === 200) {
      return { exists: true };
    } else {
      return { exists: false };
    }
  } catch (error) {
    return { exists: false };
  }
}

// 执行 HTTP 请求并跟随重定向
function requestWithRedirect(options, postData = null, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    const makeRequest = (currentOptions, currentPostData, remainingRedirects) => {
      const protocol = currentOptions.port === 443 ? https : http;
      
      const req = protocol.request(currentOptions, (res) => {
        // 处理重定向
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && remainingRedirects > 0) {
          const redirectUrl = new URL(res.headers.location, `${currentOptions.protocol}//${currentOptions.hostname}:${currentOptions.port}`);
          const newOptions = {
            hostname: redirectUrl.hostname,
            port: redirectUrl.port || (redirectUrl.protocol === 'https:' ? 443 : 80),
            path: redirectUrl.pathname + redirectUrl.search,
            method: currentOptions.method,
            headers: currentOptions.headers,
            rejectUnauthorized: false
          };
          makeRequest(newOptions, currentPostData, remainingRedirects - 1);
          return;
        }
        
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          resolve({ statusCode: res.statusCode, data });
        });
      });
      
      req.on('error', (error) => {
        reject(error);
      });
      
      req.setTimeout(10000, () => {
        req.destroy();
        reject(new Error('请求超时'));
      });
      
      if (currentPostData) {
        req.write(currentPostData);
      }
      req.end();
    };
    
    makeRequest(options, postData, maxRedirects);
  });
}

// 请求创建 Harbor 项目
async function requestCreateProject(config, projectName, isPublic = false) {
  try {
    const url = new URL(config.harborUrl);
    const port = url.port || (url.protocol === 'https:' ? 443 : 80);
    
    const apiPath = '/api/v2.0/projects';
    
    const postData = JSON.stringify({
      project_name: projectName,
      metadata: {
        public: isPublic ? 'true' : 'false'
      }
    });
    
    const options = {
      protocol: url.protocol,
      hostname: url.hostname,
      port: port,
      path: apiPath,
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${config.username}:${config.password}`).toString('base64'),
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      },
      rejectUnauthorized: false
    };
    
    const result = await requestWithRedirect(options, postData);
    
    if (result.statusCode === 201) {
      return { success: true };
    } else if (result.statusCode === 409) {
      return { success: false, error: '项目已存在' };
    } else if (result.statusCode === 401 || result.statusCode === 403) {
      return { success: false, error: '权限不足，请检查用户权限' };
    } else {
      return { success: false, error: `创建失败 (HTTP ${result.statusCode})` };
    }
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// 使用 skopeo 验证 Harbor 连接
function trySkopeoLogin(harborUrl, username, password) {
  return new Promise((resolve) => {
    const url = new URL(harborUrl);
    const registry = url.host;
    
    // 使用 skopeo login 验证（skopeo login 不需要 docker:// 前缀）
    const command = `skopeo login --username ${username} --password ${password} --tls-verify=false ${registry}`;
    const commandMasked = `skopeo login --username ${username} --password *** --tls-verify=false ${registry}`;
    log('INFO', `执行 skopeo 登录验证: ${commandMasked}`);
    
    exec(command, { encoding: 'utf8', timeout: 10000 }, (error, stdout, stderr) => {
      if (error) {
        // 隐藏错误信息中的密码
        const errorMessage = error.message.replace(/--password\s+\S+/g, '--password ***');
        log('ERROR', `skopeo 登录失败: ${errorMessage}`);
        
        // 区分超时/网络错误和认证错误
        if (error.killed || error.signal === 'SIGTERM' || 
            errorMessage.includes('timeout') || errorMessage.includes('ETIMEDOUT') ||
            errorMessage.includes('No such host') || errorMessage.includes('connection refused') ||
            errorMessage.includes('i/o timeout')) {
          resolve({ success: false, error: '请求超时，请检查网络连接或 Harbor 地址是否正确' });
        } else if (errorMessage.includes('401') || errorMessage.includes('unauthorized') || 
                   errorMessage.includes('authentication') || errorMessage.includes('denied')) {
          resolve({ success: false, error: '认证失败，请检查用户名和密码' });
        } else {
          resolve({ success: false, error: '连接失败，请检查 Harbor 地址和网络' });
        }
      } else {
        log('INFO', 'skopeo 登录验证成功');
        resolve({ success: true });
      }
    });
  });
}

function requestHarborApi(harborUrl, username, password, apiPath) {
  return new Promise((resolve) => {
    const url = new URL(harborUrl);
    const port = url.port || (url.protocol === 'https:' ? 443 : 80);
    const protocol = url.protocol === 'https:' ? 'https' : 'http';
    
    log('INFO', `连接信息: ${protocol}://${url.hostname}:${port}${apiPath}`);
    
    const options = {
      hostname: url.hostname,
      port: port,
      path: apiPath,
      method: 'GET',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64')
      },
      rejectUnauthorized: false
    };

    const request = protocol === 'https' ? https.request : http.request;

    const req = request(options, (res) => {
      let data = '';
      log('INFO', `收到响应状态码: ${res.statusCode}`);
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        log('INFO', `响应数据长度: ${data.length}`);
        resolve({ statusCode: res.statusCode, data });
      });
    });

    req.on('error', (error) => {
      log('ERROR', `请求错误: ${error.message}`);
      resolve({ success: false, error: error.message });
    });

    req.setTimeout(5000, () => {
      req.destroy();
      resolve({ error: '连接超时' });
    });

    req.end();
  });
}

async function tryConnect(harborUrl, username, password, authCheckPath, systemInfoPath) {
  const authResult = await requestHarborApi(harborUrl, username, password, authCheckPath);
  if (authResult.error) {
    return { success: false, error: authResult.error };
  }

  if (authResult.statusCode === 401 || authResult.statusCode === 403) {
    log('WARN', `认证校验失败，状态码: ${authResult.statusCode}`);
    return { success: false, authFailed: true, error: '认证失败，请检查用户名和密码' };
  }

  if (authResult.statusCode !== 200) {
    return { success: false, error: `认证校验失败，HTTP ${authResult.statusCode}` };
  }

  log('INFO', '认证校验通过，开始获取 systeminfo');
  const systemInfoResult = await requestHarborApi(harborUrl, username, password, systemInfoPath);
  if (systemInfoResult.error) {
    return { success: false, error: systemInfoResult.error };
  }

  if (systemInfoResult.statusCode !== 200) {
    return { success: false, error: `systeminfo 请求失败，HTTP ${systemInfoResult.statusCode}` };
  }

  try {
    const info = JSON.parse(systemInfoResult.data);
    const version = info.harbor_version || info.version || 'unknown';
    log('INFO', `Harbor 验证成功，版本: ${version}`);
    return { success: true, version };
  } catch {
    log('WARN', 'systeminfo 响应不是有效 JSON，使用认证结果判定成功');
    return { success: true, version: 'unknown' };
  }
}

// 检查 skopeo 是否可用
function checkSkopeo() {
  return new Promise((resolve) => {
    exec('which skopeo || echo "not found"', { encoding: 'utf8' }, (error, stdout) => {
      resolve(!error && stdout.trim() !== 'not found');
    });
  });
}

async function tryDockerLogin(harborUrl, username, password) {
  return new Promise((resolve) => {
    const url = new URL(harborUrl);
    const registry = url.host;

    const command = `docker login -u ${username} -p ${password} ${registry}`;
    const commandMasked = `docker login -u ${username} -p *** ${registry}`;
    log('INFO', `执行 Docker 登录验证: ${commandMasked}`);

    exec(command, { encoding: 'utf8', timeout: 10000 }, (error, stdout, stderr) => {
      if (error) {
        // 隐藏错误信息中的密码
        const errorMessage = error.message.replace(/-p\s+\S+/g, '-p ***');
        log('ERROR', `Docker 登录失败: ${errorMessage}`);
        
        // 区分超时/网络错误和认证错误
        if (error.killed || error.signal === 'SIGTERM' || 
            errorMessage.includes('timeout') || errorMessage.includes('ETIMEDOUT') ||
            errorMessage.includes('No such host') || errorMessage.includes('connection refused') ||
            errorMessage.includes('i/o timeout') || errorMessage.includes('Cannot connect')) {
          resolve({ success: false, error: '请求超时，请检查网络连接或 Harbor 地址是否正确' });
        } else if (errorMessage.includes('401') || errorMessage.includes('unauthorized') || 
                   errorMessage.includes('authentication') || errorMessage.includes('denied')) {
          resolve({ success: false, error: '认证失败，请检查用户名和密码' });
        } else {
          resolve({ success: false, error: '连接失败，请检查 Harbor 地址和网络' });
        }
      } else {
        log('INFO', 'Docker 登录验证成功');
        resolve({ success: true });
      }
    });
  });
}

function executeCommand(command, taskId, hidePassword = false) {
  return new Promise((resolve, reject) => {
    // 隐藏密码：支持 -p password 和 --dest-creds username:password 格式
    let displayCommand = command;
    if (hidePassword) {
      displayCommand = command.replace(/-p\s+\S+/g, '-p ***');
    }
    // 始终隐藏 --dest-creds 中的密码
    displayCommand = displayCommand.replace(/--dest-creds\s+([^:]+):(\S+)/g, '--dest-creds $1:***');
    log('INFO', `执行命令: ${displayCommand}`);
    addTaskLog(taskId, `执行: ${displayCommand}`);

    exec(command, { encoding: 'utf8' }, (error, stdout, stderr) => {
      if (stdout) {
        stdout.trim().split('\n').forEach(line => {
          if (line) addTaskLog(taskId, line);
        });
      }
      if (stderr) {
        stderr.trim().split('\n').forEach(line => {
          if (line) addTaskLog(taskId, `错误: ${line}`);
        });
      }
      if (error) {
        // 隐藏错误信息中的密码
        let errorMessage = error.message;
        if (hidePassword) {
          errorMessage = errorMessage.replace(/-p\s+\S+/g, '-p ***');
        }
        errorMessage = errorMessage.replace(/--dest-creds\s+([^:]+):(\S+)/g, '--dest-creds $1:***');
        log('ERROR', `命令执行失败: ${errorMessage}`);
        reject(error);
      } else {
        resolve(stdout);
      }
    });
  });
}

async function syncImage(taskId, sourceImage, targetProject, harborConfig, arch = 'all') {
  try {
    updateTaskStatus(taskId, '执行中', '开始镜像同步');

    const imageParts = sourceImage.split(':');
    const imageWithoutTag = imageParts[0];
    const tag = imageParts.length > 1 ? imageParts[1] : 'latest';
    const targetImage = `${harborConfig.harborUrl.replace(/^https?:\/\//, '')}/${targetProject}/${imageWithoutTag.split('/').pop()}:${tag}`;

    // 检查 skopeo 是否可用
    const hasSkopeo = await checkSkopeo();

    if (hasSkopeo) {
      // 使用 skopeo 直接复制镜像
      updateTaskStatus(taskId, '执行中', `使用 skopeo 同步镜像 (架构: ${arch})`);
      // skopeo --multi-arch 支持 'all', 'system', 'index-only'
      // all: 复制所有架构, system: 复制系统当前架构
      const archOption = arch === 'all' ? '--multi-arch=all' : '--multi-arch=system';
      const skopeoCmd = `skopeo copy ${archOption} docker://${sourceImage} docker://${targetImage} --dest-creds ${harborConfig.username}:${harborConfig.password} --src-tls-verify=false --dest-tls-verify=false`;
      await executeCommand(skopeoCmd, taskId);
    } else {
      // 降级使用 docker 命令
      log('WARN', 'skopeo 未安装，降级使用 docker 命令');
      addTaskLog(taskId, '警告: skopeo 未安装，使用 docker 命令');

      updateTaskStatus(taskId, '执行中', '拉取源镜像');
      await executeCommand(`docker pull ${sourceImage}`, taskId);

      updateTaskStatus(taskId, '执行中', '标记目标镜像');
      await executeCommand(`docker tag ${sourceImage} ${targetImage}`, taskId);

      updateTaskStatus(taskId, '执行中', '登录到 Harbor');
      const loginCmd = `docker login -u ${harborConfig.username} -p ${harborConfig.password} ${harborConfig.harborUrl.replace(/^https?:\/\//, '')}`;
      await executeCommand(loginCmd, taskId, true);

      updateTaskStatus(taskId, '执行中', '推送到 Harbor');
      await executeCommand(`docker push ${targetImage}`, taskId);
    }

    updateTaskStatus(taskId, '完成', '镜像同步成功');
    addTaskLog(taskId, '✅ 镜像同步成功完成');
    log('INFO', `镜像同步任务成功完成: ${taskId}`);
  } catch (error) {
    // 隐藏错误信息中的密码
    let errorMessage = error.message;
    errorMessage = errorMessage.replace(/-p\s+\S+/g, '-p ***');
    errorMessage = errorMessage.replace(/--dest-creds\s+([^:]+):(\S+)/g, '--dest-creds $1:***');
    updateTaskStatus(taskId, '失败', errorMessage);
    addTaskLog(taskId, `❌ 镜像同步失败: ${errorMessage}`);
  }
}

// 检测 tar 包格式并解析镜像信息
// 返回: { format: 'oci' | 'docker', images: string[] }
async function detectTarFormatAndImages(tarPath) {
  return new Promise((resolve) => {
    const extractDir = path.join(path.dirname(tarPath), 'temp_' + Date.now());
    fs.mkdirSync(extractDir, { recursive: true });
    
    // 尝试解压 index.json（OCI 格式）
    exec(`tar -xf "${tarPath}" -C "${extractDir}" index.json 2>/dev/null`, async (error) => {
      if (!error && fs.existsSync(path.join(extractDir, 'index.json'))) {
        // OCI 格式（多架构）
        try {
          const indexPath = path.join(extractDir, 'index.json');
          const content = fs.readFileSync(indexPath, 'utf8');
          const index = JSON.parse(content);
          fs.rmSync(extractDir, { recursive: true, force: true });
          
          // 从 OCI index.json 提取镜像标签
          const images = [];
          if (index.manifests && Array.isArray(index.manifests)) {
            // 尝试从 annotations 获取 tag
            const tags = new Set();
            for (const manifest of index.manifests) {
              if (manifest.annotations) {
                const refName = manifest.annotations['org.opencontainers.image.ref.name'] ||
                               manifest.annotations['io.containerd.image.name'];
                if (refName) {
                  tags.add(refName);
                }
              }
            }
            // 如果没有 annotations，检查是否有引用名
            if (tags.size === 0) {
              // 尝试读取 oci-layout 或其他元数据
              for (const manifest of index.manifests) {
                if (manifest.annotations && manifest.annotations['org.opencontainers.image.base.name']) {
                  tags.add(manifest.annotations['org.opencontainers.image.base.name']);
                }
              }
            }
            images.push(...Array.from(tags));
          }
          
          resolve({ format: 'oci', images });
        } catch (e) {
          fs.rmSync(extractDir, { recursive: true, force: true });
          resolve({ format: 'oci', images: [] });
        }
        return;
      }
      
      // 尝试解压 manifest.json（Docker 格式）
      exec(`tar -xf "${tarPath}" -C "${extractDir}" manifest.json 2>/dev/null`, (error2) => {
        if (!error2 && fs.existsSync(path.join(extractDir, 'manifest.json'))) {
          try {
            const manifestPath = path.join(extractDir, 'manifest.json');
            const content = fs.readFileSync(manifestPath, 'utf8');
            const manifest = JSON.parse(content);
            fs.rmSync(extractDir, { recursive: true, force: true });
            // Docker 格式需要从 manifest 获取镜像名
            const images = manifest.map(item => item.RepoTags || []).flat().filter(tag => tag);
            resolve({ format: 'docker', images });
          } catch (e) {
            fs.rmSync(extractDir, { recursive: true, force: true });
            resolve({ format: 'docker', images: [] });
          }
          return;
        }
        
        // 都不是，返回未知格式
        fs.rmSync(extractDir, { recursive: true, force: true });
        resolve({ format: 'unknown', images: [] });
      });
    });
  });
}

// 从 OCI 格式 tar 包中提取镜像信息
// 返回: [{ name: 'imager', tag: 'v1.0-rc02', fullRef: 'docker.io/zengian/imager:v1.0-rc02' }]
async function extractOciImageTags(tarPath) {
  return new Promise((resolve) => {
    const extractDir = path.join(path.dirname(tarPath), 'temp_tags_' + Date.now());
    fs.mkdirSync(extractDir, { recursive: true });
    
    exec(`tar -xf "${tarPath}" -C "${extractDir}" index.json 2>/dev/null`, (error) => {
      if (error || !fs.existsSync(path.join(extractDir, 'index.json'))) {
        fs.rmSync(extractDir, { recursive: true, force: true });
        resolve([]);
        return;
      }
      
      try {
        const indexPath = path.join(extractDir, 'index.json');
        const content = fs.readFileSync(indexPath, 'utf8');
        const index = JSON.parse(content);
        
        const images = [];
        if (index.manifests && Array.isArray(index.manifests)) {
          for (const manifest of index.manifests) {
            if (manifest.annotations) {
              // 优先使用 io.containerd.image.name（包含完整镜像引用）
              const fullRef = manifest.annotations['io.containerd.image.name'];
              const refName = manifest.annotations['org.opencontainers.image.ref.name'];
              
              if (fullRef) {
                // 完整镜像引用格式: docker.io/zengian/imager:v1.0-rc02 或 imager:v1.0-rc02
                const parts = fullRef.split(':');
                const tag = parts.length > 1 ? parts.pop() : 'latest';
                const repoPath = parts.join(':');
                // 提取镜像名（最后一部分）
                const name = repoPath.split('/').pop();
                images.push({ name, tag, fullRef });
              } else if (refName) {
                // 只有标签，需要后续用文件名补充镜像名
                images.push({ name: null, tag: refName, fullRef: refName });
              }
            }
          }
        }
        
        fs.rmSync(extractDir, { recursive: true, force: true });
        resolve(images);
      } catch (e) {
        fs.rmSync(extractDir, { recursive: true, force: true });
        resolve([]);
      }
    });
  });
}

// 使用 skopeo inspect 获取 tar 包中的镜像列表
async function inspectTarImages(tarPath, format) {
  return new Promise((resolve) => {
    const sourceType = format === 'oci' ? 'oci-archive' : 'docker-archive';
    exec(`skopeo inspect --raw ${sourceType}:${tarPath} 2>/dev/null`, (error, stdout) => {
      if (error) {
        resolve([]);
        return;
      }
      try {
        const data = JSON.parse(stdout);
        // 对于 index，尝试获取引用名
        if (data.manifests) {
          const images = [];
          for (const m of data.manifests) {
            if (m.annotations && m.annotations['org.opencontainers.image.ref.name']) {
              images.push(m.annotations['org.opencontainers.image.ref.name']);
            }
          }
          resolve(images);
        } else {
          resolve([]);
        }
      } catch (e) {
        resolve([]);
      }
    });
  });
}

async function loadAndPushTar(taskId, tarPath, targetProject, harborConfig, arch = 'all') {
  try {
    const tarFileName = path.basename(tarPath);
    log('INFO', `镜像导入任务开始: ${taskId}, tar文件: ${tarFileName}`);
    addTaskLog(taskId, `本地导入开始，文件: ${tarFileName}`);

    // 检测 tar 包格式
    addTaskLog(taskId, '正在检测 tar 包格式...');
    const { format, images } = await detectTarFormatAndImages(tarPath);
    
    // 目标镜像名（从文件名推导）
    const defaultImageName = path.basename(tarPath).replace(/\.tar(\.gz)?$/, '');
    
    // 检查 skopeo 是否可用
    const hasSkopeo = await checkSkopeo();

    if (hasSkopeo) {
      const archOption = arch === 'all' ? '--multi-arch=all' : '--multi-arch=system';
      const harborHost = harborConfig.harborUrl.replace(/^https?:\/\//, '');
      
      if (format === 'oci') {
        // OCI 格式：使用 oci-archive，提取镜像标签
        addTaskLog(taskId, `检测到 OCI 多架构格式`);
        log('INFO', `tar 包格式: OCI`);
        
        // 尝试提取 OCI 镜像标签
        const ociImages = await extractOciImageTags(tarPath);
        
        if (ociImages.length > 0) {
          // 有明确的镜像信息，逐个推送
          addTaskLog(taskId, `检测到 ${ociImages.length} 个镜像:`);
          for (const img of ociImages) {
            addTaskLog(taskId, `  - ${img.fullRef}`);
          }
          
          const pushedImages = []; // 记录成功推送的镜像
          
          for (let i = 0; i < ociImages.length; i++) {
            const imgInfo = ociImages[i];
            // 优先使用提取的镜像名，否则使用文件名
            const imageRepo = imgInfo.name || defaultImageName;
            const imageTag = imgInfo.tag || 'latest';
            const targetImage = `${harborHost}/${targetProject}/${imageRepo}:${imageTag}`;
            
            addTaskLog(taskId, `[${i + 1}/${ociImages.length}] 推送 -> ${targetImage}`);
            
            // 对于多镜像 OCI 归档，需要指定镜像引用（使用 tag）
            // 格式: oci-archive:tarfile:image-ref
            const imageRef = imgInfo.tag;
            const skopeoCmd = `skopeo copy ${archOption} oci-archive:${tarPath}:${imageRef} docker://${targetImage} --dest-creds ${harborConfig.username}:${harborConfig.password} --dest-tls-verify=false`;
            await executeCommand(skopeoCmd, taskId);
            pushedImages.push(targetImage);
            
            // 每个镜像推送成功后立即输出日志
            addTaskLog(taskId, `✅ ${targetImage} 镜像导入成功`);
          }
          
          // 显示完整的推送结果
          const message = pushedImages.length === 1 
            ? pushedImages[0]
            : `镜像导入成功，共 ${pushedImages.length} 个镜像`;
          updateTaskStatus(taskId, '完成', message);
          log('INFO', `镜像导入任务成功完成: ${taskId}, 共 ${pushedImages.length} 个镜像`);
        } else {
          // 无明确 tag，使用文件名
          const targetImage = `${harborHost}/${targetProject}/${defaultImageName}:latest`;
          addTaskLog(taskId, `推送镜像 -> ${targetImage}`);
          
          const skopeoCmd = `skopeo copy ${archOption} oci-archive:${tarPath} docker://${targetImage} --dest-creds ${harborConfig.username}:${harborConfig.password} --dest-tls-verify=false`;
          await executeCommand(skopeoCmd, taskId);
          
          updateTaskStatus(taskId, '完成', `镜像导入成功: ${targetImage}`);
          addTaskLog(taskId, `✅ 镜像导入成功完成: ${targetImage}`);
          log('INFO', `镜像导入任务成功完成: ${taskId}, 目标: ${targetImage}`);
        }
        
      } else if (format === 'docker' && images.length > 0) {
        // Docker 格式：使用 docker-archive，需要指定镜像名
        addTaskLog(taskId, `检测到 Docker 格式，共 ${images.length} 个镜像:`);
        for (const img of images) {
          addTaskLog(taskId, `  - ${img}`);
        }
        log('INFO', `tar 包格式: Docker, 镜像: ${images.join(', ')}`);
        
        const pushedImages = []; // 记录成功推送的镜像
        
        for (let i = 0; i < images.length; i++) {
          const imageName = images[i];
          const imageTag = imageName.split(':').pop() || 'latest';
          const imageRepo = imageName.split(':')[0].split('/').pop();
          const targetImage = `${harborHost}/${targetProject}/${imageRepo}:${imageTag}`;
          
          addTaskLog(taskId, `[${i + 1}/${images.length}] 推送 -> ${targetImage}`);
          
          const skopeoCmd = `skopeo copy ${archOption} docker-archive:${tarPath}:${imageName} docker://${targetImage} --dest-creds ${harborConfig.username}:${harborConfig.password} --dest-tls-verify=false`;
          await executeCommand(skopeoCmd, taskId);
          pushedImages.push(targetImage);
          
          // 每个镜像推送成功后立即输出日志
          addTaskLog(taskId, `✅ ${targetImage} 镜像导入成功`);
        }
        
        // Docker 格式成功消息
        const message = pushedImages.length === 1 
          ? pushedImages[0]
          : `镜像导入成功，共 ${pushedImages.length} 个镜像`;
        updateTaskStatus(taskId, '完成', message);
        log('INFO', `镜像导入任务成功完成: ${taskId}, 共 ${pushedImages.length} 个镜像`);
        
      } else {
        // 未知格式或无镜像名：尝试两种方式
        addTaskLog(taskId, `未检测到明确格式，尝试 OCI 格式推送`);
        log('INFO', `tar 包格式: 未知，尝试作为 OCI`);
        
        const targetImage = `${harborHost}/${targetProject}/${defaultImageName}:latest`;
        
        // 先尝试 OCI 格式
        const skopeoCmdOci = `skopeo copy ${archOption} oci-archive:${tarPath} docker://${targetImage} --dest-creds ${harborConfig.username}:${harborConfig.password} --dest-tls-verify=false`;
        try {
          await executeCommand(skopeoCmdOci, taskId);
          updateTaskStatus(taskId, '完成', `镜像导入成功: ${targetImage}`);
          addTaskLog(taskId, `✅ 镜像导入成功完成: ${targetImage}`);
          log('INFO', `镜像导入任务成功完成: ${taskId}, 目标: ${targetImage}`);
        } catch (e) {
          // OCI 失败，尝试 Docker 格式
          addTaskLog(taskId, `OCI 格式失败，尝试 Docker 格式`);
          const skopeoCmdDocker = `skopeo copy ${archOption} docker-archive:${tarPath} docker://${targetImage} --dest-creds ${harborConfig.username}:${harborConfig.password} --dest-tls-verify=false`;
          await executeCommand(skopeoCmdDocker, taskId);
          updateTaskStatus(taskId, '完成', `镜像导入成功: ${targetImage}`);
          addTaskLog(taskId, `✅ 镜像导入成功完成: ${targetImage}`);
          log('INFO', `镜像导入任务成功完成: ${taskId}, 目标: ${targetImage}`);
        }
      }
      return; // skopeo 处理完成，直接返回
    } else {
      // 降级使用 docker 命令
      log('WARN', 'skopeo 未安装，降级使用 docker 命令');
      addTaskLog(taskId, '警告: skopeo 未安装，使用 docker 命令');

      updateTaskStatus(taskId, '执行中', '加载本地镜像包');
      log('INFO', `执行 docker load -i ${tarFileName}`);
      addTaskLog(taskId, `准备执行: docker load -i ${tarFileName}`);
      
      // docker load 会输出加载的镜像名
      const loadResult = await executeCommand(`docker load -i ${tarPath}`, taskId);
      
      // 如果 images 为空，从 docker load 输出解析镜像名
      let loadedImages = images;
      if (loadedImages.length === 0) {
        // 解析 docker load 输出，格式: "Loaded image: xxx" 或 "Loaded image ID: sha256:xxx"
        const loadedMatch = loadResult.match(/Loaded image:\s*(.+)/g);
        if (loadedMatch) {
          loadedImages = loadedMatch.map(m => m.replace('Loaded image: ', '').trim());
        } else {
          // 使用默认镜像名
          loadedImages = [defaultImageName + ':latest'];
        }
        addTaskLog(taskId, `检测到 ${loadedImages.length} 个镜像: ${loadedImages.join(', ')}`);
      }

      updateTaskStatus(taskId, '执行中', '登录 Harbor 仓库');
      const harborHost = harborConfig.harborUrl.replace(/^https?:\/\//, '');
      await executeCommand(`docker login -u ${harborConfig.username} -p ${harborConfig.password} ${harborHost}`, taskId, true);

      // 逐个标记并推送每个镜像
      for (let i = 0; i < loadedImages.length; i++) {
        const imageName = loadedImages[i];
        const imageTag = imageName.split(':').pop() || 'latest';
        const imageRepo = imageName.split(':')[0].split('/').pop();
        const targetImage = `${harborHost}/${targetProject}/${imageRepo}:${imageTag}`;
        
        addTaskLog(taskId, `[${i + 1}/${loadedImages.length}] 标记并推送: ${imageName} -> ${targetImage}`);
        
        updateTaskStatus(taskId, '执行中', `推送镜像 ${i + 1}/${loadedImages.length}`);
        await executeCommand(`docker tag ${imageName} ${targetImage}`, taskId);
        await executeCommand(`docker push ${targetImage}`, taskId);
      }
      
      // Docker 分支成功消息
      updateTaskStatus(taskId, '完成', `镜像导入成功，共 ${loadedImages.length} 个镜像`);
      addTaskLog(taskId, `✅ 镜像导入成功完成，共 ${loadedImages.length} 个镜像`);
      log('INFO', `镜像导入任务成功完成: ${taskId}, 共 ${loadedImages.length} 个镜像`);
    }
  } catch (error) {
    // 隐藏错误信息中的密码
    let errorMessage = error.message;
    errorMessage = errorMessage.replace(/-p\s+\S+/g, '-p ***');
    errorMessage = errorMessage.replace(/--dest-creds\s+([^:]+):(\S+)/g, '--dest-creds $1:***');
    log('ERROR', `镜像导入任务失败: ${taskId}, 错误: ${errorMessage}`);
    addTaskLog(taskId, `❌ 本地导入失败: ${errorMessage}`);
    addTaskLog(taskId, 'tar 包已保留，可重新执行任务');
    updateTaskStatus(taskId, '失败', errorMessage);
  }
}

// 检测tar包格式
function detectTarFormat(tarPath) {
  try {
    // 读取tar包的前几个字节来检测格式
    const buffer = fs.readFileSync(tarPath, { length: 1024 });
    const content = buffer.toString('utf8', 0, 1024);
    
    // OCI格式检查：查找oci-layout或manifest.json
    if (content.includes('oci-layout') || content.includes('application/vnd.oci')) {
      return 'oci';
    }
    
    // Docker格式检查：查找manifest.json或repositories
    if (content.includes('manifest.json') || content.includes('repositories')) {
      return 'docker-archive';
    }
    
    // 默认使用docker-archive（兼容docker save格式）
    return 'docker-archive';
  } catch (error) {
    log('ERROR', `检测tar包格式失败: ${error.message}`);
    return 'docker-archive';
  }
}

// 使用skopeo上传镜像
async function loadAndPushTarWithSkopeo(taskId, tarPath, targetProject, harborConfig) {
  try {
    const tarFileName = path.basename(tarPath);
    log('INFO', `镜像导入任务开始(Skopeo): ${taskId}, tar文件: ${tarFileName}`);
    addTaskLog(taskId, `本地导入开始(Skopeo)，文件: ${tarFileName}`);

    updateTaskStatus(taskId, '执行中', '检测tar包格式');
    const format = detectTarFormat(tarPath);
    log('INFO', `检测到tar包格式: ${format}`);
    addTaskLog(taskId, `检测到格式: ${format === 'oci' ? 'OCI多架构' : 'Docker单架构'}`);

    updateTaskStatus(taskId, '执行中', '使用Skopeo复制镜像');
    
    const imageName = path.basename(tarPath).replace(/\.tar(\.gz)?$/, '');
    const targetImage = `${harborConfig.harborUrl.replace(/^https?:\/\//, '')}/${targetProject}/${imageName}:latest`;
    const harborHost = harborConfig.harborUrl.replace(/^https?:\/\//, '');
    
    // 构建skopeo命令
    const skopeoCmd = `skopeo copy ${format}:${tarPath} docker://${targetImage} \
      --dest-creds=${harborConfig.username}:${harborConfig.password} \
      --dest-tls-verify=false \
      ${format === 'oci' ? '--multi-arch=all' : ''}`;
    
    await executeCommand(skopeoCmd, taskId);

    updateTaskStatus(taskId, '完成', '镜像导入成功');
    addTaskLog(taskId, '✅ 镜像导入成功完成(Skopeo)');
    log('INFO', `镜像导入任务成功完成(Skopeo): ${taskId}`);
  } catch (error) {
    log('ERROR', `镜像导入任务失败(Skopeo): ${taskId}, 错误: ${error.message}`);
    addTaskLog(taskId, `本地导入失败(Skopeo): ${error.message}`);
    addTaskLog(taskId, 'tar 包已保留，可重新执行任务');
    updateTaskStatus(taskId, '失败', error.message);
  }
}

function serveFile(req, res, pathname) {
  const safePath = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.join(ROOT, safePath);

  if (!filePath.startsWith(ROOT)) {
    sendJson(res, 403, { error: 'Forbidden' });
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      sendJson(res, 404, { error: 'Not found' });
      return;
    }

    const ext = path.extname(filePath);
    const map = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8'
    };

    res.writeHead(200, { 'Content-Type': map[ext] || 'text/plain; charset=utf-8' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  try {
    if (req.method === 'GET' && pathname === '/api/tasks') {
      sendJson(res, 200, { tasks: tasks.map(t => ({
        ...t,
        logs: t.logs
      })) });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/config') {
      sendJson(res, 200, { repos: harborConfigs.map(c => ({
        name: c.name,
        harborUrl: c.harborUrl,
        username: c.username
      })) });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/logs') {
      try {
        const LOG_FILE = path.join(ROOT, 'app.log');
        let logs = [];
        if (fs.existsSync(LOG_FILE)) {
          const content = fs.readFileSync(LOG_FILE, 'utf8');
          logs = content.trim().split('\n').filter(line => line.trim());
        }
        sendJson(res, 200, { logs });
      } catch (error) {
        sendJson(res, 500, { error: '读取日志失败' });
      }
      return;
    }

    if (req.method === 'POST' && pathname === '/api/harbor/config') {
      const body = await parseJsonBody(req);
      const { name, harborUrl, username, password } = body;
      if (!name || !harborUrl || !username || !password) {
        sendJson(res, 400, { error: '缺少必填字段' });
        return;
      }

      const existingIndex = harborConfigs.findIndex(c => c.name === name);
      const newConfig = { name, harborUrl, username, password };
      
      if (existingIndex >= 0) {
        harborConfigs[existingIndex] = newConfig;
      } else {
        harborConfigs.push(newConfig);
      }
      
      saveConfig();
      log('INFO', `保存 Harbor 配置: ${name} - ${harborUrl}`);
      sendJson(res, 200, { message: '配置已保存', harbor: name });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/harbor/verify') {
      const body = await parseJsonBody(req);
      const { harborUrl, username, password } = body;
      if (!harborUrl || !username || !password) {
        sendJson(res, 400, { error: '缺少必填字段' });
        return;
      }

      const result = await verifyHarborConnection(harborUrl, username, password);
      if (result.success) {
        sendJson(res, 200, { success: true, version: result.version });
      } else {
        log('ERROR', `Harbor 连接验证失败: ${result.error}`);
        sendJson(res, 400, { success: false, error: result.error });
      }
      return;
    }

    if (req.method === 'POST' && pathname === '/api/harbor/verify-saved') {
      const body = await parseJsonBody(req);
      const { name } = body;
      if (!name) {
        sendJson(res, 400, { error: '缺少仓库名称' });
        return;
      }

      const config = harborConfigs.find(c => c.name === name);
      if (!config) {
        sendJson(res, 404, { error: '未找到该仓库配置' });
        return;
      }

      const result = await verifyHarborConnection(config.harborUrl, config.username, config.password);
      if (result.success) {
        sendJson(res, 200, { success: true, version: result.version });
      } else {
        log('ERROR', `Harbor 连接验证失败: ${config.name} - ${result.error}`);
        sendJson(res, 400, { success: false, error: result.error });
      }
      return;
    }

    if (req.method === 'POST' && pathname === '/api/harbor/project') {
      const body = await parseJsonBody(req);
      const { repoName, projectName, isPublic } = body;
      
      if (!repoName || !projectName) {
        sendJson(res, 400, { error: '缺少仓库名称或项目名称' });
        return;
      }

      const config = harborConfigs.find(c => c.name === repoName);
      if (!config) {
        sendJson(res, 404, { error: '未找到该仓库配置' });
        return;
      }

      try {
        const result = await createHarborProject(config, projectName, isPublic);
        if (result.success) {
          log('INFO', `创建 Harbor 项目成功: ${config.harborUrl}/${projectName} (${isPublic ? '公开' : '私有'})`);
          sendJson(res, 200, { success: true, message: '项目创建成功' });
        } else {
          log('ERROR', `创建 Harbor 项目失败: ${result.error}`);
          sendJson(res, 400, { error: result.error });
        }
      } catch (error) {
        log('ERROR', `创建 Harbor 项目异常: ${error.message}`);
        sendJson(res, 500, { error: error.message });
      }
      return;
    }

    if (req.method === 'POST' && pathname === '/api/images/sync') {
      if (harborConfigs.length === 0) {
        sendJson(res, 400, { error: '请先配置 Harbor 连接' });
        return;
      }

      const body = await parseJsonBody(req);
      const { sourceImage, targetRepo, targetProject, arch } = body;
      if (!sourceImage || !targetRepo || !targetProject) {
        sendJson(res, 400, { error: '缺少必填字段' });
        return;
      }

      const harborConfig = harborConfigs.find(c => c.name === targetRepo);
      if (!harborConfig) {
        sendJson(res, 400, { error: '未找到指定的仓库配置' });
        return;
      }

      const imageParts = sourceImage.split(':');
      const imageWithoutTag = imageParts[0];
      const tag = imageParts.length > 1 ? imageParts[1] : 'latest';
      const target = `${harborConfig.harborUrl.replace(/^https?:\/\//, '')}/${targetProject}/${imageWithoutTag.split('/').pop()}:${tag}`;
      const task = createTask('镜像同步', sourceImage, target, arch || 'all');

      setImmediate(() => syncImage(task.id, sourceImage, targetProject, harborConfig, arch || 'all'));

      sendJson(res, 200, { task });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/images/upload') {
      if (harborConfigs.length === 0) {
        sendJson(res, 400, { error: '请先配置 Harbor 连接' });
        return;
      }

      if (!fs.existsSync(UPLOAD_DIR)) {
        fs.mkdirSync(UPLOAD_DIR, { recursive: true });
      }

      const form = formidable({
        uploadDir: UPLOAD_DIR,
        keepExtensions: true,
        maxFileSize: 30 * 1024 * 1024 * 1024, // 30GB
        maxFieldsSize: 10 * 1024 * 1024, // 10MB for form fields
        filename: (name, ext, part, form) => {
          // 保留原始文件名
          return part.originalFilename;
        }
      });

      form.parse(req, (err, fields, files) => {
        if (err) {
          log('ERROR', `文件上传失败: ${err.message}`);
          sendJson(res, 400, { error: '文件上传失败: ' + err.message });
          return;
        }

        const fileField = files.imageTar;
        const file = Array.isArray(fileField) ? fileField[0] : fileField;
        const targetRepoField = fields.targetRepo;
        const importProjectField = fields.importProject;
        const archField = fields.arch;
        const targetRepo = Array.isArray(targetRepoField) ? targetRepoField[0] : targetRepoField;
        const importProject = Array.isArray(importProjectField) ? importProjectField[0] : importProjectField;
        const arch = Array.isArray(archField) ? archField[0] : archField || 'all';

        if (!file || !targetRepo || !importProject) {
          sendJson(res, 400, { error: '缺少必填字段' });
          return;
        }

        const harborConfig = harborConfigs.find(c => c.name === targetRepo);
        if (!harborConfig) {
          sendJson(res, 400, { error: '未找到指定的仓库配置' });
          return;
        }

        const originalFilename = file.originalFilename;
        const targetFilePath = path.join(UPLOAD_DIR, originalFilename);

        // 检查文件是否已存在
        if (fs.existsSync(targetFilePath)) {
          log('INFO', `文件已存在，跳过上传: ${originalFilename}`);
        }

        const target = `${harborConfig.harborUrl.replace(/^https?:\/\//, '')}/${importProject}/${originalFilename.replace(/\.tar(\.gz)?$/, '')}:latest`;
        const task = createTask('本地导入', originalFilename, target, arch);
        log('INFO', `创建镜像导入任务: ${task.id}, 文件: ${originalFilename}, 目标: ${target}, 架构: ${arch}`);
        addTaskLog(task.id, `创建本地导入任务，目标项目: ${importProject}, 架构: ${arch}`);

        setImmediate(() => loadAndPushTar(task.id, targetFilePath, importProject, harborConfig, arch));

        sendJson(res, 200, { task });
      });
      return;
    }

    if (req.method === 'DELETE' && pathname.match(/^\/api\/tasks\/[\w]+$/)) {
      const taskId = pathname.split('/').pop();
      const task = tasks.find(t => t.id === taskId);

      if (!task) {
        sendJson(res, 404, { error: '任务不存在' });
        return;
      }

      // 如果是本地导入任务，删除对应的 tar 文件
      let fileDeleted = false;
      if (task.type === '本地导入') {
        const tarFileName = task.source;
        const tarPath = path.join(UPLOAD_DIR, tarFileName);
        if (fs.existsSync(tarPath)) {
          try {
            fs.unlinkSync(tarPath);
            fileDeleted = true;
            log('INFO', `删除 tar 包: ${tarFileName}`);
          } catch (e) {
            log('ERROR', `删除 tar 包失败: ${e.message}`);
          }
        }
      }

      tasks = tasks.filter(t => t.id !== taskId);
      saveTasks();
      
      // 同时删除 SFTP 上传任务记录（如果存在）
      if (sftpUploadTasks.has(taskId)) {
        const sftpTask = sftpUploadTasks.get(taskId);
        // 停止正在运行的上传
        if (sftpTask) {
          sftpTask._stopUploading = true;
          sftpTask.status = 'cancelled';
          // 触发所有取消信号终止 rclone 进程
          let terminatedCount = 0;
          if (sftpTask._cancelSignals && sftpTask._cancelSignals.length > 0) {
            for (const signal of sftpTask._cancelSignals) {
              if (signal && signal.onCancel) {
                try {
                  signal.onCancel();
                  terminatedCount++;
                } catch (e) {
                  log('WARN', `终止 rclone 进程失败: ${e.message}`);
                }
              }
            }
          }
          log('INFO', `已终止 ${terminatedCount} 个 rclone 进程: ${taskId}`);
        }
        sftpUploadTasks.delete(taskId);
        saveSftpTasks();
        log('INFO', `删除 SFTP 任务记录: ${taskId}`);
      }
      
      log('INFO', `删除任务: ${taskId}`);
      sendJson(res, 200, { message: '任务已删除', fileDeleted });
      return;
    }

    if (req.method === 'POST' && pathname.match(/^\/api\/tasks\/[\w]+\/retry$/)) {
      const taskId = pathname.split('/')[3];
      const task = tasks.find(t => t.id === taskId);
      
      if (!task) {
        sendJson(res, 404, { error: '任务不存在' });
        return;
      }
      
      if (task.status === '完成') {
        sendJson(res, 400, { error: '已成功的任务不能重新执行' });
        return;
      }
      
      // 重置任务状态
      task.status = '待执行';
      task.message = '';
      task.logs = [];
      task.time = new Date().toLocaleString('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
      delete task.updatedAt;
      saveTasks();
      
      log('INFO', `重新执行任务: ${taskId}`);
      
      // 根据任务类型重新执行
      if (task.type === '镜像同步') {
        const harborConfig = harborConfigs.find(c => task.target.includes(c.harborUrl.replace(/^https?:\/\//, '')));
        if (harborConfig) {
          const targetProject = task.target.split('/')[1];
          setImmediate(() => syncImage(taskId, task.source, targetProject, harborConfig, task.arch || 'all'));
        }
      } else if (task.type === '本地导入') {
        // 检查 tar 包是否存在
        const tarFileName = task.source;
        const tarPath = path.join(UPLOAD_DIR, tarFileName);
        if (!fs.existsSync(tarPath)) {
          sendJson(res, 400, { error: '本地导入任务无法重新执行，tar 包已被删除' });
          return;
        }
        // 找到对应的 Harbor 配置
        const harborConfig = harborConfigs.find(c => task.target.includes(c.harborUrl.replace(/^https?:\/\//, '')));
        if (!harborConfig) {
          sendJson(res, 400, { error: '未找到对应的 Harbor 配置' });
          return;
        }
        const importProject = task.target.split('/')[1];
        setImmediate(() => loadAndPushTar(taskId, tarPath, importProject, harborConfig, task.arch || 'all'));
      }
      
      sendJson(res, 200, { message: '任务已重新执行', task });
      return;
    }

    if (req.method === 'DELETE' && pathname.match(/^\/api\/harbor\/config\/[^\/]+$/)) {
      const repoName = decodeURIComponent(pathname.split('/').pop());
      const existingIndex = harborConfigs.findIndex(c => c.name === repoName);
      if (existingIndex === -1) {
        sendJson(res, 404, { error: '仓库不存在' });
        return;
      }
      harborConfigs.splice(existingIndex, 1);
      saveConfig();
      log('INFO', `删除仓库配置: ${repoName}`);
      sendJson(res, 200, { message: '仓库已删除' });
      return;
    }

    // ==================== Rclone SFTP 路由 ====================
    
    // 检查 rclone 是否已安装
    if (req.method === 'GET' && pathname === '/api/rclone/status') {
      const hasRclone = await rclone.checkRclone();
      sendJson(res, 200, { installed: hasRclone });
      return;
    }
    
    // 获取所有 SFTP 配置
    if (req.method === 'GET' && pathname === '/api/sftp/configs') {
      const configs = rclone.loadAllSftpConfigs();
      // 隐藏密码
      const safeConfigs = configs.map(c => ({ ...c, password: c.password ? '***' : undefined, keyFile: c.keyFile ? '***' : undefined }));
      sendJson(res, 200, { configs: safeConfigs });
      return;
    }
    
    // 保存 SFTP 配置
    if (req.method === 'POST' && pathname === '/api/sftp/config') {
      const body = await parseJsonBody(req);
      const { name, host, port, username, password, keyFile } = body;
      
      if (!name || !host || !username) {
        sendJson(res, 400, { error: '缺少必填字段' });
        return;
      }
      
      const config = { name, host, port: port || 22, username, password, keyFile };
      await rclone.saveSftpConfig(config);
      log('INFO', `保存 SFTP 配置: ${name}`);
      
      sendJson(res, 200, { message: '配置已保存', config: { ...config, password: config.password ? '***' : undefined } });
      return;
    }
    
    // 删除 SFTP 配置
    if (req.method === 'DELETE' && pathname.match(/^\/api\/sftp\/config\/[^\/]+$/)) {
      const configName = decodeURIComponent(pathname.split('/').pop());
      await rclone.deleteSftpConfig(configName);
      log('INFO', `删除 SFTP 配置: ${configName}`);
      sendJson(res, 200, { message: '配置已删除' });
      return;
    }
    
    // 测试 SFTP 连接（使用前端传入的参数）
    if (pathname === '/api/sftp/test' && req.method === 'POST') {
      log('INFO', `收到 /api/sftp/test 请求，方法: ${req.method}`);
      const body = await parseJsonBody(req);
      const { host, port, username, password, keyFile } = body;
      
      if (!host || !username) {
        sendJson(res, 400, { error: '缺少必填字段' });
        return;
      }
      
      const config = { name: 'test', host, port: port || 22, username, password, keyFile };
      const result = await rclone.testSftpConnection(config);
      
      if (result.success) {
        sendJson(res, 200, { success: true, message: '连接成功' });
      } else {
        sendJson(res, 400, { success: false, error: result.error });
      }
      return;
    }
    
    // 测试已保存的 SFTP 配置
    if (pathname.match(/^\/api\/sftp\/test\/[^\/]+$/) && req.method === 'GET') {
      const configName = decodeURIComponent(pathname.split('/').pop());
      log('INFO', `测试已保存的 SFTP 配置: ${configName}`);
      
      const configs = rclone.loadAllSftpConfigs();
      const config = configs.find(c => c.name === configName);
      
      if (!config) {
        sendJson(res, 404, { error: '配置不存在' });
        return;
      }
      
      const result = await rclone.testSftpConnection(config);
      
      if (result.success) {
        sendJson(res, 200, { success: true, message: '连接成功' });
      } else {
        sendJson(res, 400, { success: false, error: result.error });
      }
      return;
    }
    
    // ========== ModelScope 模型下载 ==========
    
    // 启动 ModelScope 下载
    if (req.method === 'POST' && pathname === '/api/modelscope/download') {
      const body = await parseJsonBody(req);
      const { modelId, localDir, downloadType, filePath } = body;
      
      if (!modelId || !localDir) {
        sendJson(res, 400, { error: '缺少必填参数' });
        return;
      }
      
      // 创建任务
      const taskId = `ms_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const task = {
        id: taskId,
        type: '模型下载',
        source: modelId,
        target: localDir,
        status: '执行中',
        message: '正在初始化下载...',
        logs: [],
        progress: 0,
        time: new Date().toLocaleString('zh-CN')
      };
      tasks.unshift(task);
      saveTasks();
      
      // 存储详细任务信息
      modelscopeTasks.set(taskId, {
        ...task,
        startTime: new Date(),
        cancelled: false
      });
      
      log('INFO', `创建 ModelScope 下载任务: ${taskId}, 模型: ${modelId}, 目录: ${localDir}`);
      sendJson(res, 200, { taskId });
      
      // 异步执行下载
      (async () => {
        try {
          addTaskLog(taskId, `开始下载模型: ${modelId}`);
          addTaskLog(taskId, `目标目录: ${localDir}`);
          
          // 检查目标目录是否存在（/models 是挂载目录，不需要创建）
          if (!fs.existsSync(localDir)) {
            // 如果目录不存在，尝试创建（仅对非挂载目录）
            if (!localDir.startsWith('/models')) {
              try {
                fs.mkdirSync(localDir, { recursive: true });
                addTaskLog(taskId, `已创建目录: ${localDir}`);
              } catch (mkdirErr) {
                // 目录创建失败，让 modelscope 自己处理
                addTaskLog(taskId, `目录创建跳过: ${mkdirErr.message}`);
              }
            }
          } else {
            addTaskLog(taskId, `目标目录已存在: ${localDir}`);
          }
          
          // 构建 Python SDK 下载命令
          const scriptPath = path.join(__dirname, 'modelscope_download.py');
          
          let cmd;
          if (downloadType === 'file' && filePath) {
            // 单文件下载
            addTaskLog(taskId, `下载类型: 单文件 (${filePath})`);
            cmd = `python3 "${scriptPath}" "${modelId}" "${localDir}" "${filePath}"`;
          } else {
            // 完整模型下载
            addTaskLog(taskId, '下载类型: 完整模型');
            cmd = `python3 "${scriptPath}" "${modelId}" "${localDir}"`;
          }
          
          addTaskLog(taskId, `使用 Python SDK 下载模型`);
          updateTaskStatus(taskId, '执行中', '正在下载...');
          
          // 执行下载命令
          const childProcess = exec(cmd, { maxBuffer: 100 * 1024 * 1024 });
          
          // 保存进程引用以便取消
          const taskInfo = modelscopeTasks.get(taskId);
          if (taskInfo) {
            taskInfo.process = childProcess;
          }
          
          let lastProgress = 0;
          
          childProcess.stdout.on('data', (data) => {
            const output = data.toString().trim();
            const lines = output.split('\n').filter(l => l.trim());
            
            lines.forEach(line => {
              try {
                // 尝试解析 JSON 输出
                const jsonMatch = line.match(/^\{.*\}$/);
                if (jsonMatch) {
                  const jsonData = JSON.parse(line);
                  if (jsonData.status === 'downloading') {
                    task.message = jsonData.message || '下载中...';
                  } else if (jsonData.status === 'completed') {
                    addTaskLog(taskId, `✅ ${jsonData.message}`);
                  } else if (jsonData.status === 'cancelled') {
                    addTaskLog(taskId, `⚠️ ${jsonData.message}`);
                  } else if (jsonData.error) {
                    addTaskLog(taskId, `❌ 错误: ${jsonData.error}`);
                  } else {
                    addTaskLog(taskId, jsonData.message || line);
                  }
                } else {
                  // 非 JSON 输出，直接记录
                  if (line.includes('Downloading') || line.includes('downloading') || line.includes('%')) {
                    // 尝试解析进度
                    const progressMatch = line.match(/(\d+)%/);
                    if (progressMatch) {
                      const progress = parseInt(progressMatch[1]);
                      if (progress !== lastProgress) {
                        lastProgress = progress;
                        task.progress = progress;
                        task.message = `下载中... ${progress}%`;
                      }
                    }
                    addTaskLog(taskId, line);
                  }
                }
              } catch (e) {
                // JSON 解析失败，直接输出
                if (line.trim()) {
                  addTaskLog(taskId, line);
                }
              }
            });
          });
          
          childProcess.stderr.on('data', (data) => {
            const output = data.toString().trim();
            if (output) {
              addTaskLog(taskId, `[INFO] ${output}`);
            }
          });
          
          childProcess.on('close', (code) => {
            const t = modelscopeTasks.get(taskId);
            if (t && t.cancelled) {
              updateTaskStatus(taskId, '已取消', '用户取消下载');
              addTaskLog(taskId, '❌ 下载已取消');
              log('INFO', `ModelScope 下载任务已取消: ${taskId}`);
            } else if (code === 0) {
              updateTaskStatus(taskId, '完成', '下载完成');
              task.progress = 100;
              addTaskLog(taskId, `✅ 模型下载成功: ${localDir}`);
              log('INFO', `ModelScope 下载任务完成: ${taskId}`);
            } else {
              updateTaskStatus(taskId, '失败', `下载失败，退出码: ${code}`);
              addTaskLog(taskId, `❌ 下载失败，退出码: ${code}`);
              log('ERROR', `ModelScope 下载任务失败: ${taskId}, 退出码: ${code}`);
            }
            modelscopeTasks.delete(taskId);
          });
          
          childProcess.on('error', (err) => {
            updateTaskStatus(taskId, '失败', err.message);
            addTaskLog(taskId, `❌ 执行错误: ${err.message}`);
            log('ERROR', `ModelScope 下载任务错误: ${taskId}, ${err.message}`);
            modelscopeTasks.delete(taskId);
          });
          
        } catch (error) {
          updateTaskStatus(taskId, '失败', error.message);
          addTaskLog(taskId, `❌ 下载失败: ${error.message}`);
          log('ERROR', `ModelScope 下载任务异常: ${taskId}, ${error.message}`);
          modelscopeTasks.delete(taskId);
        }
      })();
      
      return;
    }
    
    // 取消 ModelScope 下载
    if (req.method === 'POST' && pathname.match(/^\/api\/modelscope\/cancel\/ms_/)) {
      const taskId = pathname.split('/').pop();
      const taskInfo = modelscopeTasks.get(taskId);
      
      if (!taskInfo) {
        sendJson(res, 404, { error: '任务不存在或已完成' });
        return;
      }
      
      if (taskInfo.process) {
        taskInfo.cancelled = true;
        taskInfo.process.kill('SIGTERM');
        sendJson(res, 200, { message: '已发送取消信号' });
        log('INFO', `取消 ModelScope 下载任务: ${taskId}`);
      } else {
        sendJson(res, 400, { error: '无法取消任务' });
      }
      return;
    }
    
    // 查询 ModelScope 下载进度
    if (req.method === 'GET' && pathname.match(/^\/api\/modelscope\/progress\/ms_/)) {
      const taskId = pathname.split('/').pop();
      const task = tasks.find(t => t.id === taskId);
      
      if (!task) {
        sendJson(res, 404, { error: '任务不存在' });
        return;
      }
      
      sendJson(res, 200, {
        status: task.status,
        progress: task.progress || 0,
        message: task.message,
        logs: task.logs || []
      });
      return;
    }
    
    // 列出远程目录
    if (req.method === 'POST' && pathname === '/api/sftp/list') {
      const body = await parseJsonBody(req);
      const { configName, remotePath } = body;
      
      const configs = rclone.loadAllSftpConfigs();
      const config = configs.find(c => c.name === configName);
      
      if (!config) {
        sendJson(res, 404, { error: '未找到该配置' });
        return;
      }
      
      const result = await rclone.listRemoteDirectory(config, remotePath || '/');
      
      if (result.success) {
        sendJson(res, 200, { entries: result.entries });
      } else {
        sendJson(res, 400, { error: result.error });
      }
      return;
    }

    // 删除远程文件/目录
    if (req.method === 'POST' && pathname === '/api/sftp/delete') {
      const body = await parseJsonBody(req);
      const { configName, remotePath, isDir } = body;

      const configs = rclone.loadAllSftpConfigs();
      const config = configs.find(c => c.name === configName);

      if (!config) {
        sendJson(res, 404, { error: '未找到该配置' });
        return;
      }

      const result = await rclone.deleteRemoteFile(config, remotePath, isDir);

      if (result.success) {
        log('INFO', `删除远程文件: ${configName}:${remotePath}`);
        sendJson(res, 200, { success: true, message: '删除成功' });
      } else {
        sendJson(res, 400, { error: result.error });
      }
      return;
    }

    // SFTP 上传任务初始化（预创建任务以支持刷新恢复）
    if (req.method === 'POST' && pathname === '/api/sftp/upload-init') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const { configName, remotePath, verifyHash, totalFiles } = JSON.parse(body);
          const configs = rclone.loadAllSftpConfigs();
          const config = configs.find(c => c.name === configName);

          if (!config) {
            sendJson(res, 400, { error: 'SFTP配置不存在' });
            return;
          }

          // 创建任务ID
          const taskId = `sftp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

          // 添加到任务列表（用于显示在任务列表中）
          const task = {
            id: taskId,
            type: 'sftp文件',
            source: `${totalFiles} 个文件`,
            target: `${config.host}:${remotePath}`,
            status: '执行中',
            message: '正在上传文件到服务器...',
            logs: [],
            time: new Date().toLocaleString('zh-CN')
          };
          tasks.unshift(task);
          saveTasks();

          // 保存任务状态（初始状态，等待文件上传）
          sftpUploadTasks.set(taskId, {
            id: taskId,
            status: 'uploading',
            progress: 0,
            message: '正在上传文件到服务器...',
            details: '',
            files: { files: [] },
            config: config,
            remotePath: remotePath,
            verifyHash: verifyHash,
            startTime: new Date(),
            totalFiles: totalFiles,
            uploadedFileCount: 0,
            logs: [],
            phase: 'browser-upload' // 标记为浏览器上传阶段
          });
          saveSftpTasks();

          log('INFO', `预创建SFTP上传任务: ${taskId}, 配置: ${configName}, 远程路径: ${remotePath}`);
          sendJson(res, 200, { taskId });
        } catch (error) {
          sendJson(res, 400, { error: '无效的请求数据' });
        }
      });
      return;
    }

    // SFTP 检查已存在的文件（不完整的删除重新传）
    if (req.method === 'POST' && pathname === '/api/sftp/check-existing') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const { files } = JSON.parse(body);
          const tempDir = path.join(UPLOAD_DIR, 'temp');
          
          const existingFiles = [];
          const missingFiles = [];
          
          for (const file of files) {
            const expectedPath = path.join(tempDir, path.basename(file.name));
            if (fs.existsSync(expectedPath)) {
              const stat = fs.statSync(expectedPath);
              if (stat.size === file.size && file.size > 0) {
                // 完全上传的文件
                existingFiles.push(file.name);
              } else {
                // 文件不完整，删除重新传
                try {
                  fs.unlinkSync(expectedPath);
                  log('INFO', `删除不完整的文件: ${file.name} (${stat.size}/${file.size} bytes)`);
                } catch (e) {
                  log('WARN', `删除不完整文件失败: ${file.name} - ${e.message}`);
                }
                missingFiles.push(file.name);
              }
            } else {
              missingFiles.push(file.name);
            }
          }
          
          // 如果所有文件都已存在，尝试自动触发 SFTP 上传
          if (missingFiles.length === 0 && existingFiles.length > 0) {
            // 查找处于 browser-upload 阶段的任务
            let targetTask = null;
            let targetTaskId = null;
            for (const [taskId, task] of sftpUploadTasks) {
              if (task.phase === 'browser-upload' && task.status === 'uploading') {
                targetTask = task;
                targetTaskId = taskId;
                break;
              }
            }
            
            if (targetTask) {
              // 从 temp 目录收集文件信息
              const existingFileInfos = [];
              for (const filename of existingFiles) {
                const filePath = path.join(tempDir, path.basename(filename));
                if (fs.existsSync(filePath)) {
                  const stat = fs.statSync(filePath);
                  existingFileInfos.push({
                    originalFilename: filename,
                    filepath: filePath,
                    size: stat.size
                  });
                }
              }
              
              if (existingFileInfos.length > 0) {
                // 更新任务文件列表
                targetTask.files.files = existingFileInfos;
                targetTask.uploadedFileCount = existingFileInfos.length;
                targetTask.phase = 'server-upload';
                saveSftpTasks();
                log('INFO', `任务 ${targetTaskId} 自动启动 SFTP 上传（${existingFileInfos.length} 个文件来自 temp 目录）`);
                // 异步执行上传
                setImmediate(() => executeSftpUpload(targetTaskId));
              }
            }
          }
          
          sendJson(res, 200, { existingFiles, missingFiles });
        } catch (error) {
          sendJson(res, 400, { error: '无效的请求数据' });
        }
      });
      return;
    }

    // SFTP 文件上传
    if (req.method === 'POST' && pathname === '/api/sftp/upload') {
      const tempDir = path.join(UPLOAD_DIR, 'temp');
      
      // 确保临时目录存在
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }
      
      const upload = require('multer')({ dest: tempDir });
      
      // 使用 formidable 处理文件上传
      const form = formidable({
        uploadDir: tempDir,
        keepExtensions: true,
        multiples: true,
        maxFileSize: 30 * 1024 * 1024 * 1024, // 30GB 单个文件限制
        maxTotalFileSize: 30 * 1024 * 1024 * 1024, // 30GB 总文件限制
        filename: (name, ext, part, form) => {
          // 只保留文件名，不保留路径（避免目录不存在的问题）
          const originalName = part.originalFilename || `${Date.now()}-${name}`;
          return path.basename(originalName);
        }
      });
      
      form.parse(req, async (err, fields, files) => {
        if (err) {
          log('ERROR', `文件上传失败: ${err.message}`);
          sendJson(res, 400, { error: '文件上传失败: ' + err.message });
          return;
        }
        
        const configName = Array.isArray(fields.configName) ? fields.configName[0] : fields.configName;
        const remotePath = Array.isArray(fields.remotePath) ? fields.remotePath[0] : fields.remotePath;
        const verifyHash = (Array.isArray(fields.verifyHash) ? fields.verifyHash[0] : fields.verifyHash) === 'true';
        const fileIndex = parseInt(Array.isArray(fields.fileIndex) ? fields.fileIndex[0] : fields.fileIndex) || 0;
        const totalFiles = parseInt(Array.isArray(fields.totalFiles) ? fields.totalFiles[0] : fields.totalFiles) || 1;
        const existingTaskId = Array.isArray(fields.taskId) ? fields.taskId[0] : fields.taskId; // 获取已有的taskId

        if (!configName || !remotePath) {
          sendJson(res, 400, { error: '缺少配置名称或远程路径' });
          return;
        }
        
        const configs = rclone.loadAllSftpConfigs();
        const config = configs.find(c => c.name === configName);
        
        if (!config) {
          sendJson(res, 404, { error: '未找到 SFTP 配置' });
          return;
        }

        // 处理文件 - 检查是否已存在（断点续传场景）
        const fileField = files.files;
        const uploadedFiles = Array.isArray(fileField) ? fileField : [fileField];
        const existingFiles = [];
        const newFiles = [];
        
        for (const file of uploadedFiles) {
          if (!file || !file.originalFilename) continue;
          
          const expectedPath = path.join(tempDir, path.basename(file.originalFilename));
          
          // 检查文件是否已存在且大小匹配
          if (fs.existsSync(expectedPath)) {
            const existingStat = fs.statSync(expectedPath);
            const newFileSize = file.size || 0;
            
            if (existingStat.size === newFileSize && newFileSize > 0) {
              // 文件已存在且大小一致，直接使用已有文件
              log('INFO', `文件已存在且大小匹配，跳过上传: ${file.originalFilename} (${newFileSize} bytes)`);
              existingFiles.push({
                ...file,
                filepath: expectedPath,
                size: existingStat.size
              });
              // 删除临时上传的文件（如果不同路径）
              if (file.filepath && file.filepath !== expectedPath && fs.existsSync(file.filepath)) {
                try {
                  fs.unlinkSync(file.filepath);
                } catch (e) {}
              }
              continue;
            }
          }
          
          // 新文件或大小不匹配，使用新上传的文件
          newFiles.push(file);
        }
        
        // 合并文件列表（已有文件 + 新上传文件）
        const allFiles = [...existingFiles, ...newFiles];
        
        if (allFiles.length === 0) {
          sendJson(res, 400, { error: '没有有效的文件可上传' });
          return;
        }
        
        log('INFO', `文件上传处理: 新上传 ${newFiles.length} 个, 已存在 ${existingFiles.length} 个, 共 ${allFiles.length} 个文件, fileIndex=${fileIndex}, totalFiles=${totalFiles}`);
        log('INFO', `文件列表: ${allFiles.map(f => f.originalFilename).join(', ')}`);
        
        // 确定任务ID
        let taskId;
        let isNewTask = false;
        
        // 优先使用预创建的任务ID
        if (existingTaskId && sftpUploadTasks.has(existingTaskId)) {
          taskId = existingTaskId;
          const task = sftpUploadTasks.get(taskId);
          // 更新任务文件列表（只保存必要的字段）
          const currentFiles = Array.isArray(task.files.files) ? task.files.files : [];
          const cleanFiles = allFiles.map(f => ({
            originalFilename: f.originalFilename,
            filepath: f.filepath,
            size: f.size
          }));
          task.files.files = [...currentFiles, ...cleanFiles];
          task.uploadedFileCount = task.files.files.length;
          task.phase = 'server-upload'; // 切换到服务器上传阶段
          saveSftpTasks();
          log('INFO', `使用预创建任务 ${taskId}, 当前共 ${task.files.files.length} 个文件, 目标 ${task.totalFiles} 个`);
          
          // 流式上传：每个文件上传完成后立即开始 SFTP 上传（如果还没开始）
          if (!task.sftpStarted) {
            log('INFO', `文件上传完成，立即启动 SFTP 上传: ${taskId}`);
            task.sftpStarted = true;
            saveSftpTasks();
            setImmediate(() => executeSftpUpload(taskId));
          } else {
            log('INFO', `SFTP 上传已在进行中，新文件将自动加入: ${taskId}`);
          }
        } else if (fileIndex === 0 || existingTaskId) {
          // 第一个文件且没有预创建任务，或预创建任务不存在，创建新任务
          taskId = existingTaskId || `sftp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
          isNewTask = true;
          
          // 保存任务状态
          // 只保存文件必要字段
          const cleanFiles = allFiles.map(f => ({
            originalFilename: f.originalFilename,
            filepath: f.filepath,
            size: f.size
          }));
          sftpUploadTasks.set(taskId, {
            id: taskId,
            status: 'uploading',
            progress: 0,
            message: '准备上传...',
            details: '',
            files: { files: cleanFiles },
            config: config,
            remotePath: remotePath,
            verifyHash: verifyHash,
            startTime: new Date(),
            totalFiles: totalFiles,
            uploadedFileCount: cleanFiles.length,
            phase: 'server-upload'
          });
          saveSftpTasks();
          
          log('INFO', `创建新任务 ${taskId}`);
          
          // 异步执行上传
          setImmediate(() => executeSftpUpload(taskId));
        } else {
          // 后续文件，查找最近创建的待处理任务
          const pendingTasks = Array.from(sftpUploadTasks.values())
            .filter(t => t.status === 'uploading' && t.config.name === configName)
            .sort((a, b) => b.startTime - a.startTime);
          
          if (pendingTasks.length > 0) {
            taskId = pendingTasks[0].id;
            // 更新任务文件列表
            const task = sftpUploadTasks.get(taskId);
            const currentFiles = Array.isArray(task.files.files) ? task.files.files : [task.files.files];
            task.files.files = [...currentFiles, ...allFiles];
            task.uploadedFileCount = task.files.files.length;
            saveSftpTasks();
            log('INFO', `添加文件到现有任务 ${taskId}, 当前共 ${task.files.files.length} 个文件`);
          } else {
            // 找不到现有任务，创建新任务
            taskId = `sftp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            isNewTask = true;
            
            sftpUploadTasks.set(taskId, {
              id: taskId,
              status: 'uploading',
              progress: 0,
              message: '准备上传...',
              details: '',
              files: { files: allFiles },
              config: config,
              remotePath: remotePath,
              verifyHash: verifyHash,
              startTime: new Date(),
              totalFiles: totalFiles,
              uploadedFileCount: allFiles.length,
              phase: 'server-upload'
            });
            saveSftpTasks();
            
            setImmediate(() => executeSftpUpload(taskId));
          }
        }
        
        sendJson(res, 200, { 
          taskId, 
          message: isNewTask ? '上传任务已创建' : '文件已添加到任务',
          skipped: existingFiles.length,
          uploaded: newFiles.length
        });
      });
      return;
    }
    
    // 获取 SFTP 上传状态
    if (req.method === 'GET' && pathname.match(/^\/api\/sftp\/upload-status\/[^\/]+$/)) {
      const taskId = pathname.split('/').pop();
      const task = sftpUploadTasks.get(taskId);
      
      if (!task) {
        sendJson(res, 404, { error: '任务不存在' });
        return;
      }
      
      // 计算总速率
      let totalSpeed = '';
      if (task.status === 'uploading' && task.startTime) {
        const elapsed = (Date.now() - task.startTime) / 1000;
        const progress = task.progress || 0;
        if (elapsed > 0 && progress > 0) {
          // 估算总速度
          totalSpeed = task.currentSpeed || '';
        }
      }
      
      // 构建文件列表及状态
      const fileArray = Array.isArray(task.files.files) ? task.files.files : [];
      
      // 确保 fileStatuses 存在
      if (!task.fileStatuses) {
        task.fileStatuses = {};
      }
      
      const fileStatusList = fileArray.map((f, idx) => {
        const fileName = f.originalFilename || path.basename(f.filepath);
        const fileSize = f.size || 0;
        const fileKey = f.filepath || fileName;
        
        // 优先使用持久化的状态
        let status = task.fileStatuses[fileKey]?.status || 'waiting';
        let percent = task.fileStatuses[fileKey]?.percent || 0;
        
        // 如果没有持久化状态，则根据当前状态判断
        if (!task.fileStatuses[fileKey]) {
          if (task.processedFiles && task.processedFiles.has(f.filepath)) {
            status = 'completed';
            percent = 100;
          } else if (task.currentFile === fileName) {
            status = 'uploading';
            percent = task.currentPercent || 0;
          }
        }
        
        return {
          name: fileName,
          size: fileSize,
          status: status,
          percent: percent
        };
      });
      
      sendJson(res, 200, {
        status: task.status,
        progress: task.progress,
        message: task.message,
        details: task.details,
        speed: totalSpeed,
        currentFile: task.currentFile,
        uploadedFiles: task.uploadedFiles,
        totalFiles: task.totalFiles,
        logs: task.logs || [],
        phase: task.phase || 'server-upload', // 返回任务阶段
        files: fileStatusList // 返回文件列表及状态
      });
      
      // 如果是 browser-upload 阶段但文件列表为空（所有文件都已存在），自动触发 SFTP 上传
      if (task.phase === 'browser-upload' && (!task.files.files || task.files.files.length === 0)) {
        const tempDir = path.join(UPLOAD_DIR, 'temp');
        const existingFiles = [];
        
        // 遍历 temp 目录，收集所有文件
        if (fs.existsSync(tempDir)) {
          const files = fs.readdirSync(tempDir);
          for (const file of files) {
            const filePath = path.join(tempDir, file);
            const stat = fs.statSync(filePath);
            if (stat.isFile()) {
              existingFiles.push({
                originalFilename: file,
                filepath: filePath,
                size: stat.size
              });
            }
          }
        }
        
        if (existingFiles.length > 0) {
          task.files.files = existingFiles;
          task.uploadedFileCount = existingFiles.length;
          task.phase = 'server-upload';
          saveSftpTasks();
          log('INFO', `任务 ${taskId} 启动 SFTP 上传（${existingFiles.length} 个文件来自 temp 目录）`);
          setImmediate(() => executeSftpUpload(taskId));
        }
      }
      
      return;
    }
    
    // 取消 SFTP 上传任务
    if (req.method === 'POST' && pathname.match(/^\/api\/sftp\/upload-cancel\/[^\/]+$/)) {
      const taskId = pathname.split('/').pop();
      const task = sftpUploadTasks.get(taskId);
      
      if (!task) {
        sendJson(res, 404, { error: '任务不存在' });
        return;
      }
      
      if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') {
        sendJson(res, 400, { error: '任务已结束，无法取消' });
        return;
      }
      
      // 标记任务为取消状态
      task.status = 'cancelled';
      task.message = '用户取消上传';
      addTaskLog(taskId, '用户取消上传');
      
      // 触发所有取消信号，杀死正在运行的 rclone 进程
      if (task._cancelSignals && task._cancelSignals.length > 0) {
        task._cancelSignals.forEach(signal => {
          if (signal.onCancel) {
            try {
              signal.onCancel();
            } catch (e) {
              log('ERROR', `取消信号触发失败: ${e.message}`);
            }
          }
        });
        task._cancelSignals = [];
      }
      
      log('INFO', `SFTP 上传任务已取消: ${taskId}`);
      
      sendJson(res, 200, { message: '任务已取消' });
      return;
    }

    if (req.method === 'GET') {
      serveFile(req, res, pathname);
      return;
    }

    sendJson(res, 405, { error: 'Method not allowed' });
  } catch (error) {
    log('ERROR', `请求处理错误: ${error.message}`);
    sendJson(res, 500, { error: error.message });
  }
});

loadConfig();
loadTasks();
loadSftpTasks();

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// 执行 SFTP 上传任务（流式上传，支持增量添加文件）
async function executeSftpUpload(taskId) {
  const task = sftpUploadTasks.get(taskId);
  if (!task) return;
  
  // 防止重复启动
  if (task._uploadRunning) return;
  task._uploadRunning = true;

  const { config, remotePath, verifyHash } = task;

  try {
    task.status = 'uploading';
    task.message = '准备上传...';
    task.progress = 0;
    if (!task.logs) task.logs = [];
    if (!task.uploadedFiles) task.uploadedFiles = 0;
    if (!task.processedFiles) task.processedFiles = new Set(); // 已处理的文件集合
    if (!task.startTime) task.startTime = Date.now();

    // 更新任务列表状态
    updateTaskStatus(taskId, '执行中', '准备上传...');

    log('INFO', `SFTP 上传任务启动: ${taskId}`);
    addTaskLog(taskId, `开始上传文件到 ${config.host}:${remotePath}`);
    
    // 并行上传控制（最多3个）
    const MAX_CONCURRENT = 3;
    const uploadQueue = [];
    
    // 持续检查新文件，直到所有文件都上传完成
    while (!task._stopUploading) {
      const fileArray = Array.isArray(task.files.files) ? task.files.files : [];
      const processedFiles = task.processedFiles;
      
      // 找出尚未处理的新文件
      const newFiles = fileArray.filter(f => f && f.filepath && !processedFiles.has(f.filepath));
      
      if (newFiles.length === 0) {
        // 没有新文件，检查是否所有文件都已完成
        const totalExpected = task.totalFiles || 0;
        const currentCount = fileArray.length;
        
        // 如果已处理完所有文件且没有更多文件等待，退出循环
        if (processedFiles.size >= currentCount && task.uploadedFiles >= totalExpected) {
          break;
        }
        
        // 等待新文件加入
        await new Promise(r => setTimeout(r, 500));
        continue;
      }
      
      // 更新总数显示
      task.totalFiles = Math.max(task.totalFiles || 0, fileArray.length);
      
      // 处理新文件
      for (const file of newFiles) {
        if (!file || !file.filepath) continue;
        
        // 标记为已处理
        processedFiles.add(file.filepath);
        
        const uploadPromise = uploadSingleFile(taskId, file, config, remotePath, verifyHash)
          .then(() => {
            // 上传成功后清理临时文件
            if (file.filepath && fs.existsSync(file.filepath)) {
              try {
                fs.unlinkSync(file.filepath);
                log('INFO', `清理临时文件: ${file.filepath}`);
              } catch (e) {
                log('WARN', `清理临时文件失败: ${file.filepath}`);
              }
            }
          });
        uploadQueue.push(uploadPromise);
        
        // 控制并发数
        if (uploadQueue.length >= MAX_CONCURRENT) {
          await Promise.all(uploadQueue);
          uploadQueue.length = 0;
        }
      }
      
      // 短暂等待，让其他文件有机会加入
      await new Promise(r => setTimeout(r, 100));
    }
    
    // 等待剩余文件上传完成
    if (uploadQueue.length > 0) {
      await Promise.all(uploadQueue);
    }
    
    // 检查是否所有文件都已处理
    const fileArray = Array.isArray(task.files.files) ? task.files.files : [];
    const allProcessed = fileArray.every(f => !f || !f.filepath || task.processedFiles.has(f.filepath));
    
    if (!allProcessed && !task._stopUploading) {
      // 还有文件未处理，递归继续
      task._uploadRunning = false;
      return executeSftpUpload(taskId);
    }
    
    const duration = ((Date.now() - task.startTime) / 1000).toFixed(1);
    task.status = 'completed';
    task.progress = 100;
    task.message = `上传完成！共 ${task.uploadedFiles} 个文件`;
    task.details = `耗时 ${duration} 秒`;
    
    // 更新任务列表状态
    updateTaskStatus(taskId, '完成', `上传完成！共 ${task.uploadedFiles} 个文件，耗时 ${duration} 秒`);
    addTaskLog(taskId, `上传完成，共 ${task.uploadedFiles} 个文件，耗时 ${duration} 秒`);
    log('INFO', `SFTP 上传任务完成: ${taskId}, 共 ${task.uploadedFiles} 个文件，耗时 ${duration} 秒`);
    
    // 任务完成后延迟从内存中删除（保留 30 秒让前端能获取最终状态）
    setTimeout(() => {
      sftpUploadTasks.delete(taskId);
      saveSftpTasks();
      log('INFO', `SFTP 任务已从内存中清理: ${taskId}`);
    }, 30000);
    
  } catch (error) {
    task.status = 'failed';
    task.message = '上传失败';
    task.details = error.message;
    saveSftpTasks();

    // 更新任务列表状态
    updateTaskStatus(taskId, '失败', `上传失败: ${error.message}`);
    addTaskLog(taskId, `上传失败: ${error.message}`);
    log('ERROR', `SFTP 上传任务失败: ${taskId} - ${error.message}`);
  } finally {
    task._uploadRunning = false;
  }
}

// 上传单个文件
async function uploadSingleFile(taskId, file, config, remotePath, verifyHash) {
  const task = sftpUploadTasks.get(taskId);
  if (!task) return;

  // 检查任务是否被取消
  if (task.status === 'cancelled') {
    addTaskLog(taskId, '任务已取消，跳过上传');
    return;
  }

  const localPath = file.filepath;
  const originalName = file.originalFilename || path.basename(localPath);
  const remoteFilePath = path.posix.join(remotePath, originalName).replace(/\\/g, '/');

  const fileIndex = task.uploadedFiles + 1;

  // 获取本地文件大小
  const localSize = fs.statSync(localPath).size;

  // 检查远程文件是否已存在
  addTaskLog(taskId, `[${fileIndex}/${task.totalFiles}] 检查远程文件: ${originalName}`);
  const remoteInfo = await rclone.checkRemoteFileExists(config, remoteFilePath);

  if (remoteInfo.exists && remoteInfo.size === localSize) {
    // 远程文件已存在且大小一致，跳过实际上传
    addTaskLog(taskId, `[${fileIndex}/${task.totalFiles}] 远程文件已存在且大小一致，跳过上传: ${originalName} (${localSize} bytes)`);

    // 更新进度
    task.uploadedFiles++;
    const completedProgress = task.uploadedFiles / task.totalFiles * 100;
    task.progress = Math.round(completedProgress);
    task.message = `已跳过: ${originalName}`;
    task.details = `(${task.uploadedFiles}/${task.totalFiles}) - 已存在`;
    
    // 更新文件状态为已完成（已存在）
    if (!task.fileStatuses) {
      task.fileStatuses = {};
    }
    task.fileStatuses[fileKey] = {
      name: originalName,
      status: 'completed',
      percent: 100,
      size: localSize,
      skipped: true
    };

    // 清理本地临时文件
    try {
      fs.unlinkSync(localPath);
    } catch (e) {
      log('WARN', `清理临时文件失败: ${localPath}`);
    }

    return;
  }

  addTaskLog(taskId, `[${fileIndex}/${task.totalFiles}] 开始上传: ${originalName}`);

  // 确保 fileStatuses 存在
  if (!task.fileStatuses) {
    task.fileStatuses = {};
  }
  const fileKey = file.filepath;
  
  // 初始化文件状态
  task.fileStatuses[fileKey] = {
    name: originalName,
    status: 'uploading',
    percent: 0,
    size: localSize
  };

  // 创建取消信号控制器（支持多个并发上传的取消）
  if (!task._cancelSignals) {
    task._cancelSignals = [];
  }
  const cancelSignal = { onCancel: null };
  task._cancelSignals.push(cancelSignal);

  try {
    const result = await rclone.uploadFile(config, localPath, remoteFilePath, {
      checkHash: verifyHash,
      maxRetries: 3,
      signal: cancelSignal,
      onProgress: (progress) => {
        // 检查任务是否被取消
        if (task.status === 'cancelled' || task._stopUploading) {
          return;
        }

        if (progress.type === 'progress') {
          const speed = progress.speed || '';
          const percent = progress.percent || 0;
          const transferred = progress.transferred || '';
          const total = progress.total || '';
          task.currentSpeed = speed;
          task.currentFile = originalName;
          task.currentPercent = percent;
          
          // 更新文件状态
          if (task.fileStatuses && task.fileStatuses[fileKey]) {
            task.fileStatuses[fileKey].status = 'uploading';
            task.fileStatuses[fileKey].percent = percent;
          }

          // 计算总进度
          const completedProgress = task.uploadedFiles / task.totalFiles * 100;
          const currentFileProgress = (percent / 100) * (100 / task.totalFiles);
          task.progress = Math.round(completedProgress + currentFileProgress);

          task.message = `上传中: ${originalName}`;
          task.details = `${fileIndex}/${task.totalFiles} - ${percent}% - ${speed}`;
          
          // 添加进度日志（格式: 2.716 GiB / 7.161 GiB, 38%, 10.460 MiB/s）
          // 限制日志频率，每5秒记录一次，避免日志过多
          const lastLogTime = task._lastLogTime || 0;
          const now = Date.now();
          const shouldLog = (now - lastLogTime > 5000) || percent === 100 || percent === 0;
          
          if (shouldLog) {
            task._lastLogTime = now;
            
            const progressLog = [];
            if (transferred && total) {
              progressLog.push(`${transferred} / ${total}`);
            }
            if (percent !== undefined && percent !== null) {
              progressLog.push(`${percent}%`);
            }
            if (speed) {
              progressLog.push(`${speed}`);
            }
            if (progressLog.length > 0) {
              addTaskLog(taskId, `[${fileIndex}/${task.totalFiles}] ${originalName}: ${progressLog.join(', ')}`);
            }
          }
        } else if (progress.type === 'verifying') {
          addTaskLog(taskId, `[${fileIndex}/${task.totalFiles}] 验证完整性: ${originalName}`);
        } else if (progress.type === 'verified') {
          addTaskLog(taskId, `[${fileIndex}/${task.totalFiles}] 校验通过: ${originalName}`);
        }
      }
    });

    if (!result.success) {
      throw new Error(result.error || '未知错误');
    }

    task.uploadedFiles++;
    addTaskLog(taskId, `[${fileIndex}/${task.totalFiles}] 上传完成: ${originalName} ${result.hash ? '(校验通过)' : ''}`);
    
    // 更新文件状态为已完成
    if (task.fileStatuses && task.fileStatuses[fileKey]) {
      task.fileStatuses[fileKey].status = 'completed';
      task.fileStatuses[fileKey].percent = 100;
    }

    // 清理临时文件
    try {
      fs.unlinkSync(localPath);
    } catch (e) {
      log('WARN', `清理临时文件失败: ${localPath}`);
    }
    
    // 从取消信号列表中移除已完成的信号
    if (task._cancelSignals) {
      const index = task._cancelSignals.indexOf(cancelSignal);
      if (index > -1) {
        task._cancelSignals.splice(index, 1);
      }
    }

  } catch (error) {
    // 从取消信号列表中移除失败的信号
    if (task._cancelSignals) {
      const index = task._cancelSignals.indexOf(cancelSignal);
      if (index > -1) {
        task._cancelSignals.splice(index, 1);
      }
    }
    
    // 如果是取消导致的错误，不抛出异常
    if (task.status === 'cancelled') {
      addTaskLog(taskId, `[${fileIndex}/${task.totalFiles}] 上传已取消: ${originalName}`);
      return;
    }
    addTaskLog(taskId, `[${fileIndex}/${task.totalFiles}] 上传失败: ${originalName} - ${error.message}`);
    throw error;
  }
}

server.listen(PORT, '0.0.0.0', () => {
  log('INFO', `服务器启动成功，监听 http://0.0.0.0:${PORT}`);
});
