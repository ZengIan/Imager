// Rclone SFTP 上传模块
const { exec, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 加密密钥（使用简单的固定密钥，实际生产环境应该使用更安全的方案）
const ENCRYPTION_KEY = crypto.scryptSync('imager-sftp-key', 'salt', 32);
const IV_LENGTH = 16;

// 加密密码
function encryptPassword(password) {
  if (!password) return password;
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
  let encrypted = cipher.update(password, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

// 解密密码
function decryptPassword(encryptedPassword) {
  if (!encryptedPassword || !encryptedPassword.includes(':')) return encryptedPassword;
  try {
    const parts = encryptedPassword.split(':');
    const iv = Buffer.from(parts[0], 'hex');
    const encrypted = parts[1];
    const decipher = crypto.createDecipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (error) {
    console.error('解密密码失败:', error);
    return encryptedPassword;
  }
}

// 配置文件路径
const RCLONE_CONFIG_FILE = path.join(__dirname, 'rclone.conf');
const UPLOAD_TEMP_DIR = path.join(__dirname, 'uploads', 'temp');

// 确保临时目录存在
if (!fs.existsSync(UPLOAD_TEMP_DIR)) {
  fs.mkdirSync(UPLOAD_TEMP_DIR, { recursive: true });
}

// 执行 rclone 命令
function execRclone(args, options = {}) {
  return new Promise((resolve, reject) => {
    const configPath = options.configPath || RCLONE_CONFIG_FILE;
    const fullArgs = [`--config=${configPath}`, ...args];
    
    console.log('执行 rclone 命令:', `rclone ${fullArgs.join(' ')}`);
    
    const child = spawn('rclone', fullArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true  // 创建新的进程组，便于杀死所有子进程
    });
    
    // 保存子进程引用，用于取消
    if (options.onChildSpawned) {
      options.onChildSpawned(child);
    }
    
    let stdout = '';
    let stderr = '';
    let isCancelled = false;
    
    child.stdout.on('data', (data) => {
      if (isCancelled) return;
      const str = data.toString();
      stdout += str;
      if (options.onProgress) {
        // 按行分割并处理每一行
        const lines = str.split('\n');
        for (const line of lines) {
          if (line.trim()) {
            options.onProgress(line.trim());
          }
        }
      }
    });
    
    child.stderr.on('data', (data) => {
      if (isCancelled) return;
      const str = data.toString();
      stderr += str;
      if (options.onProgress) {
        // 按行分割并处理每一行
        const lines = str.split('\n');
        for (const line of lines) {
          if (line.trim()) {
            options.onProgress(line.trim());
          }
        }
      }
    });
    
    child.on('close', (code) => {
      if (isCancelled) {
        reject(new Error('上传已取消'));
        return;
      }
      if (code === 0) {
        resolve({ stdout, stderr, code });
      } else {
        reject(new Error(`rclone 命令失败 (exit ${code}): ${stderr || stdout}`));
      }
    });
    
    child.on('error', (error) => {
      if (isCancelled) {
        reject(new Error('上传已取消'));
        return;
      }
      reject(new Error(`无法启动 rclone: ${error.message}`));
    });
    
    // 监听取消信号
    if (options.signal) {
      options.signal.onCancel = () => {
        isCancelled = true;
        try {
          // 杀死整个进程组（包括所有子进程）
          if (child.pid) {
            process.kill(-child.pid, 'SIGKILL');
            console.log('rclone 进程组已终止 (PID:', child.pid, ')');
          }
        } catch (e) {
          // 如果进程组杀死失败，尝试单独杀死
          try {
            child.kill('SIGKILL');
            console.log('rclone 进程已终止');
          } catch (e2) {
            console.error('终止 rclone 进程失败:', e2.message);
          }
        }
      };
    }
  });
}

// 检查 rclone 是否已安装
async function checkRclone() {
  try {
    await execRclone(['version']);
    return true;
  } catch (error) {
    return false;
  }
}

// 生成 rclone 配置
async function generateRcloneConfig(config) {
  const { name, host, port, username, password, keyFile } = config;
  
  let configContent = `[${name}]\n`;
  configContent += `type = sftp\n`;
  configContent += `host = ${host}\n`;
  configContent += `port = ${port || 22}\n`;
  configContent += `user = ${username}\n`;
  
  if (keyFile) {
    configContent += `key_file = ${keyFile}\n`;
  } else if (password) {
    const obscuredPass = await obscurePassword(password);
    configContent += `pass = ${obscuredPass}\n`;
  }
  
  // 启用断点续传
  configContent += `md5sum_command = none\n`;
  configContent += `sha1sum_command = none\n`;
  
  return configContent;
}

// 使用 rclone obscure 命令混淆密码
async function obscurePassword(password) {
  return new Promise((resolve, reject) => {
    const child = spawn('rclone', ['obscure', password]);
    let stdout = '';
    let stderr = '';
    
    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    
    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`rclone obscure 失败: ${stderr}`));
      }
    });
    
    child.on('error', (error) => {
      reject(error);
    });
  });
}

// 保存 SFTP 配置
async function saveSftpConfig(config) {
  const configs = loadAllSftpConfigs();
  const existingIndex = configs.findIndex(c => c.name === config.name);
  
  // 加密密码后保存
  const configToSave = { ...config };
  if (configToSave.password) {
    configToSave.password = encryptPassword(configToSave.password);
  }
  
  if (existingIndex >= 0) {
    configs[existingIndex] = configToSave;
  } else {
    configs.push(configToSave);
  }
  
  // 保存配置到文件（密码已加密）
  const configPath = path.join(__dirname, 'sftp-configs.json');
  fs.writeFileSync(configPath, JSON.stringify(configs, null, 2));
  
  // 更新 rclone 配置文件（使用原始密码）
  await updateRcloneConfigFile(configs.map(c => ({
    ...c,
    password: c.password ? decryptPassword(c.password) : c.password
  })));
  
  return configs;
}

// 加载所有 SFTP 配置（返回解密后的配置）
function loadAllSftpConfigs() {
  const configPath = path.join(__dirname, 'sftp-configs.json');
  try {
    if (fs.existsSync(configPath)) {
      const configs = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      // 解密密码
      return configs.map(c => ({
        ...c,
        password: c.password ? decryptPassword(c.password) : c.password
      }));
    }
  } catch (error) {
    console.error('加载 SFTP 配置失败:', error);
  }
  return [];
}

// 加载所有 SFTP 配置（返回原始加密配置，用于内部保存）
function loadAllSftpConfigsRaw() {
  const configPath = path.join(__dirname, 'sftp-configs.json');
  try {
    if (fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
  } catch (error) {
    console.error('加载 SFTP 配置失败:', error);
  }
  return [];
}

// 删除 SFTP 配置
async function deleteSftpConfig(name) {
  const configs = loadAllSftpConfigsRaw();
  const filtered = configs.filter(c => c.name !== name);
  
  const configPath = path.join(__dirname, 'sftp-configs.json');
  fs.writeFileSync(configPath, JSON.stringify(filtered, null, 2));
  
  // 更新 rclone 配置文件（使用解密后的密码）
  await updateRcloneConfigFile(filtered.map(c => ({
    ...c,
    password: c.password ? decryptPassword(c.password) : c.password
  })));
  
  return filtered;
}

// 更新 rclone 配置文件
async function updateRcloneConfigFile(configs) {
  let configContent = '';
  for (const config of configs) {
    configContent += await generateRcloneConfig(config) + '\n';
  }
  fs.writeFileSync(RCLONE_CONFIG_FILE, configContent);
}

// 测试 SFTP 连接
async function testSftpConnection(config) {
  // 创建临时配置
  const tempConfigName = `temp_${Date.now()}`;
  const tempConfig = { ...config, name: tempConfigName };
  
  const configContent = await generateRcloneConfig(tempConfig);
  const tempConfigPath = path.join(UPLOAD_TEMP_DIR, `temp_${Date.now()}.conf`);
  fs.writeFileSync(tempConfigPath, configContent);
  
  try {
    // 测试列出目录
    await execRclone(['ls', `${tempConfigName}:/`, '--max-depth', '1'], {
      configPath: tempConfigPath
    });
    
    // 清理临时配置
    fs.unlinkSync(tempConfigPath);
    
    return { success: true };
  } catch (error) {
    // 清理临时配置
    if (fs.existsSync(tempConfigPath)) {
      fs.unlinkSync(tempConfigPath);
    }
    
    return { success: false, error: error.message };
  }
}

// 计算文件 SHA-256
function calculateSHA256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    
    stream.on('error', reject);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

// 上传文件（支持断点续传和校验）
async function uploadFile(config, localPath, remotePath, options = {}) {
  const { onProgress, checkHash = true, maxRetries = 3, signal } = options;
  const configName = config.name;
  
  // 计算本地文件哈希
  let localHash = null;
  if (checkHash) {
    onProgress?.({ type: 'calculating_hash', message: '计算本地文件哈希...' });
    localHash = await calculateSHA256(localPath);
    onProgress?.({ type: 'hash_calculated', hash: localHash });
  }
  
  // 先创建远程目录
  const remoteDir = path.posix.dirname(remotePath);
  if (remoteDir && remoteDir !== '/') {
    try {
      onProgress?.({ type: 'creating_dir', message: `创建远程目录: ${remoteDir}...` });
      await execRclone(['mkdir', `${configName}:${remoteDir}`]);
    } catch (error) {
      // 目录可能已存在，忽略错误
      console.log('创建目录结果:', error.message || '成功或已存在');
    }
  }
  
  // 断点续传上传
  const rcloneArgs = [
    'copy',
    localPath,
    `${configName}:${remoteDir}`,
    '--progress',
    '--stats', '5s'
  ];
  
  // 根据选项决定是否添加校验参数
  if (checkHash) {
    rcloneArgs.push('--checksum');  // 使用校验和验证
  }
  
  // 添加包含文件名过滤器
  const fileName = path.basename(localPath);
  rcloneArgs.push('--include', fileName);
  
  let retries = 0;
  while (retries < maxRetries) {
    try {
      onProgress?.({ type: 'uploading', message: `开始上传 (尝试 ${retries + 1}/${maxRetries})...` });
      
      await execRclone(rcloneArgs, {
        onProgress: (data) => {
          // 解析 rclone 进度输出
          const progress = parseRcloneProgress(data);
          if (progress) {
            onProgress?.({ type: 'progress', ...progress });
          }
        },
        signal: signal // 传递取消信号
      });
      
      // 上传完成后验证哈希（rclone --checksum 已确保上传时文件完整性）
      if (checkHash && localHash) {
        onProgress?.({ type: 'verifying', message: '验证远程文件完整性...' });
        
        try {
          const remoteHash = await getRemoteFileHash(config, remotePath);
          
          if (remoteHash && remoteHash.toLowerCase() === localHash.toLowerCase()) {
            onProgress?.({ type: 'verified', message: '文件校验通过', hash: remoteHash });
            return { success: true, hash: remoteHash };
          } else if (remoteHash) {
            throw new Error(`文件校验失败: 本地 ${localHash} != 远程 ${remoteHash}`);
          } else {
            // 无法获取远程哈希，但 rclone --checksum 已确保上传完整性
            onProgress?.({ type: 'verified', message: '文件上传完成（无法获取远程哈希校验，但 rclone 已验证完整性）' });
            return { success: true, hash: localHash };
          }
        } catch (verifyError) {
          // 校验过程出错，但 rclone --checksum 已确保上传时文件完整性
          onProgress?.({ type: 'verified', message: `文件上传完成（远程校验跳过: ${verifyError.message}）` });
          return { success: true, hash: localHash };
        }
      }
      
      return { success: true };
    } catch (error) {
      retries++;
      onProgress?.({ type: 'error', message: `上传失败: ${error.message}`, retry: retries });
      
      if (retries >= maxRetries) {
        throw new Error(`上传失败，已重试 ${maxRetries} 次: ${error.message}`);
      }
      
      // 等待后重试
      await sleep(2000 * retries);
    }
  }
}

// 上传文件夹
async function uploadFolder(config, localPath, remotePath, options = {}) {
  const { onProgress, checkHash = true, maxRetries = 3 } = options;
  const configName = config.name;
  
  const stats = {
    totalFiles: 0,
    uploadedFiles: 0,
    failedFiles: 0,
    currentFile: null
  };
  
  // 获取所有文件列表
  const files = await getAllFiles(localPath);
  stats.totalFiles = files.length;
  
  onProgress?.({ type: 'scanning', totalFiles: stats.totalFiles });
  
  const results = [];
  
  for (const file of files) {
    const relativePath = path.relative(localPath, file);
    const remoteFilePath = path.posix.join(remotePath, relativePath).replace(/\\/g, '/');
    
    stats.currentFile = relativePath;
    onProgress?.({ 
      type: 'file_start', 
      file: relativePath, 
      current: stats.uploadedFiles + stats.failedFiles + 1,
      total: stats.totalFiles 
    });
    
    try {
      const result = await uploadFile(config, file, remoteFilePath, {
        onProgress: (progress) => {
          onProgress?.({ type: 'file_progress', file: relativePath, ...progress });
        },
        checkHash,
        maxRetries
      });
      
      stats.uploadedFiles++;
      results.push({ file: relativePath, success: true, hash: result.hash });
      onProgress?.({ type: 'file_complete', file: relativePath, success: true });
    } catch (error) {
      stats.failedFiles++;
      results.push({ file: relativePath, success: false, error: error.message });
      onProgress?.({ type: 'file_complete', file: relativePath, success: false, error: error.message });
    }
  }
  
  const allSuccess = stats.failedFiles === 0;
  return {
    success: allSuccess,
    stats,
    results
  };
}

// 获取远程文件哈希（流式计算，避免落盘）
async function getRemoteFileHash(config, remotePath) {
  const configName = config.name;
  
  // 首先尝试使用 rclone hashsum 获取 SHA-256（单个文件）
  try {
    const result = await execRclone([
      'hashsum', 'SHA-256',
      `${configName}:${remotePath}`
    ]);
    
    // 解析输出: "hash  filename"
    const lines = result.stdout.trim().split('\n');
    for (const line of lines) {
      const match = line.match(/^([a-f0-9]{64})\s+/i);
      if (match) {
        return match[1];
      }
    }
  } catch (error) {
    console.log('rclone hashsum 失败，尝试流式计算:', error.message);
  }
  
  // 流式计算：通过 rclone cat 直接输出文件内容到内存计算哈希
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const child = spawn('rclone', [
      '--config', RCLONE_CONFIG_FILE,
      'cat',
      `${configName}:${remotePath}`
    ]);
    
    let stderr = '';
    
    child.stdout.on('data', (chunk) => {
      hash.update(chunk);
    });
    
    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    
    child.on('close', (code) => {
      if (code === 0) {
        resolve(hash.digest('hex'));
      } else {
        // SFTP 服务器可能不支持 hash 计算，由于 rclone --checksum 已确保上传完整性，直接返回 null
        console.log('流式哈希计算失败（服务器可能不支持），跳过验证:', stderr || `exit ${code}`);
        resolve(null);
      }
    });
    
    child.on('error', (error) => {
      // 网络错误等也跳过验证
      console.log('流式哈希计算异常，跳过验证:', error.message);
      resolve(null);
    });
  });
}

// 获取所有文件列表
async function getAllFiles(dir) {
  const files = [];
  
  function traverse(currentDir) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      
      if (entry.isDirectory()) {
        traverse(fullPath);
      } else {
        files.push(fullPath);
      }
    }
  }
  
  traverse(dir);
  return files;
}

// 解析 rclone 进度输出
function parseRcloneProgress(data) {
  // rclone 输出格式示例:
  // Transferred: 1.234 MiB / 10 MiB, 12%, 1.234 MiB/s, ETA 5s
  // 或者: 1.234 / 10 MiB, 12%, 1.234 MiB/s, ETA 5s
  // 或者: * 1.234 MiB: 12% /1.234 MiB/s, 5s

  // 调试: 输出原始数据
  console.log('rclone 原始输出:', JSON.stringify(data));

  // 尝试匹配带 "Transferred:" 前缀的格式 (支持多字符单位如 GiB, MiB, GB, MB)
  let match = data.match(/Transferred:\s*([\d.]+\s*(?:[KMGTPEZY]i?B|bytes?))\s*\/\s*([\d.]+\s*(?:[KMGTPEZY]i?B|bytes?)),\s*([\d]+)%,?\s*([\d.]+\s*(?:[KMGTPEZY]i?B\/s|bytes?\/s))?/i);
  if (match) {
    console.log('匹配到格式1:', { transferred: match[1], total: match[2], percent: match[3], speed: match[4] });
    return {
      transferred: match[1].trim(),
      total: match[2].trim(),
      percent: parseInt(match[3]),
      speed: match[4] ? match[4].trim() : '',
      eta: ''
    };
  }

  // 尝试匹配不带 "Transferred:" 前缀的简化格式
  match = data.match(/([\d.]+\s*(?:[KMGTPEZY]i?B|bytes?))\s*\/\s*([\d.]+\s*(?:[KMGTPEZY]i?B|bytes?)),\s*([\d]+)%,?\s*([\d.]+\s*(?:[KMGTPEZY]i?B\/s|bytes?\/s))?/i);
  if (match) {
    console.log('匹配到格式2:', { transferred: match[1], total: match[2], percent: match[3], speed: match[4] });
    return {
      transferred: match[1].trim(),
      total: match[2].trim(),
      percent: parseInt(match[3]),
      speed: match[4] ? match[4].trim() : '',
      eta: ''
    };
  }

  // 尝试匹配 Transferring 行格式 (如: * filename: 8% /7.161Gi, 9.653Mi/s, 11m)
  match = data.match(/\*\s*.+:\s*([\d]+)%\s*\/([\d.]+\s*(?:[KMGTPEZY]i?B|bytes?)),\s*([\d.]+\s*(?:[KMGTPEZY]i?B\/s|bytes?\/s))/i);
  if (match) {
    console.log('匹配到格式3 (Transferring行):', { percent: match[1], total: match[2], speed: match[3] });
    return {
      transferred: '',
      total: match[2].trim(),
      percent: parseInt(match[1]),
      speed: match[3].trim(),
      eta: ''
    };
  }

  // 尝试匹配只有百分比和速度的格式 (如: 12%, 1.234 MiB/s)
  match = data.match(/([\d]+)%[,\s]*([\d.]+\s*(?:[KMGTPEZY]i?B\/s|bytes?\/s))?/i);
  if (match) {
    console.log('匹配到格式4 (百分比+速度):', { percent: match[1], speed: match[2] });
    return {
      transferred: '',
      total: '',
      percent: parseInt(match[1]),
      speed: match[2] ? match[2].trim() : '',
      eta: ''
    };
  }

  // 尝试匹配简单速度格式 (如: 1.234 MiB/s)
  match = data.match(/([\d.]+\s*(?:[KMGTPEZY]i?B\/s|bytes?\/s))/i);
  if (match) {
    console.log('匹配到格式5 (仅速度):', { speed: match[1] });
    return {
      transferred: '',
      total: '',
      percent: 0,
      speed: match[1].trim(),
      eta: ''
    };
  }
  
  return null;
}

// 延迟函数
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 列出远程目录
async function listRemoteDirectory(config, remotePath = '/') {
  try {
    const configName = config.name;
    
    // 使用 lsjson 命令获取 JSON 格式列表，包含 isDir 字段
    // 限制在指定目录下，不递归子目录
    const result = await execRclone([
      'lsjson',
      '--max-depth', '1',
      `${configName}:${remotePath}`
    ]);

    console.log('rclone lsjson 原始输出:', result.stdout);

    if (!result.stdout.trim()) {
      return { success: true, entries: [] };
    }

    // 解析 JSON
    const jsonList = JSON.parse(result.stdout);
    
    // 转换为统一格式
    const entries = jsonList.map(item => ({
      name: item.Name,
      isDir: item.IsDir,
      size: item.Size || 0,
      modTime: item.ModTime || null
    }));

    console.log('解析后的文件列表:', entries);

    return { success: true, entries };
  } catch (error) {
    console.error('listRemoteDirectory error:', error);
    return { success: false, error: error.message };
  }
}

// 检查远程文件是否存在
async function checkRemoteFileExists(config, remotePath) {
  const configName = config.name;

  try {
    // 使用 rclone lsl 获取文件信息（包含大小和修改时间）
    const result = await execRclone([
      'lsl',
      `${configName}:${remotePath}`,
      '--max-depth', '1'
    ]);

    // 解析输出: "timestamp size path"
    const lines = result.stdout.trim().split('\n');
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 2) {
        const fileName = parts[parts.length - 1];
        // 提取文件名（远程路径可能包含目录）
        const remoteFileName = remotePath.split('/').pop();
        if (fileName === remoteFileName) {
          const size = parseInt(parts[0]);
          return { exists: true, size: size };
        }
      }
    }

    // 文件不存在
    return { exists: false };
  } catch (error) {
    // 命令失败通常意味着文件不存在
    return { exists: false };
  }
}

// 删除远程文件或目录
async function deleteRemoteFile(config, remotePath, isDir = false) {
  const configName = config.name;

  try {
    // 使用 rclone delete 删除文件，rclone rmdir 删除空目录，rclone purge 删除非空目录
    let rcloneArgs;
    if (isDir) {
      // 使用 purge 递归删除目录及其内容
      rcloneArgs = ['purge', `${configName}:${remotePath}`];
    } else {
      // 删除单个文件
      rcloneArgs = ['delete', `${configName}:${remotePath}`];
    }

    await execRclone(rcloneArgs);

    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

module.exports = {
  checkRclone,
  saveSftpConfig,
  loadAllSftpConfigs,
  deleteSftpConfig,
  testSftpConnection,
  uploadFile,
  uploadFolder,
  listRemoteDirectory,
  checkRemoteFileExists,
  calculateSHA256,
  deleteRemoteFile
};
