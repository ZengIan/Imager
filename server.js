// 设置 UTF-8 编码，解决 Windows 命令行中文乱码
process.env.CHARSET = 'UTF-8';
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { formidable } = require('formidable');
const CryptoJS = require('crypto-js');

const PORT = process.env.PORT || 8080;
const ROOT = __dirname;
const CONFIG_FILE = path.join(ROOT, 'config.json');
const TASKS_FILE = path.join(ROOT, 'tasks.json');
const UPLOAD_DIR = path.join(ROOT, 'uploads');

const SECRET_KEY = 'harbor-manager-secret-key-change-in-production';

let harborConfigs = [];
let tasks = [];

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

function createTask(type, source, target) {
  const task = {
    id: Date.now().toString(36),
    time: new Date().toLocaleString('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }),
    type,
    source,
    target,
    status: '待执行',
    logs: []
  };
  tasks.unshift(task);
  saveTasks();
  return task;
}

function addTaskLog(taskId, message) {
  const task = tasks.find(t => t.id === taskId);
  if (task) {
    task.logs.push({
      time: new Date().toISOString(),
      message
    });
    saveTasks();
  }
}

async function verifyHarborConnection(harborUrl, username, password) {
  log('INFO', `开始验证 Harbor 连接: ${harborUrl}`);
  
  // 直接使用 docker login 验证，最可靠
  return await tryDockerLogin(harborUrl, username, password);
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

async function tryDockerLogin(harborUrl, username, password) {
  return new Promise((resolve) => {
    const url = new URL(harborUrl);
    const registry = url.host;

    log('INFO', `执行 Docker 登录验证: docker login -u ${username} -p *** ${registry}`);

    const command = `docker login -u ${username} -p ${password} ${registry}`;

    exec(command, { encoding: 'utf8', timeout: 10000 }, (error, stdout, stderr) => {
      if (error) {
        log('ERROR', `Docker 登录失败: ${error.message}`);
        resolve({ success: false, error: '认证失败，请检查用户名和密码' });
      } else {
        log('INFO', 'Docker 登录验证成功');
        resolve({ success: true });
      }
    });
  });
}

function executeCommand(command, taskId) {
  return new Promise((resolve, reject) => {
    log('INFO', `执行命令: ${command}`);
    addTaskLog(taskId, `执行: ${command}`);

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
        log('ERROR', `命令执行失败: ${error.message}`);
        reject(error);
      } else {
        resolve(stdout);
      }
    });
  });
}

async function syncImage(taskId, sourceImage, targetProject, harborConfig) {
  try {
    updateTaskStatus(taskId, '执行中', '开始拉取源镜像');
    await executeCommand(`docker pull ${sourceImage}`, taskId);

    const imageParts = sourceImage.split(':');
    const imageWithoutTag = imageParts[0];
    const tag = imageParts.length > 1 ? imageParts[1] : 'latest';

    updateTaskStatus(taskId, '执行中', '标记目标镜像');
    const targetImage = `${harborConfig.harborUrl.replace(/^https?:\/\//, '')}/${targetProject}/${imageWithoutTag.split('/').pop()}:${tag}`;
    await executeCommand(`docker tag ${sourceImage} ${targetImage}`, taskId);

    updateTaskStatus(taskId, '执行中', '登录到 Harbor');
    const loginCmd = `docker login -u ${harborConfig.username} -p ${harborConfig.password} ${harborConfig.harborUrl.replace(/^https?:\/\//, '')}`;
    const loginCmdMasked = `docker login -u ${harborConfig.username} -p *** ${harborConfig.harborUrl.replace(/^https?:\/\//, '')}`;
    log('INFO', `执行命令: ${loginCmdMasked}`);
    addTaskLog(taskId, `执行: ${loginCmdMasked}`);
    await executeCommand(loginCmd, taskId);

    updateTaskStatus(taskId, '执行中', '推送到 Harbor');
    await executeCommand(`docker push ${targetImage}`, taskId);

    updateTaskStatus(taskId, '完成', '镜像同步成功');
  } catch (error) {
    updateTaskStatus(taskId, '失败', error.message);
  }
}

async function loadAndPushTar(taskId, tarPath, targetProject, harborConfig) {
  try {
    const tarFileName = path.basename(tarPath);
    log('INFO', `镜像导入任务开始: ${taskId}, tar文件: ${tarFileName}`);
    addTaskLog(taskId, `本地导入开始，文件: ${tarFileName}`);

    updateTaskStatus(taskId, '执行中', '加载本地镜像包');
    log('INFO', `执行 docker load -i ${tarFileName}`);
    addTaskLog(taskId, `准备执行: docker load -i ${tarFileName}`);
    await executeCommand(`docker load -i ${tarPath}`, taskId);

    updateTaskStatus(taskId, '执行中', '标记目标镜像');
    const imageName = path.basename(tarPath).replace(/\.tar(\.gz)?$/, '');
    const targetImage = `${harborConfig.harborUrl.replace(/^https?:\/\//, '')}/${targetProject}/${imageName}:latest`;
    log('INFO', `标记镜像: docker tag ${imageName} ${targetImage}`);
    addTaskLog(taskId, `准备执行: docker tag ${imageName} ${targetImage}`);
    await executeCommand(`docker tag ${imageName} ${targetImage}`, taskId);

    updateTaskStatus(taskId, '执行中', '登录 Harbor 仓库');
    const harborHost = harborConfig.harborUrl.replace(/^https?:\/\//, '');
    log('INFO', `登录 Harbor: docker login -u ${harborConfig.username} -p *** ${harborHost}`);
    addTaskLog(taskId, `准备执行: docker login -u ${harborConfig.username} -p *** ${harborHost}`);
    await executeCommand(`docker login -u ${harborConfig.username} -p ${harborConfig.password} ${harborHost}`, taskId);

    updateTaskStatus(taskId, '执行中', '推送到 Harbor');
    log('INFO', `推送镜像: docker push ${targetImage}`);
    addTaskLog(taskId, `准备执行: docker push ${targetImage}`);
    await executeCommand(`docker push ${targetImage}`, taskId);

    updateTaskStatus(taskId, '完成', '镜像导入成功');
    addTaskLog(taskId, '本地导入完成');
    log('INFO', `镜像导入任务完成: ${taskId}`);
    
    // 成功后删除 tar 包
    try {
      if (fs.existsSync(tarPath)) {
        fs.unlinkSync(tarPath);
        log('INFO', `删除 tar 包: ${tarPath}`);
      }
    } catch (e) {
      log('WARN', `删除 tar 包失败: ${e.message}`);
    }
  } catch (error) {
    log('ERROR', `镜像导入任务失败: ${taskId}, 错误: ${error.message}`);
    addTaskLog(taskId, `本地导入失败: ${error.message}`);
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
        log('INFO', `Harbor 连接验证成功: ${result.version}`);
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
        log('INFO', `Harbor 连接验证成功: ${config.name} - ${result.version}`);
        sendJson(res, 200, { success: true, version: result.version });
      } else {
        log('ERROR', `Harbor 连接验证失败: ${config.name} - ${result.error}`);
        sendJson(res, 400, { success: false, error: result.error });
      }
      return;
    }

    if (req.method === 'POST' && pathname === '/api/images/sync') {
      if (harborConfigs.length === 0) {
        sendJson(res, 400, { error: '请先配置 Harbor 连接' });
        return;
      }

      const body = await parseJsonBody(req);
      const { sourceImage, targetRepo, targetProject } = body;
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
      const task = createTask('镜像同步', sourceImage, target);
      
      setImmediate(() => syncImage(task.id, sourceImage, targetProject, harborConfig));
      
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
        maxFileSize: 10 * 1024 * 1024 * 1024,
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
        const targetRepo = Array.isArray(targetRepoField) ? targetRepoField[0] : targetRepoField;
        const importProject = Array.isArray(importProjectField) ? importProjectField[0] : importProjectField;

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
        const task = createTask('本地导入', originalFilename, target);
        log('INFO', `创建镜像导入任务: ${task.id}, 文件: ${originalFilename}, 目标: ${target}`);
        addTaskLog(task.id, `创建本地导入任务，目标项目: ${importProject}`);
        
        setImmediate(() => loadAndPushTar(task.id, targetFilePath, importProject, harborConfig));

        sendJson(res, 200, { task });
      });
      return;
    }

    if (req.method === 'DELETE' && pathname.match(/^\/api\/tasks\/[a-z0-9]+$/)) {
      const taskId = pathname.split('/').pop();
      tasks = tasks.filter(t => t.id !== taskId);
      saveTasks();
      log('INFO', `删除任务: ${taskId}`);
      sendJson(res, 200, { message: '任务已删除' });
      return;
    }

    if (req.method === 'POST' && pathname.match(/^\/api\/tasks\/[a-z0-9]+\/retry$/)) {
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
          setImmediate(() => syncImage(taskId, task.source, targetProject, harborConfig));
        }
      } else if (task.type === '本地导入') {
        // 本地导入任务无法重新执行（因为 tar 包已删除）
        sendJson(res, 400, { error: '本地导入任务无法重新执行，tar 包已被删除' });
        return;
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

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

server.listen(PORT, '0.0.0.0', () => {
  log('INFO', `服务器启动成功，监听 http://0.0.0.0:${PORT}`);
});
