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
        log('ERROR', `Docker 登录失败: ${error.message}`);
        resolve({ success: false, error: '认证失败，请检查用户名和密码' });
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
        log('ERROR', `命令执行失败: ${error.message}`);
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
    updateTaskStatus(taskId, '失败', error.message);
    addTaskLog(taskId, `❌ 镜像同步失败: ${error.message}`);
  }
}

// 从 tar 包中提取 manifest.json 并解析镜像列表
async function extractManifestFromTar(tarPath) {
  return new Promise((resolve, reject) => {
    const extractDir = path.join(path.dirname(tarPath), 'temp_' + Date.now());
    fs.mkdirSync(extractDir, { recursive: true });
    
    // 解压 manifest.json
    exec(`tar -xf "${tarPath}" -C "${extractDir}" manifest.json`, (error) => {
      if (error) {
        // 可能是 .tar.gz 格式
        exec(`tar -xzf "${tarPath}" -C "${extractDir}" manifest.json`, (error2) => {
          if (error2) {
            fs.rmSync(extractDir, { recursive: true, force: true });
            reject(new Error('无法解压 manifest.json'));
            return;
          }
          readManifest(extractDir);
        });
        return;
      }
      readManifest(extractDir);
    });
    
    function readManifest(dir) {
      try {
        const manifestPath = path.join(dir, 'manifest.json');
        if (!fs.existsSync(manifestPath)) {
          fs.rmSync(dir, { recursive: true, force: true });
          reject(new Error('manifest.json 不存在'));
          return;
        }
        const content = fs.readFileSync(manifestPath, 'utf8');
        const manifest = JSON.parse(content);
        fs.rmSync(dir, { recursive: true, force: true });
        resolve(manifest);
      } catch (e) {
        fs.rmSync(dir, { recursive: true, force: true });
        reject(e);
      }
    }
  });
}

async function loadAndPushTar(taskId, tarPath, targetProject, harborConfig, arch = 'all') {
  try {
    const tarFileName = path.basename(tarPath);
    log('INFO', `镜像导入任务开始: ${taskId}, tar文件: ${tarFileName}`);
    addTaskLog(taskId, `本地导入开始，文件: ${tarFileName}`);

    // 尝试读取 manifest.json 获取镜像列表
    let images = [];
    try {
      addTaskLog(taskId, '正在读取 tar 包中的镜像列表...');
      const manifest = await extractManifestFromTar(tarPath);
      log('INFO', `manifest.json 内容: ${JSON.stringify(manifest)}`);
      
      // manifest.json 是一个数组，每个元素可能有多个 RepoTags
      images = manifest.map(item => item.RepoTags || []).flat().filter(tag => tag);
      
      log('INFO', `解析到 ${images.length} 个镜像: ${images.join(', ')}`);
      addTaskLog(taskId, `检测到 ${images.length} 个镜像: ${images.join(', ')}`);
    } catch (e) {
      log('WARN', `读取 manifest.json 失败: ${e.message}，将按单镜像处理`);
      addTaskLog(taskId, `读取镜像列表失败: ${e.message}，按单镜像处理`);
      // 回退到单镜像处理
      images = [path.basename(tarPath).replace(/\.tar(\.gz)?$/, '') + ':latest'];
    }

    // 检查 skopeo 是否可用
    const hasSkopeo = await checkSkopeo();

    if (hasSkopeo) {
      // 使用 skopeo 直接从 tar 包推送
      updateTaskStatus(taskId, '执行中', `使用 skopeo 推送 ${images.length} 个镜像 (架构: ${arch})`);
      addTaskLog(taskId, `使用 skopeo 推送，共 ${images.length} 个镜像`);
      
      // skopeo --multi-arch 支持 'all', 'system', 'index-only'
      const archOption = arch === 'all' ? '--multi-arch=all' : '--multi-arch=system';
      const harborHost = harborConfig.harborUrl.replace(/^https?:\/\//, '');
      
      // 逐个推送每个镜像
      for (let i = 0; i < images.length; i++) {
        const imageName = images[i];
        const imageTag = imageName.split(':').pop() || 'latest';
        const imageRepo = imageName.split(':')[0].split('/').pop();
        const targetImage = `${harborHost}/${targetProject}/${imageRepo}:${imageTag}`;
        
        addTaskLog(taskId, `[${i + 1}/${images.length}] 推送镜像: ${imageName} -> ${targetImage}`);
        
        // 使用 skopeo 从 docker-archive 推送单个镜像
        // 需要指定 docker-archive:tarPath:imageName 格式
        const skopeoCmd = `skopeo copy ${archOption} docker-archive:${tarPath}:${imageName} docker://${targetImage} --dest-creds ${harborConfig.username}:${harborConfig.password} --dest-tls-verify=false`;
        await executeCommand(skopeoCmd, taskId);
      }
    } else {
      // 降级使用 docker 命令
      log('WARN', 'skopeo 未安装，降级使用 docker 命令');
      addTaskLog(taskId, '警告: skopeo 未安装，使用 docker 命令');

      updateTaskStatus(taskId, '执行中', '加载本地镜像包');
      log('INFO', `执行 docker load -i ${tarFileName}`);
      addTaskLog(taskId, `准备执行: docker load -i ${tarFileName}`);
      await executeCommand(`docker load -i ${tarPath}`, taskId);
      addTaskLog(taskId, `成功加载 ${images.length} 个镜像`);

      updateTaskStatus(taskId, '执行中', '登录 Harbor 仓库');
      const harborHost = harborConfig.harborUrl.replace(/^https?:\/\//, '');
      await executeCommand(`docker login -u ${harborConfig.username} -p ${harborConfig.password} ${harborHost}`, taskId, true);

      // 逐个标记并推送每个镜像
      for (let i = 0; i < images.length; i++) {
        const imageName = images[i];
        const imageTag = imageName.split(':').pop() || 'latest';
        const imageRepo = imageName.split(':')[0].split('/').pop();
        const targetImage = `${harborHost}/${targetProject}/${imageRepo}:${imageTag}`;
        
        addTaskLog(taskId, `[${i + 1}/${images.length}] 标记并推送: ${imageName} -> ${targetImage}`);
        
        updateTaskStatus(taskId, '执行中', `推送镜像 ${i + 1}/${images.length}`);
        await executeCommand(`docker tag ${imageName} ${targetImage}`, taskId);
        await executeCommand(`docker push ${targetImage}`, taskId);
      }
    }

    updateTaskStatus(taskId, '完成', `镜像导入成功，共 ${images.length} 个镜像`);
    addTaskLog(taskId, `✅ 镜像导入成功完成，共 ${images.length} 个镜像`);
    log('INFO', `镜像导入任务成功完成: ${taskId}, 共 ${images.length} 个镜像`);
  } catch (error) {
    log('ERROR', `镜像导入任务失败: ${taskId}, 错误: ${error.message}`);
    addTaskLog(taskId, `❌ 本地导入失败: ${error.message}`);
    addTaskLog(taskId, 'tar 包已保留，可重新执行任务');
    updateTaskStatus(taskId, '失败', error.message);
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

    if (req.method === 'DELETE' && pathname.match(/^\/api\/tasks\/[a-z0-9]+$/)) {
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
      log('INFO', `删除任务: ${taskId}`);
      sendJson(res, 200, { message: '任务已删除', fileDeleted });
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
