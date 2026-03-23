let taskList, configStatus, verifyBtn, taskDetailCard, taskDetail, syncTargetRepo, uploadTargetRepo;
let createProjectModal, closeModalBtn, cancelCreateBtn, confirmCreateBtn, modalTargetRepo, modalProjectName, modalProjectVisibility;

let refreshInterval = null;
let harborRepos = [];

// 为指定仓库打开创建项目弹窗（必须在全局作用域供 HTML onclick 调用）
window.openCreateProjectModalForRepo = function(repoName) {
  if (!modalTargetRepo || !createProjectModal) {
    alert('弹窗元素未初始化，请刷新页面重试');
    console.error('弹窗元素未初始化');
    return;
  }
  
  // 同步仓库列表到弹窗，并预选指定仓库
  const options = '<option value="">请选择仓库</option>' + 
    harborRepos.map(repo => `<option value="${repo.name}" ${repo.name === repoName ? 'selected' : ''}>${repo.name}</option>`).join('');
  modalTargetRepo.innerHTML = options;
  
  modalProjectName.value = '';
  if (modalProjectVisibility) {
    modalProjectVisibility.value = 'private';
  }
  createProjectModal.classList.add('show');
};

// DOM 加载完成后初始化
document.addEventListener('DOMContentLoaded', function() {
  taskList = document.querySelector('#taskList');
  configStatus = document.querySelector('#configStatus');
  verifyBtn = document.querySelector('#verifyBtn');
  taskDetailCard = document.querySelector('#taskDetailCard');
  taskDetail = document.querySelector('#taskDetail');
  syncTargetRepo = document.querySelector('#syncTargetRepo');
  uploadTargetRepo = document.querySelector('#uploadTargetRepo');
  
  // 创建项目弹窗元素
  createProjectModal = document.querySelector('#createProjectModal');
  closeModalBtn = document.querySelector('#closeModalBtn');
  cancelCreateBtn = document.querySelector('#cancelCreateBtn');
  confirmCreateBtn = document.querySelector('#confirmCreateBtn');
  modalTargetRepo = document.querySelector('#modalTargetRepo');
  modalProjectName = document.querySelector('#modalProjectName');
  modalProjectVisibility = document.querySelector('#modalProjectVisibility');
  
  // 初始化事件绑定
  initEventListeners();
  
  // 加载数据
  loadHarborRepos();
  refreshTasks();
});

function renderTasks(tasks) {
  taskList.innerHTML = '';
  
  if (tasks.length === 0) {
    taskList.innerHTML = '<tr><td colspan="6" style="text-align: center; color: #6b7280;">暂无任务</td></tr>';
    return;
  }

  for (const task of tasks) {
    const tr = document.createElement('tr');
    const statusClass = getStatusClass(task.status);
    
    const isSuccess = task.status === '完成';
    const isFailed = task.status === '失败';
    const isSftpFile = task.type === 'sftp文件';
    const isModelDownload = task.type === '模型下载';
    
    // 本地导入任务显示目标项目时不带 tag
    const displayTarget = task.type === '本地导入' 
      ? task.target.replace(/:latest$/, '') 
      : task.target;
    
    tr.innerHTML = `
      <td>${task.time}</td>
      <td>${task.type}</td>
      <td style="max-width: 200px; overflow: hidden; text-overflow: ellipsis;">${task.source}</td>
      <td style="max-width: 200px; overflow: hidden; text-overflow: ellipsis;">${displayTarget}</td>
      <td class="col-status"><span class="status-badge ${statusClass}">${task.status}</span></td>
      <td class="col-action">
        <button class="btn-small btn-view" onclick="viewTask('${task.id}')">查看</button>
        ${!isSftpFile && !isModelDownload ? `<button class="btn-small btn-retry" onclick="retryTask('${task.id}')" ${isSuccess ? 'disabled' : ''}>重新执行</button>` : ''}
        <button class="btn-small btn-delete" onclick="deleteTask('${task.id}')">删除</button>
      </td>
    `;
    taskList.appendChild(tr);
  }
}

function getStatusClass(status) {
  switch (status) {
    case '完成': return 'success';
    case '失败': return 'error';
    case '执行中': return 'running';
    default: return 'pending';
  }
}

async function refreshTasks() {
  try {
    const res = await fetch('/api/tasks');
    const data = await res.json();
    renderTasks(data.tasks || []);

    // 检查是否有正在执行的 ModelScope 下载任务
    const msTask = data.tasks.find(t => t.type === '模型下载' && t.status === '执行中');
    if (msTask) {
      currentMsTaskId = msTask.id;
      const cancelBtn = document.getElementById('msCancelBtn');
      if (cancelBtn) {
        cancelBtn.style.display = 'inline-block';
        cancelBtn.textContent = '取消下载';
        cancelBtn.disabled = false;
      }
      const progressDiv = document.getElementById('modelscopeProgress');
      if (progressDiv) {
        progressDiv.style.display = 'block';
      }
    }
  } catch (error) {
    console.error('刷新任务失败:', error);
  }
}

async function loadHarborRepos() {
  try {
    const res = await fetch('/api/config');
    const data = await res.json();
    harborRepos = data.repos || [];
    
    const options = '<option value="">请选择仓库</option>' + 
      harborRepos.map(repo => `<option value="${repo.name}">${repo.name}</option>`).join('');
    
    syncTargetRepo.innerHTML = options;
    uploadTargetRepo.innerHTML = options;
    
    renderRepoList();
  } catch (error) {
    console.error('加载仓库列表失败:', error);
  }
}

function renderRepoList() {
  const repoList = document.querySelector('#repoList');
  if (!repoList) return;
  
  if (harborRepos.length === 0) {
    repoList.innerHTML = '<p style="color: var(--muted); font-size: 13px;">暂无已保存的仓库</p>';
    return;
  }
  
  repoList.innerHTML = harborRepos.map(repo => `
    <div class="repo-item">
      <div class="repo-info">
        <span class="repo-name">${repo.name}</span>
        <span class="repo-url">${repo.harborUrl}</span>
        <span class="repo-user">${repo.username}</span>
      </div>
      <div class="repo-actions">
        <button class="btn-small btn-verify" onclick="verifyRepo('${repo.name}')" id="verify-btn-${repo.name}">验证</button>
        <button class="btn-small btn-create-project" onclick="openCreateProjectModalForRepo('${repo.name}')">创建项目</button>
        <button class="btn-small btn-delete" onclick="deleteRepo('${repo.name}')">删除</button>
      </div>
    </div>
  `).join('');
}

window.verifyRepo = async function(repoName) {
  const btn = document.querySelector(`#verify-btn-${repoName}`);
  const originalText = btn.textContent;
  btn.textContent = '验证中...';
  btn.disabled = true;
  
  try {
    const res = await fetch('/api/harbor/verify-saved', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: repoName })
    });
    
    const data = await res.json();
    
    if (data.success) {
      configStatus.textContent = '验证成功！';
      configStatus.style.color = 'var(--success)';
    } else {
      configStatus.textContent = `验证失败：${data.error}`;
      configStatus.style.color = '#ef4444';
    }
  } catch (error) {
    configStatus.textContent = `验证失败：${error.message}`;
    configStatus.style.color = '#ef4444';
  } finally {
    btn.textContent = originalText;
    btn.disabled = false;
  }
};

window.deleteRepo = async function(repoName) {
  if (!confirm(`确定要删除仓库 "${repoName}" 吗？删除后将无法选择该仓库作为目标。`)) return;

  try {
    const res = await fetch(`/api/harbor/config/${encodeURIComponent(repoName)}`, {
      method: 'DELETE'
    });

    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || '删除失败');
    }

    configStatus.textContent = `仓库 "${repoName}" 已删除`;
    configStatus.style.color = 'var(--success)';
    await loadHarborRepos();
  } catch (error) {
    configStatus.textContent = `删除仓库失败：${error.message}`;
    configStatus.style.color = '#ef4444';
  }
};

async function request(url, payload) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || '请求失败');
  }
  return data;
}

async function verifyConnection() {
  const form = document.querySelector('#harborForm');
  const harborUrl = form.harborUrl.value.trim();
  const username = form.username.value.trim();
  const password = form.password.value.trim();

  if (!harborUrl || !username || !password) {
    configStatus.textContent = '请填写仓库地址、用户名和密码';
    configStatus.style.color = '#ef4444';
    return;
  }

  verifyBtn.disabled = true;
  verifyBtn.textContent = '验证中...';
  configStatus.textContent = '';
  configStatus.style.color = '';

  try {
    const result = await request('/api/harbor/verify', {
      harborUrl,
      username,
      password
    });
    configStatus.textContent = '验证成功！';
    configStatus.style.color = 'var(--success)';
  } catch (error) {
    configStatus.textContent = `验证失败：${error.message}`;
    configStatus.style.color = '#ef4444';
  } finally {
    verifyBtn.disabled = false;
    verifyBtn.textContent = '验证连接';
  }
}

// 事件监听已移至 initEventListeners 函数

window.currentTaskId = null;

window.viewTask = async function(taskId) {
  window.currentTaskId = taskId;
  await loadTaskDetail(taskId);
};

async function loadTaskDetail(taskId) {
  try {
    const res = await fetch('/api/tasks');
    const data = await res.json();
    const task = data.tasks.find(t => t.id === taskId);

    if (!task) {
      alert('任务不存在');
      return;
    }

    // 架构显示文本（仅镜像相关任务显示）
    const archText = task.arch === 'all' ? '多架构' : (task.arch === 'system' ? '系统自匹配' : (task.arch || '多架构'));
    const showArch = task.type === '镜像同步' || task.type === '本地导入';
    
    // 本地导入任务显示目标项目时不带 tag
    const displayTarget = task.type === '本地导入' 
      ? task.target.replace(/:latest$/, '') 
      : task.target;
    
    taskDetailCard.style.display = 'block';
    taskDetail.innerHTML = `
      <div class="task-info" style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px 24px;">
        <p><strong>任务 ID:</strong> ${task.id}</p>
        <p><strong>类型:</strong> ${task.type}</p>
        <p><strong>来源:</strong> ${task.source}</p>
        <p><strong>目标项目:</strong> ${displayTarget}</p>
        ${showArch ? `<p><strong>镜像架构:</strong> ${archText}</p>` : ''}
        <p><strong>状态:</strong> <span class="status-badge ${getStatusClass(task.status)}">${task.status}</span></p>
        <p style="grid-column: 1 / -1;"><strong>创建时间:</strong> ${task.time}</p>
      </div>
      <h3>执行日志 <button type="button" class="btn-refresh-small" onclick="refreshTaskDetail()" title="刷新">🔄</button></h3>
      <div class="task-logs">
        ${task.logs && task.logs.length > 0
          ? task.logs.map(log => `<div class="log-entry"><span class="log-time">${log.time}</span><span class="log-message">${log.message}</span></div>`).join('')
          : '<p style="color: #6b7280;">暂无日志</p>'
        }
      </div>
      <button onclick="closeTaskDetail()" class="btn-small" style="margin-top: 12px;">关闭</button>
    `;

    taskDetailCard.scrollIntoView({ behavior: 'smooth' });
  } catch (error) {
    alert('获取任务详情失败: ' + error.message);
  }
}

window.closeTaskDetail = function() {
  taskDetailCard.style.display = 'none';
};

window.refreshTaskDetail = async function() {
  if (window.currentTaskId) {
    await loadTaskDetail(window.currentTaskId);
    // 同时刷新任务列表
    await refreshTasks();
  }
};

window.retryTask = async function(taskId) {
  try {
    const res = await fetch(`/api/tasks/${taskId}/retry`, {
      method: 'POST'
    });
    
    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || '重新执行失败');
    }
    
    await refreshTasks();
  } catch (error) {
    alert('重新执行任务失败: ' + error.message);
  }
};

window.deleteTask = async function(taskId) {
  // 先获取任务信息
  const res = await fetch('/api/tasks');
  const data = await res.json();
  const task = data.tasks.find(t => t.id === taskId);
  
  // 如果删除的是当前正在下载的任务，隐藏进度区域和取消按钮
  if (taskId === currentMsTaskId) {
    document.getElementById('modelscopeProgress').style.display = 'none';
    document.getElementById('msCancelBtn').style.display = 'none';
    currentMsTaskId = null;
  }
  
  let confirmMsg = '确定要删除这个任务吗？';
  
  // 如果是已完成的本地导入任务，显示醒目警告
  if (task && task.type === '本地导入' && task.status === '完成') {
    confirmMsg = '⚠️ 警告：此任务为已完成的本地导入任务\n\n' +
                 '删除任务将同时删除已上传的 tar 文件！\n\n' +
                 '该操作不可恢复，是否继续删除？';
  }
  
  if (!confirm(confirmMsg)) return;

  try {
    const res = await fetch(`/api/tasks/${taskId}`, {
      method: 'DELETE'
    });

    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || '删除失败');
    }

    await refreshTasks();
    
    if (taskDetailCard.style.display === 'block') {
      closeTaskDetail();
    }
  } catch (error) {
    configStatus.textContent = `删除任务失败：${error.message}`;
    configStatus.style.color = '#ef4444';
  }
};

// 初始化事件监听
function initEventListeners() {
  if (verifyBtn) {
    verifyBtn.addEventListener('click', verifyConnection);
  }
  
  const harborForm = document.querySelector('#harborForm');
  if (harborForm) {
    harborForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const formData = new FormData(form);
      try {
        const result = await request('/api/harbor/config', {
          name: formData.get('repoName'),
          harborUrl: formData.get('harborUrl'),
          username: formData.get('username'),
          password: formData.get('password')
        });
        configStatus.textContent = `已保存仓库配置：${result.harbor}`;
        configStatus.style.color = 'var(--success)';
        form.reset();
        await loadHarborRepos();
      } catch (error) {
        configStatus.textContent = `保存失败：${error.message}`;
        configStatus.style.color = '#ef4444';
      }
    });
  }
  
  const syncForm = document.querySelector('#syncForm');
  if (syncForm) {
    syncForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const formData = new FormData(form);

      try {
        const result = await request('/api/images/sync', {
          sourceImage: formData.get('sourceImage'),
          targetRepo: formData.get('targetRepo'),
          targetProject: formData.get('targetProject'),
          arch: formData.get('arch') || 'all'
        });
        form.reset();
        await refreshTasks();
      } catch (error) {
        configStatus.textContent = `同步任务失败：${error.message}`;
        configStatus.style.color = '#ef4444';
      }
    });
  }
  
  const uploadForm = document.querySelector('#uploadForm');
  if (uploadForm) {
    uploadForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const formData = new FormData(form);
      const file = formData.get('imageTar');

      if (!(file instanceof File) || !file.name) {
        alert('请选择有效的 tar 包');
        return;
      }

      const submitButton = form.querySelector('button[type="submit"]');
      const uploadProgress = document.getElementById('uploadProgress');
      const progressBar = document.getElementById('progressBar');
      const progressText = document.getElementById('progressText');
      const progressSpeed = document.getElementById('progressSpeed');
      
      submitButton.disabled = true;
      submitButton.textContent = '上传中...';
      uploadProgress.style.display = 'block';
      progressBar.style.width = '0%';
      progressText.textContent = '准备上传...';
      progressSpeed.textContent = '';

      try {
        const uploadFormData = new FormData();
        uploadFormData.append('imageTar', file);
        uploadFormData.append('targetRepo', formData.get('targetRepo'));
        uploadFormData.append('importProject', formData.get('importProject'));
        uploadFormData.append('arch', formData.get('arch') || 'all');

        await new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          let lastLoaded = 0;
          let lastTime = Date.now();
          
          xhr.upload.addEventListener('progress', (e) => {
            if (e.lengthComputable) {
              const percent = Math.round((e.loaded / e.total) * 100);
              const loaded = (e.loaded / 1024 / 1024).toFixed(2);
              const total = (e.total / 1024 / 1024).toFixed(2);
              
              const now = Date.now();
              const timeDiff = (now - lastTime) / 1000;
              if (timeDiff > 0.5) {
                const bytesDiff = e.loaded - lastLoaded;
                const speed = bytesDiff / timeDiff / 1024 / 1024;
                progressSpeed.textContent = speed > 0 ? `${speed.toFixed(2)} MB/s` : '';
                lastLoaded = e.loaded;
                lastTime = now;
              }
              
              progressBar.style.width = percent + '%';
              progressText.textContent = `上传中: ${loaded} MB / ${total} MB (${percent}%)`;
            }
          });
          
          xhr.addEventListener('load', () => {
            if (xhr.status >= 200 && xhr.status < 300) {
              resolve(xhr.response);
            } else {
              reject(new Error('上传失败'));
            }
          });
          
          xhr.addEventListener('error', () => reject(new Error('上传出错')));
          xhr.addEventListener('abort', () => reject(new Error('上传已取消')));
          
          xhr.open('POST', '/api/images/upload');
          xhr.send(uploadFormData);
        });

        progressText.textContent = '上传完成，开始导入...';
        progressSpeed.textContent = '';
        form.reset();
        await refreshTasks();
      } catch (error) {
        console.error('上传失败:', error);
        progressText.textContent = '上传失败: ' + error.message;
        progressText.style.color = '#ef4444';
      } finally {
        submitButton.disabled = false;
        submitButton.textContent = '上传并导入';
        setTimeout(() => {
          uploadProgress.style.display = 'none';
          progressBar.style.width = '0%';
          progressText.style.color = '';
        }, 3000);
      }
    });
  }
  
  // 创建项目弹窗事件
  if (closeModalBtn) {
    closeModalBtn.addEventListener('click', closeCreateProjectModal);
  }
  if (cancelCreateBtn) {
    cancelCreateBtn.addEventListener('click', closeCreateProjectModal);
  }
  if (confirmCreateBtn) {
    confirmCreateBtn.addEventListener('click', createProject);
  }
  
  // 点击弹窗外部关闭
  window.addEventListener('click', (e) => {
    if (e.target === createProjectModal) {
      closeCreateProjectModal();
    }
  });
  
  // 回车键提交
  if (modalProjectName) {
    modalProjectName.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        createProject();
      }
    });
  }
}

async function loadServerLogs() {
  try {
    const res = await fetch('/api/logs');
    const data = await res.json();
    renderServerLogs(data.logs || []);
  } catch (error) {
    console.error('加载日志失败:', error);
  }
}

function renderServerLogs(logs) {
  const container = document.querySelector('#serverLogs');
  if (!container) return;
  
  if (logs.length === 0) {
    container.innerHTML = '<p style="color: #6b7280; text-align: center;">暂无日志</p>';
    return;
  }
  
  container.innerHTML = logs.map(log => {
    const isError = log.includes('[ERROR]');
    const color = isError ? '#ef4444' : '#6b7280';
    return `<div class="log-line" style="color: ${color};">${escapeHtml(log)}</div>`;
  }).join('');
  
  // 自动滚动到底部
  container.scrollTop = container.scrollHeight;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// 格式化文件大小（全局通用）
function formatSize(bytes) {
  if (bytes >= 1024 * 1024 * 1024) {
    return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  } else if (bytes >= 1024 * 1024) {
    return (bytes / 1024 / 1024).toFixed(2) + ' MB';
  } else if (bytes >= 1024) {
    return (bytes / 1024).toFixed(2) + ' KB';
  }
  return bytes + ' B';
}

// 获取文件状态显示文本
function getFileStatusText(status) {
  switch (status) {
    case 'waiting': return '等待中...';
    case 'pending': return '待传输';
    case 'uploading': return '上传中...';
    case 'completed': return '已完成';
    case 'failed': return '失败';
    default: return '等待中...';
  }
}

// 获取文件状态颜色
function getFileStatusColor(status) {
  switch (status) {
    case 'waiting': return '#9ca3af'; // 灰色
    case 'pending': return '#f59e0b'; // 橙色
    case 'uploading': return '#2563eb'; // 蓝色
    case 'completed': return '#10b981'; // 绿色
    case 'failed': return '#ef4444'; // 红色
    default: return '#9ca3af';
  }
}

// 打开弹窗
function openCreateProjectModal() {
  if (!modalTargetRepo || !createProjectModal) return;
  
  // 同步仓库列表到弹窗
  const options = '<option value="">请选择仓库</option>' + 
    harborRepos.map(repo => `<option value="${repo.name}">${repo.name}</option>`).join('');
  modalTargetRepo.innerHTML = options;
  
  modalProjectName.value = '';
  createProjectModal.classList.add('show');
}

// 关闭弹窗
function closeCreateProjectModal() {
  if (createProjectModal) {
    createProjectModal.classList.remove('show');
  }
}

// 创建项目
async function createProject() {
  if (!modalTargetRepo || !modalProjectName) return;
  
  const repoName = modalTargetRepo.value;
  const projectName = modalProjectName.value.trim().toLowerCase();
  const isPublic = modalProjectVisibility ? modalProjectVisibility.value === 'public' : false;
  
  if (!repoName) {
    alert('请选择目标仓库');
    return;
  }
  
  if (!projectName) {
    alert('请输入项目名称');
    return;
  }
  
  // 验证项目名称格式（Harbor 项目名规则）
  const projectNameRegex = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
  if (!projectNameRegex.test(projectName)) {
    alert('项目名称格式不正确\n\n只能包含小写字母、数字、下划线、中划线和点，且不能以特殊字符开头或结尾');
    return;
  }
  
  confirmCreateBtn.disabled = true;
  confirmCreateBtn.textContent = '创建中...';
  
  try {
    const res = await fetch('/api/harbor/project', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoName, projectName, isPublic })
    });
    
    const data = await res.json();
    
    if (!res.ok) {
      throw new Error(data.error || '创建失败');
    }
    
    const visibilityText = isPublic ? '公开' : '私有';
    alert(`项目 "${projectName}" (${visibilityText}) 创建成功！`);
    closeCreateProjectModal();
  } catch (error) {
    alert('创建项目失败：' + error.message);
  } finally {
    confirmCreateBtn.disabled = false;
    confirmCreateBtn.textContent = '创建';
  }
}

// ==================== SFTP 上传功能 ====================

// 检查 rclone 状态
async function checkRcloneStatus() {
  const statusEl = document.querySelector('#rcloneStatus');
  // 默认显示账号获取方式提示
  statusEl.textContent = '(账号获取：登录算力管理平台，右上角用户>账号安全>sftp配置)';
  statusEl.style.color = 'var(--muted)';
}

// 加载 SFTP 配置列表
async function loadSftpConfigs() {
  try {
    const res = await fetch('/api/sftp/configs');
    const data = await res.json();
    renderSftpConfigList(data.configs || []);
    updateSftpTargetSelect(data.configs || []);
  } catch (error) {
    console.error('加载 SFTP 配置失败:', error);
  }
}

// 渲染 SFTP 配置列表
function renderSftpConfigList(configs) {
  const container = document.querySelector('#sftpList');
  if (!container) return;
  
  if (configs.length === 0) {
    container.innerHTML = '<p style="color: var(--muted); font-size: 13px;">暂无已保存的 SFTP 配置</p>';
    return;
  }
  
  container.innerHTML = configs.map(config => `
    <div class="repo-item">
      <div class="repo-info">
        <span class="repo-name">${config.name}</span>
        <span class="repo-url">${config.host}:${config.port || 22}</span>
        <span class="repo-user">${config.username}</span>
      </div>
      <div class="repo-actions">
        <button class="btn-small btn-verify" onclick="testSftpConnection('${config.name}')">测试</button>
        <button class="btn-small btn-primary" onclick="openFileManager('${config.name}')">文件管理</button>
        <button class="btn-small btn-delete" onclick="deleteSftpConfig('${config.name}')">删除</button>
      </div>
    </div>
  `).join('');
}

// 更新 SFTP 目标选择下拉框
function updateSftpTargetSelect(configs) {
  const select = document.querySelector('#sftpTargetConfig');
  if (!select) return;
  
  const options = '<option value="">请选择 SFTP 配置</option>' + 
    configs.map(c => `<option value="${c.name}">${c.name} (${c.host})</option>`).join('');
  select.innerHTML = options;
}

// 测试 SFTP 连接
window.testSftpConnection = async function(configName) {
  const statusEl = document.querySelector('#sftpConfigStatus');
  
  statusEl.textContent = '测试中...';
  statusEl.style.color = '';
  
  // 设置超时（10秒）
  const timeoutMs = 10000;
  const timeoutId = setTimeout(() => {
    statusEl.textContent = '连接失败：请求超时，请检查服务器地址和端口';
    statusEl.style.color = '#ef4444';
  }, timeoutMs);
  
  try {
    let res;
    
    if (configName) {
      // 测试已保存的配置 - 使用专门的接口（包含真实密码）
      res = await fetch(`/api/sftp/test/${encodeURIComponent(configName)}`);
    } else {
      // 测试表单中的配置
      const form = document.querySelector('#sftpConfigForm');
      const config = {
        host: form.sftpHost.value,
        port: parseInt(form.sftpPort.value) || 22,
        username: form.sftpUsername.value,
        password: form.sftpPassword.value
      };
      
      res = await fetch('/api/sftp/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config)
      });
    }
    
    // 请求成功，清除超时
    clearTimeout(timeoutId);
    
    const data = await res.json();
    
    if (data.success) {
      statusEl.textContent = '连接成功！';
      statusEl.style.color = 'var(--success)';
    } else {
      statusEl.textContent = `连接失败：${data.error}`;
      statusEl.style.color = '#ef4444';
    }
  } catch (error) {
    // 发生错误，清除超时
    clearTimeout(timeoutId);
    
    statusEl.textContent = `测试失败：${error.message}`;
    statusEl.style.color = '#ef4444';
  }
};

// 删除 SFTP 配置
window.deleteSftpConfig = async function(configName) {
  if (!confirm(`确定要删除 SFTP 配置 "${configName}" 吗？`)) return;
  
  try {
    const res = await fetch(`/api/sftp/config/${encodeURIComponent(configName)}`, {
      method: 'DELETE'
    });
    
    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || '删除失败');
    }
    
    await loadSftpConfigs();
  } catch (error) {
    alert('删除失败：' + error.message);
  }
};

// ==================== 文件管理功能 ====================

let currentFileManagerConfig = null;
let currentFileManagerPath = '/';

// 打开文件管理器
window.openFileManager = async function(configName) {
  currentFileManagerConfig = configName;
  currentFileManagerPath = '/';

  const modal = document.querySelector('#fileManagerModal');
  const title = document.querySelector('#fileManagerTitle');
  const pathEl = document.querySelector('#fileManagerPath');

  if (title) title.textContent = configName;
  if (pathEl) pathEl.textContent = '/';
  if (modal) modal.style.display = 'flex';

  await loadFileList();
};

// 关闭文件管理器
window.closeFileManager = function() {
  const modal = document.querySelector('#fileManagerModal');
  if (modal) modal.style.display = 'none';
  currentFileManagerConfig = null;
  currentFileManagerPath = '/';
};

// 加载文件列表
async function loadFileList() {
  const listEl = document.querySelector('#fileManagerList');
  if (!listEl) return;

  listEl.innerHTML = '<div style="padding: 20px; text-align: center; color: #9ca3af;">加载中...</div>';

  try {
    const res = await fetch('/api/sftp/list', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        configName: currentFileManagerConfig,
        remotePath: currentFileManagerPath
      })
    });

    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || '加载失败');
    }

    renderFileList(data.entries || []);
  } catch (error) {
    listEl.innerHTML = `<div style="padding: 20px; text-align: center; color: #ef4444;">加载失败: ${error.message}</div>`;
  }
}

// 渲染文件列表
function renderFileList(entries) {
  const listEl = document.querySelector('#fileManagerList');

  if (entries.length === 0) {
    listEl.innerHTML = '<div style="padding: 20px; text-align: center; color: #9ca3af;">目录为空</div>';
    return;
  }

  // 排序：目录在前，文件在后
  entries.sort((a, b) => {
    if (a.isDir && !b.isDir) return -1;
    if (!a.isDir && b.isDir) return 1;
    return a.name.localeCompare(b.name);
  });

  listEl.innerHTML = entries.map(entry => {
    const icon = entry.isDir ? '📁' : '📄';
    const size = entry.isDir ? '' : formatSize(entry.size || 0);
    const time = entry.modTime ? new Date(entry.modTime).toLocaleString('zh-CN') : '';
    const rowStyle = entry.isDir ? 'cursor: pointer; background: #fefce8;' : 'cursor: default;';
    const safeName = entry.name.replace(/'/g, "\\'").replace(/"/g, '\\"');

    return `
      <div class="file-item" style="display: flex; align-items: center; padding: 10px 12px; border-bottom: 1px solid #f3f4f6; ${rowStyle}" ${entry.isDir ? `onclick="navigateToDir('${safeName}')"` : ''}>
        <span style="font-size: 18px; margin-right: 10px;">${icon}</span>
        <span style="flex: 1; font-size: 13px; color: #374151; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(entry.name)}</span>
        <span style="font-size: 12px; color: #9ca3af; width: 100px; text-align: right; margin-right: 12px;">${size}</span>
        <span style="font-size: 11px; color: #9ca3af; width: 140px;">${time}</span>
        <button class="btn-small btn-delete" onclick="event.stopPropagation(); deleteRemoteFile('${safeName}', ${entry.isDir})" style="padding: 2px 8px;">删除</button>
      </div>
    `;
  }).join('');
}

// 刷新文件列表
window.refreshFileList = async function() {
  await loadFileList();
};

// 导航到目录
window.navigateToDir = async function(dirName) {
  if (currentFileManagerPath === '/') {
    currentFileManagerPath = '/' + dirName;
  } else {
    currentFileManagerPath = currentFileManagerPath + '/' + dirName;
  }

  const pathEl = document.querySelector('#fileManagerPath');
  if (pathEl) pathEl.textContent = currentFileManagerPath;

  await loadFileList();
};

// 返回上级目录
window.goBackDir = async function() {
  if (currentFileManagerPath === '/') return;

  const parts = currentFileManagerPath.split('/');
  parts.pop();
  currentFileManagerPath = parts.length === 1 ? '/' : parts.join('/');

  const pathEl = document.querySelector('#fileManagerPath');
  if (pathEl) pathEl.textContent = currentFileManagerPath;

  await loadFileList();
};

// 删除远程文件
window.deleteRemoteFile = async function(fileName, isDir) {
  const type = isDir ? '目录' : '文件';
  if (!confirm(`确定要删除${type} "${fileName}" 吗？${isDir ? '\n注意：将删除目录内所有文件！' : ''}`)) return;

  const remotePath = currentFileManagerPath === '/' ? '/' + fileName : currentFileManagerPath + '/' + fileName;

  try {
    const res = await fetch('/api/sftp/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        configName: currentFileManagerConfig,
        remotePath: remotePath,
        isDir: isDir
      })
    });

    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || '删除失败');
    }

    await loadFileList();
  } catch (error) {
    alert('删除失败: ' + error.message);
  }
};

// 初始化 SFTP 功能
document.addEventListener('DOMContentLoaded', function() {
  // 检查 rclone 状态
  checkRcloneStatus();
  
  // 加载 SFTP 配置
  loadSftpConfigs();
  
  // 检查是否有未完成的 SFTP 上传任务
  restoreSftpUploadTask();
  
  // 测试连接按钮
  const testBtn = document.querySelector('#testSftpBtn');
  if (testBtn) {
    testBtn.addEventListener('click', () => testSftpConnection());
  }
  
  // SFTP 配置表单提交
  const sftpConfigForm = document.querySelector('#sftpConfigForm');
  if (sftpConfigForm) {
    sftpConfigForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const formData = new FormData(form);
      
      const statusEl = document.querySelector('#sftpConfigStatus');
      
      try {
        const res = await fetch('/api/sftp/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: formData.get('sftpName'),
            host: formData.get('sftpHost'),
            port: parseInt(formData.get('sftpPort')) || 22,
            username: formData.get('sftpUsername'),
            password: formData.get('sftpPassword')
          })
        });
        
        const data = await res.json();
        
        if (!res.ok) {
          throw new Error(data.error || '保存失败');
        }
        
        statusEl.textContent = `配置 "${data.config.name}" 已保存`;
        statusEl.style.color = 'var(--success)';
        form.reset();
        await loadSftpConfigs();
      } catch (error) {
        statusEl.textContent = `保存失败：${error.message}`;
        statusEl.style.color = '#ef4444';
      }
    });
  }
  
  // SFTP 上传表单提交
  const sftpUploadForm = document.querySelector('#sftpUploadForm');
  const sftpFileBtn = document.querySelector('#sftpFileBtn');
  const sftpFolderBtn = document.querySelector('#sftpFolderBtn');
  const sftpFileInput = document.querySelector('#sftpFileInput');
  const sftpFolderInput = document.querySelector('#sftpFolderInput');
  
  // 当前选择的文件列表
  let selectedFiles = [];
  let uploadMode = 'file'; // 'file' 或 'folder'
  
  // 点击卡片切换模式并触发文件选择
  if (sftpFileBtn && sftpFolderBtn) {
    sftpFileBtn.addEventListener('click', (e) => {
      if (e.target.tagName !== 'INPUT') {
        uploadMode = 'file';
        sftpFileBtn.style.borderColor = '#2563eb';
        sftpFolderBtn.style.borderColor = '#e5e7eb';
        sftpFileInput.click();
      }
    });
    
    sftpFolderBtn.addEventListener('click', (e) => {
      if (e.target.tagName !== 'INPUT') {
        uploadMode = 'folder';
        sftpFolderBtn.style.borderColor = '#2563eb';
        sftpFileBtn.style.borderColor = '#e5e7eb';
        sftpFolderInput.click();
      }
    });
  }
  
  // 文件选择变化
  if (sftpFileInput) {
    sftpFileInput.addEventListener('change', () => {
      selectedFiles = Array.from(sftpFileInput.files);
      saveFileSelection();
      updateFileSelectionDisplay();
    });
  }
  
  if (sftpFolderInput) {
    sftpFolderInput.addEventListener('change', () => {
      selectedFiles = Array.from(sftpFolderInput.files);
      saveFileSelection();
      updateFileSelectionDisplay();
    });
  }
  
  // 保存文件选择信息到 localStorage
  function saveFileSelection() {
    if (selectedFiles.length === 0) {
      localStorage.removeItem('sftpFileSelection');
      return;
    }
    const fileInfo = {
      mode: uploadMode,
      count: selectedFiles.length,
      files: selectedFiles.map(f => ({
        name: f.name,
        size: f.size,
        path: f.webkitRelativePath || f.name
      }))
    };
    localStorage.setItem('sftpFileSelection', JSON.stringify(fileInfo));
  }
  
  // 从 localStorage 恢复文件选择显示
  function restoreFileSelection() {
    const saved = localStorage.getItem('sftpFileSelection');
    if (!saved) return;
    
    try {
      const fileInfo = JSON.parse(saved);
      uploadMode = fileInfo.mode || 'file';
      
      // 恢复卡片边框样式
      if (uploadMode === 'folder') {
        sftpFolderBtn.style.borderColor = '#2563eb';
        sftpFileBtn.style.borderColor = '#e5e7eb';
      } else {
        sftpFileBtn.style.borderColor = '#2563eb';
        sftpFolderBtn.style.borderColor = '#e5e7eb';
      }
      
      // 显示文件选择提示（需要重新选择文件）
      const fileDisplayEl = document.querySelector('#sftpFileSelectionDisplayFile');
      const folderDisplayEl = document.querySelector('#sftpFileSelectionDisplayFolder');
      
      if (uploadMode === 'folder' && folderDisplayEl) {
        const folderName = fileInfo.files[0]?.path?.split('/')[0] || '文件夹';
        folderDisplayEl.innerHTML = `<span style="color: #f59e0b;">⚠️ 请重新选择: ${folderName} (${fileInfo.count} 个文件)</span>`;
      } else if (fileDisplayEl) {
        fileDisplayEl.innerHTML = `<span style="color: #f59e0b;">⚠️ 请重新选择: ${fileInfo.count} 个文件</span>`;
      }
    } catch (e) {
      console.error('恢复文件选择失败:', e);
    }
  }
  
  // 更新已选文件显示
  function updateFileSelectionDisplay() {
    const fileDisplayEl = document.querySelector('#sftpFileSelectionDisplayFile');
    const folderDisplayEl = document.querySelector('#sftpFileSelectionDisplayFolder');
    
    // 清空两个显示区域
    if (fileDisplayEl) fileDisplayEl.textContent = '';
    if (folderDisplayEl) folderDisplayEl.textContent = '';
    
    if (selectedFiles.length === 0) {
      return;
    }
    
    if (uploadMode === 'folder') {
      const folderName = selectedFiles[0]?.webkitRelativePath?.split('/')[0] || '文件夹';
      if (folderDisplayEl) {
        folderDisplayEl.textContent = `已选择: ${folderName} (${selectedFiles.length} 个文件)`;
      }
    } else {
      if (fileDisplayEl) {
        fileDisplayEl.textContent = `已选择: ${selectedFiles.length} 个文件`;
      }
    }
  }
  
  // 页面加载时恢复文件选择显示
  restoreFileSelection();
  
  if (sftpUploadForm) {
    sftpUploadForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      
      const configSelect = document.querySelector('#sftpTargetConfig');
      const remotePath = document.querySelector('#sftpRemotePath').value;
      const verifyHash = document.querySelector('#sftpVerifyHash').checked;
      
      if (selectedFiles.length === 0) {
        alert('请先点击上方卡片选择文件或文件夹');
        return;
      }
      
      if (!configSelect.value) {
        alert('请选择 SFTP 配置');
        return;
      }
      
      // 执行上传
      await uploadFilesToSftp(selectedFiles, configSelect.value, remotePath, verifyHash);
    });
  }
});

    // 当前上传任务ID
let currentSftpTaskId = null;
let isSftpUploadCancelled = false;
let isBrowserUploading = false; // 标记是否在浏览器上传阶段

// 更新文件进度条下方的SFTP日志
function updateFileProgressLogs(logs, files) {
  if (!files || !logs) {
    return;
  }
  
  // 获取所有文件名称和对应的索引
  const fileNameMap = new Map();
  files.forEach((file, idx) => {
    fileNameMap.set(file.name, idx);
  });
  
  // 为每个文件收集相关日志
  const fileLogs = new Map();
  logs.forEach(log => {
    // 日志格式: [时间] [序号/总数] 操作: 文件名
    // 提取序号和文件名，格式如: [1/5] 开始上传: devtools1230.tar.gz
    const match = log.match(/\[(\d+)\/(\d+)\]\s+([^:]+):\s*(.+?)(?:\s+\(|$)/);
    if (match) {
      const fileIndex = parseInt(match[1]) - 1; // 转换为0-based索引
      const totalFiles = parseInt(match[2]);
      const operation = match[3].trim();
      const fileName = match[4].trim();
      
      if (!fileLogs.has(fileIndex)) {
        fileLogs.set(fileIndex, []);
      }
      fileLogs.get(fileIndex).push(log);
    }
  });
  
  // 将日志显示到对应的文件进度条下方
  fileLogs.forEach((logs, fileIndex) => {
    // 尝试两种可能的元素ID（正常上传和恢复场景）
    let fileProgressEl = document.querySelector(`#file-progress-${fileIndex}`);
    if (!fileProgressEl) {
      fileProgressEl = document.querySelector(`#file-progress-item-${fileIndex}`);
    }
    if (fileProgressEl) {
      // 检查是否已有日志容器
      let logEl = fileProgressEl.querySelector('.file-sftp-log');
      if (!logEl) {
        logEl = document.createElement('div');
        logEl.className = 'file-sftp-log';
        logEl.style.cssText = 'margin-top: 4px; padding: 4px 8px; background: #f0f9ff; border-radius: 4px; font-size: 11px; color: #0369a1; border-left: 3px solid #0ea5e9;';
        fileProgressEl.appendChild(logEl);
      }
      // 显示最近2条日志
      const recentLogs = logs.slice(-2);
      logEl.innerHTML = recentLogs.map(log => {
        // 简化日志显示，去掉时间戳和序号，只保留操作和文件名
        const simplifiedLog = log.replace(/^\[\d{2}:\d{2}:\d{2}\]\s*\[\d+\/\d+\]\s*/, '');
        return `<div style="margin: 2px 0;">${escapeHtml(simplifiedLog)}</div>`;
      }).join('');
    }
  });
}

// 恢复未完成的 SFTP 上传任务
async function restoreSftpUploadTask() {
  const savedTaskId = localStorage.getItem('sftpUploadTaskId');
  if (!savedTaskId) return;
  
  try {
    // 先检查任务列表中的状态（避免 404 错误）
    const tasksRes = await fetch('/api/tasks');
    if (tasksRes.ok) {
      const tasksData = await tasksRes.json();
      const task = tasksData.tasks.find(t => t.id === savedTaskId);
      if (task && (task.status === '完成' || task.status === '失败')) {
        // 任务已完成/失败，清除 localStorage
        localStorage.removeItem('sftpUploadTaskId');
        localStorage.removeItem(`sftpUploadFiles_${savedTaskId}`);
        localStorage.removeItem('sftpFileSelection');
        return;
      }
    }
    
    // 检查任务状态
    const res = await fetch(`/api/sftp/upload-status/${savedTaskId}`);
    if (!res.ok) {
      localStorage.removeItem('sftpUploadTaskId');
      return;
    }
    
    const data = await res.json();
    
    // 如果任务已完成或失败，清除保存的 ID 和文件信息
    if (data.status === 'completed' || data.status === 'failed' || data.status === 'cancelled') {
      localStorage.removeItem('sftpUploadTaskId');
      localStorage.removeItem(`sftpUploadFiles_${savedTaskId}`);
      localStorage.removeItem('sftpFileSelection');
      return;
    }
    
    // 如果是浏览器上传阶段（文件未完全上传），尝试恢复上传状态
    if (data.phase === 'browser-upload') {
      // 检查是否有保存的文件列表
      const savedFilesInfo = localStorage.getItem(`sftpUploadFiles_${savedTaskId}`);
      if (savedFilesInfo) {
        try {
          const filesInfo = JSON.parse(savedFilesInfo);
          await restoreBrowserUpload(savedTaskId, filesInfo, data);
          
          // 即使处于 browser-upload 阶段，也启动轮询
          const progressDiv = document.querySelector('#sftpUploadProgress');
          const progressText = document.querySelector('#sftpProgressText');
          const progressPercent = document.querySelector('#sftpProgressPercent');
          const progressBar = document.querySelector('#sftpProgressBar');
          const progressDetails = document.querySelector('#sftpProgressDetails');
          const cancelBtn = document.querySelector('#sftpCancelBtn');
          
          if (progressDiv && progressDiv.style.display === 'block') {
            currentSftpTaskId = savedTaskId;
            let filesForPolling = null;
            const savedFilesForPoll = localStorage.getItem(`sftpUploadFiles_${savedTaskId}`);
            if (savedFilesForPoll) {
              try {
                const filesInfoForPoll = JSON.parse(savedFilesForPoll);
                filesForPolling = filesInfoForPoll.files || null;
              } catch (e) {}
            }
            setTimeout(() => {
              pollSftpUploadStatus(savedTaskId, progressText, progressPercent, progressBar, progressDetails, cancelBtn, filesForPolling);
            }, 1000);
          }
          return;
        } catch (e) {
          console.error('恢复浏览器上传状态失败:', e);
        }
      }
      // 没有保存的文件信息，清除任务ID
      localStorage.removeItem('sftpUploadTaskId');
      return;
    }
    
    // 任务还在进行中（服务器端上传阶段），恢复显示
    const progressDiv = document.querySelector('#sftpUploadProgress');
    const progressText = document.querySelector('#sftpProgressText');
    const progressPercent = document.querySelector('#sftpProgressPercent');
    const progressBar = document.querySelector('#sftpProgressBar');
    const progressDetails = document.querySelector('#sftpProgressDetails');
    const cancelBtn = document.querySelector('#sftpCancelBtn');
    const fileProgressList = document.querySelector('#sftpFileProgressList');
    
    if (progressDiv) {
      progressDiv.style.display = 'block';
      progressText.textContent = `恢复任务: ${data.message || '上传中...'}`;
      progressText.style.color = '#2563eb';
      
      if (data.progress !== undefined) {
        progressBar.style.width = data.progress + '%';
        progressPercent.textContent = data.progress + '%';
      }
      
      // 恢复文件进度列表 - 合并 localStorage 和后端返回的文件状态
      if (fileProgressList) {
        // 从 localStorage 获取原始文件列表
        let allFiles = [];
        const savedFilesInfo = localStorage.getItem(`sftpUploadFiles_${savedTaskId}`);
        if (savedFilesInfo) {
          try {
            const filesInfo = JSON.parse(savedFilesInfo);
            allFiles = filesInfo.files || [];
          } catch (e) {}
        }
        
        // 创建后端文件状态映射
        const backendFileStatus = {};
        if (data.files && data.files.length > 0) {
          data.files.forEach(f => {
            backendFileStatus[f.name] = f;
          });
        }
        
        // 合并文件列表状态
        if (allFiles.length > 0) {
          let html = allFiles.map((f, idx) => {
            const backendStatus = backendFileStatus[f.name];
            let status = 'waiting';
            let percent = 0;
            
            if (backendStatus) {
              // 使用后端返回的状态
              status = backendStatus.status;
              percent = backendStatus.percent;
            } else {
              // 后端没有这个文件，说明上传被中断了
              status = 'pending';
              percent = 0;
            }
            
            return `
            <div id="file-progress-item-${idx}" style="padding: 8px; border-bottom: 1px solid #e5e7eb;">
              <div style="display: flex; justify-content: space-between; align-items: center;">
                <span style="font-size: 13px; color: #374151;">${escapeHtml(f.name)}</span>
                <span id="file-progress-status-${idx}" style="font-size: 12px; color: ${getFileStatusColor(status)};">${getFileStatusText(status)}${status === 'pending' ? ' (需要重新上传)' : ''}</span>
              </div>
              <div style="margin-top: 4px; display: flex; justify-content: space-between; align-items: center;">
                <span id="file-progress-size-${idx}" style="font-size: 11px; color: #9ca3af;">${formatSize(f.size)}</span>
                <span id="file-progress-percent-${idx}" style="font-size: 11px; color: #6b7280;">${percent > 0 ? percent + '%' : ''}</span>
              </div>
              <div style="width: 100%; height: 3px; background: #e5e7eb; border-radius: 2px; margin-top: 4px; overflow: hidden;">
                <div id="file-progress-bar-${idx}" style="width: ${percent}%; height: 100%; background: ${getFileStatusColor(status)}; transition: width 0.3s;"></div>
              </div>
            </div>
          `}).join('');
          fileProgressList.innerHTML = html;
        } else {
          fileProgressList.innerHTML = `<div style="padding: 8px; color: #6b7280; font-size: 12px; text-align: center;">正在处理 ${data.uploadedFiles || 0}/${data.totalFiles || 0} 个文件</div>`;
        }
      }
      
      // 显示取消按钮并绑定事件
      if (cancelBtn) {
        cancelBtn.style.display = 'inline-block';
        cancelBtn.textContent = '取消上传';
        cancelBtn.disabled = false;
        
        cancelBtn.onclick = async () => {
          if (isSftpUploadCancelled) return;
          isSftpUploadCancelled = true;
          cancelBtn.textContent = '正在取消...';
          cancelBtn.disabled = true;
          
          try {
            await fetch(`/api/sftp/upload-cancel/${currentSftpTaskId}`, { method: 'POST' });
            // 无论成功还是404，都更新状态
            progressText.textContent = '已取消';
            progressText.style.color = '#f59e0b';
          } catch (error) {
            console.error('取消上传失败:', error);
            progressText.textContent = '已取消';
            progressText.style.color = '#f59e0b';
          }
        };
      }
      
      // 继续轮询
      currentSftpTaskId = savedTaskId;
      let filesForPolling = null;
      const savedFilesForPoll = localStorage.getItem(`sftpUploadFiles_${savedTaskId}`);
      if (savedFilesForPoll) {
        try {
          const filesInfoForPoll = JSON.parse(savedFilesForPoll);
          filesForPolling = filesInfoForPoll.files || null;
        } catch (e) {}
      }
      await pollSftpUploadStatus(savedTaskId, progressText, progressPercent, progressBar, progressDetails, cancelBtn, filesForPolling);
    }
  } catch (error) {
    console.error('恢复任务失败:', error);
    localStorage.removeItem('sftpUploadTaskId');
    localStorage.removeItem(`sftpUploadFiles_${savedTaskId}`);
    localStorage.removeItem('sftpFileSelection');
  }
}

// 恢复浏览器上传状态
async function restoreBrowserUpload(taskId, filesInfo, taskData) {
  const { configName, remotePath, verifyHash, files } = filesInfo;
  
  // 显示恢复提示
  const progressDiv = document.querySelector('#sftpUploadProgress');
  const progressText = document.querySelector('#sftpProgressText');
  const progressPercent = document.querySelector('#sftpProgressPercent');
  const progressBar = document.querySelector('#sftpProgressBar');
  const cancelBtn = document.querySelector('#sftpCancelBtn');
  const fileProgressList = document.querySelector('#sftpFileProgressList');
  
  if (progressDiv) {
    progressDiv.style.display = 'block';
    progressText.textContent = `恢复上传任务...`;
    progressText.style.color = '#2563eb';
    
    // 显示文件列表（仅文件名，无法恢复实际文件内容）
    if (fileProgressList && files) {
      fileProgressList.innerHTML = files.map((f, idx) => `
        <div style="padding: 8px; border-bottom: 1px solid #e5e7eb;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span style="font-size: 13px; color: #374151;">${escapeHtml(f.name)}</span>
            <span style="font-size: 12px; color: #6b7280;">等待重新选择文件</span>
          </div>
        </div>
      `).join('');
    }
    
    // 显示提示信息
    progressText.innerHTML = `
      <div style="color: #2563eb; margin-bottom: 8px;">
        🔄 正在恢复上传任务...
      </div>
      <div style="font-size: 12px; color: #6b7280;">
        任务ID: ${taskId}<br>
        配置: ${configName}<br>
        远程路径: ${remotePath}<br>
        文件数量: ${files.length} 个<br>
        <small>如果文件已上传到服务器，上传进度将自动恢复</small>
      </div>
    `;
    progressBar.style.width = '0%';
    progressPercent.textContent = '';
    
    // 显示取消按钮
    if (cancelBtn) {
      cancelBtn.style.display = 'inline-block';
      cancelBtn.onclick = async () => {
        try {
          const res = await fetch(`/api/sftp/upload-cancel/${taskId}`, { method: 'POST' });
          // 无论成功还是404，都清理本地状态
          localStorage.removeItem('sftpUploadTaskId');
          localStorage.removeItem(`sftpUploadFiles_${taskId}`);
          localStorage.removeItem('sftpFileSelection');
          progressDiv.style.display = 'none';
        } catch (error) {
          console.error('取消任务失败:', error);
          // 网络错误也清理本地状态
          localStorage.removeItem('sftpUploadTaskId');
          localStorage.removeItem(`sftpUploadFiles_${taskId}`);
          localStorage.removeItem('sftpFileSelection');
          progressDiv.style.display = 'none';
        }
      };
    }
  }
  
  // 不清除保存的文件信息，因为可能需要用于轮询和恢复
  // localStorage.removeItem(`sftpUploadFiles_${taskId}`);
}

// 上传文件到 SFTP（支持并发上传多个文件）
async function uploadFilesToSftp(files, configName, remotePath, verifyHash) {
  const progressDiv = document.querySelector('#sftpUploadProgress');
  const progressText = document.querySelector('#sftpProgressText');
  const progressPercent = document.querySelector('#sftpProgressPercent');
  const progressBar = document.querySelector('#sftpProgressBar');
  const progressDetails = document.querySelector('#sftpProgressDetails');
  const cancelBtn = document.querySelector('#sftpCancelBtn');
  
  // 过滤掉空文件
  files = files.filter(f => f.size > 0);
  if (files.length === 0) {
    alert('没有可上传的文件（文件大小为0）');
    return;
  }
  
  // 重置取消状态
  isSftpUploadCancelled = false;
  currentSftpTaskId = null;
  isBrowserUploading = true; // 开始浏览器上传阶段
  
  // 清除保存的文件选择信息（因为已经开始上传了）
  localStorage.removeItem('sftpFileSelection');
  
  // 声明已完成文件数变量
  let completedFiles = 0;
  
  // 重置取消按钮状态
  if (cancelBtn) {
    cancelBtn.textContent = '取消上传';
    cancelBtn.disabled = false;
  }
  
  progressDiv.style.display = 'block';
  progressText.textContent = '准备上传...';
  progressText.style.color = '';
  progressPercent.textContent = '';
  progressBar.style.width = '0%';
  // 清空底部进度详情（已移到第一行显示）
  if (progressDetails) progressDetails.textContent = '';
  
  // 显示取消按钮
  if (cancelBtn) {
    cancelBtn.style.display = 'inline-block';
  }
  
  // 存储所有 xhr 引用以便取消
  window.sftpXhrs = [];
  
  // 绑定取消按钮事件
  if (cancelBtn) {
    cancelBtn.onclick = async () => {
      if (isSftpUploadCancelled) return;
      
      isSftpUploadCancelled = true;
      cancelBtn.textContent = '正在取消...';
      cancelBtn.disabled = true;
      
      // 中止所有进行中的上传请求
      if (window.sftpXhrs && window.sftpXhrs.length > 0) {
        window.sftpXhrs.forEach(xhr => xhr.abort());
        progressText.textContent = '正在取消上传...';
        progressText.style.color = '#f59e0b';
        // 不立即隐藏取消按钮，等待上传处理完成后再隐藏
        return;
      }
      
      // 如果已经上传到服务器，开始上传到 SFTP，则调用取消 API
      if (currentSftpTaskId) {
        try {
          const res = await fetch(`/api/sftp/upload-cancel/${currentSftpTaskId}`, {
            method: 'POST'
          });
          
          if (res.ok) {
            progressText.textContent = '正在取消上传...';
          }
        } catch (error) {
          console.error('取消上传失败:', error);
        }
      }
    };
  }
  
  try {
    progressText.textContent = '正在初始化上传任务...';

    // 预创建上传任务，获取taskId（支持刷新恢复）
    const initRes = await fetch('/api/sftp/upload-init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        configName,
        remotePath,
        verifyHash,
        totalFiles: files.length
      })
    });
    
    if (!initRes.ok) {
      throw new Error('初始化上传任务失败');
    }
    
    const initData = await initRes.json();
    currentSftpTaskId = initData.taskId;
    localStorage.setItem('sftpUploadTaskId', initData.taskId); // 立即保存，支持刷新恢复
    
    // 保存文件信息用于恢复（文件名和大小，不包含文件内容）
    const filesInfo = files.map(f => ({ name: f.name, size: f.size }));
    localStorage.setItem(`sftpUploadFiles_${initData.taskId}`, JSON.stringify({
      files: filesInfo,
      configName,
      remotePath,
      verifyHash,
      completedFiles: 0
    }));
    
    // 刷新任务列表显示新任务
    refreshTasks();
    
    // 检查哪些文件已存在（断点续传）
    progressText.textContent = '正在检查已存在的文件...';
    const checkRes = await fetch('/api/sftp/check-existing', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        files: files.map(f => ({ name: f.name, size: f.size }))
      })
    });
    
    const checkData = await checkRes.json();
    const existingFileNames = new Set(checkData.existingFiles || []);
    
    // 过滤出需要上传的文件
    const filesToUpload = files.filter(f => !existingFileNames.has(f.name));
    const skippedFiles = files.filter(f => existingFileNames.has(f.name));
    
    if (skippedFiles.length > 0) {
      // 标记已存在的文件为已完成
      skippedFiles.forEach((file, idx) => {
        const originalIdx = files.findIndex(f => f.name === file.name);
        updateFileProgress(originalIdx, 100, '', '已存在', file.size, file.size);
        completedFiles++; // 增加已完成文件计数
      });
      // 更新总进度显示
      const totalPercent = Math.round((completedFiles / files.length) * 100);
      progressText.textContent = `正在上传文件到Imager服务器 ${completedFiles}/${files.length}`;
      progressPercent.textContent = `${totalPercent}%`;
      progressBar.style.width = `${totalPercent}%`;
      // 如果所有文件都已存在，进度条显示绿色
      if (completedFiles === files.length) {
        progressBar.style.background = '#10b981';
      } else {
        progressBar.style.background = '#2563eb'; // 蓝色表示还有文件待上传
      }
    }
    
    // 如果没有需要上传的文件，直接进入SFTP等待阶段
    if (filesToUpload.length === 0) {
      completedFiles = files.length;
      progressText.textContent = `正在上传到SFTP，详情查看任务日志`;
      progressPercent.textContent = '100%';
      progressBar.style.width = '100%';
      progressBar.style.background = '#10b981'; // 绿色表示已完成
      isBrowserUploading = false;
      
      // 触发SFTP上传
      setTimeout(() => {
        if (!isSftpUploadCancelled && currentSftpTaskId) {
          pollSftpUploadStatus(currentSftpTaskId, progressText, progressPercent, progressBar, progressDetails, cancelBtn, files);
        }
      }, 500);
      return;
    }
    
    // 更新总文件数为实际需要上传的文件数
    const totalBytes = filesToUpload.reduce((sum, f) => sum + f.size, 0);
    
    // 初始化第一行进度显示（左边：文字+文件数量，右边：百分比）
    progressText.textContent = `正在上传文件到Imager服务器 ${completedFiles}/${files.length}`;
    progressPercent.textContent = '0%';

    // 并发上传控制（最多3个文件同时上传）
    const MAX_CONCURRENT = 3;
    const uploadResults = [];
    let totalUploadedBytes = 0;

    // 文件进度跟踪
    const fileProgressMap = new Map();
    const fileProgressList = document.querySelector('#sftpFileProgressList');

    // 初始化文件进度列表显示（显示所有文件，包括已跳过的）
    function initFileProgressList() {
      fileProgressList.innerHTML = files.map((file, idx) => {
        const fileName = file.name;
        const fileSize = formatSize(file.size);
        const isSkipped = existingFileNames.has(file.name);
        const percent = isSkipped ? '100%' : '0%';
        const status = isSkipped ? '已存在' : '等待上传...';
        const barWidth = isSkipped ? '100%' : '0%';
        const barColor = isSkipped ? '#10b981' : '#2563eb'; // 绿色表示已存在
        const uploadedSize = isSkipped ? fileSize : '0 B';
        return `
          <div id="file-progress-${idx}" style="margin-bottom: 8px; padding: 8px; background: #f9fafb; border-radius: 4px; font-size: 12px;">
            <div style="display: flex; justify-content: space-between; margin-bottom: 4px; align-items: center;">
              <span style="color: #374151; font-weight: 500; word-break: break-all; flex: 1; margin-right: 8px;">${escapeHtml(fileName)}</span>
              <span id="file-progress-percent-${idx}" style="color: #6b7280; white-space: nowrap;">${percent}</span>
            </div>
            <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
              <span id="file-progress-size-${idx}" style="color: #9ca3af;">${uploadedSize} / ${fileSize}</span>
              <span id="file-progress-status-${idx}" style="color: ${isSkipped ? '#10b981' : '#6b7280'};">${status}</span>
            </div>
            <div style="width: 100%; height: 4px; background: #e5e7eb; border-radius: 2px; overflow: hidden;">
              <div id="file-progress-bar-${idx}" style="width: ${barWidth}; height: 100%; background: ${barColor}; transition: width 0.3s;"></div>
            </div>
          </div>
        `;
      }).join('');
    }

    // 更新单个文件进度
    function updateFileProgress(fileIndex, percent, speed, status, uploadedBytes, totalBytes) {
      const percentEl = document.querySelector(`#file-progress-percent-${fileIndex}`);
      const statusEl = document.querySelector(`#file-progress-status-${fileIndex}`);
      const sizeEl = document.querySelector(`#file-progress-size-${fileIndex}`);
      const barEl = document.querySelector(`#file-progress-bar-${fileIndex}`);

      if (percentEl) percentEl.textContent = percent + '%';
      if (statusEl) {
        statusEl.textContent = status;
        // 根据状态设置颜色
        if (status === '已存在') {
          statusEl.style.color = '#10b981'; // 绿色
        } else if (status.startsWith('失败')) {
          statusEl.style.color = '#ef4444'; // 红色
        } else if (status === '已上传') {
          statusEl.style.color = '#10b981'; // 绿色
        } else {
          statusEl.style.color = '#6b7280'; // 默认灰色
        }
      }
      if (barEl) {
        barEl.style.width = percent + '%';
        // 根据状态设置进度条颜色
        if (status === '已存在' || status === '已上传') {
          barEl.style.background = '#10b981'; // 绿色
        } else if (status.startsWith('失败')) {
          barEl.style.background = '#ef4444'; // 红色
        } else {
          barEl.style.background = '#2563eb'; // 蓝色
        }
      }
      
      // 更新大小显示：已传 / 总大小 | 速率
      if (sizeEl) {
        const uploaded = uploadedBytes !== undefined ? formatSize(uploadedBytes) : '0 B';
        const total = totalBytes !== undefined ? formatSize(totalBytes) : formatSize(files[fileIndex].size);
        const speedText = speed ? ` | ${speed}` : '';
        sizeEl.textContent = `${uploaded} / ${total}${speedText}`;
      }
    }

    // 初始化显示
    initFileProgressList();

    // 创建文件上传任务
    const uploadFile = (file, fileIndex) => {
      return new Promise((resolve, reject) => {
        const formData = new FormData();
        formData.append('configName', configName);
        formData.append('remotePath', remotePath);
        formData.append('verifyHash', verifyHash ? 'true' : 'false');
        formData.append('fileIndex', fileIndex);
        formData.append('totalFiles', files.length);
        formData.append('taskId', currentSftpTaskId); // 添加已创建的taskId
        const relativePath = file.webkitRelativePath || file.name;
        formData.append('files', file, relativePath);

        const xhr = new XMLHttpRequest();
        window.sftpXhrs.push(xhr);

        let lastLoaded = 0;
        let lastTime = Date.now();

        // 更新状态为上传中
        updateFileProgress(fileIndex, 0, '', '上传中...', 0, file.size);

        xhr.upload.addEventListener('progress', (e) => {
          if (e.lengthComputable && !isSftpUploadCancelled) {
            const fileProgress = e.loaded / e.total;

            const now = Date.now();
            const timeDiff = (now - lastTime) / 1000;
            let speedText = '';
            if (timeDiff > 0.5) {
              const bytesDiff = e.loaded - lastLoaded;
              const speed = bytesDiff / timeDiff / 1024 / 1024;
              speedText = speed > 0 ? `${speed.toFixed(2)} MB/s` : '';
              lastLoaded = e.loaded;
              lastTime = now;
            }

            // 只更新单个文件进度，不更新总体进度
            const percent = Math.round(fileProgress * 100);
            updateFileProgress(fileIndex, percent, speedText, '上传中...', e.loaded, e.total);
          }
        });

        xhr.addEventListener('load', () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            totalUploadedBytes += file.size;
            completedFiles++;

            // 更新第一行进度显示（文件成功完成时更新：左边文件数量，右边百分比，进度条）
            const filePercent = Math.round((completedFiles / files.length) * 100);
            progressText.textContent = `正在上传文件到Imager服务器 ${completedFiles}/${files.length}`;
            progressPercent.textContent = `${filePercent}%`;
            progressBar.style.width = `${filePercent}%`;
            // 更新进度条颜色
            if (completedFiles === files.length) {
              progressBar.style.background = '#10b981'; // 绿色表示所有文件完成
            } else {
              progressBar.style.background = '#2563eb'; // 蓝色表示还有文件待上传
            }

            try {
              const response = JSON.parse(xhr.responseText);
              // 文件已上传到服务器，后台正在上传到SFTP
              updateFileProgress(fileIndex, 100, '', '已上传', file.size, file.size);
              resolve(response);
            } catch (e) {
              updateFileProgress(fileIndex, 0, '', '失败: 解析响应失败', 0, file.size);
              reject(new Error('解析响应失败'));
            }
          } else {
            updateFileProgress(fileIndex, 0, '', `失败 (HTTP ${xhr.status})`, 0, file.size);
            reject(new Error(`上传失败 (HTTP ${xhr.status})`));
          }
        });

        xhr.addEventListener('error', () => {
          updateFileProgress(fileIndex, 0, '', '失败: 网络错误', 0, file.size);
          reject(new Error('上传出错'));
        });
        xhr.addEventListener('abort', () => {
          updateFileProgress(fileIndex, 0, '', '已取消', 0, file.size);
          reject(new Error('上传已取消'));
        });

        xhr.open('POST', '/api/sftp/upload');
        xhr.send(formData);
      });
    };

    // 并发上传文件（使用队列，一个完成立即开始下一个）
    const fileQueue = filesToUpload.map((file, idx) => ({ file, index: files.indexOf(file) }));
    let completedUploads = 0;
    let failedUploads = 0;
    const totalUploadCount = files.length;
    
    async function processFile(item) {
      try {
        const result = await uploadFile(item.file, item.index);
        uploadResults.push(result);
      } catch (error) {
        // 失败已在uploadFile中处理
        failedUploads++;
      } finally {
        completedUploads++;
      }
    }
    
    async function worker() {
      while (!isSftpUploadCancelled) {
        const item = fileQueue.shift();
        if (!item) break; // 队列为空，结束
        await processFile(item);
      }
    }
    
    // 启动多个worker实现并发
    const workers = [];
    for (let i = 0; i < MAX_CONCURRENT; i++) {
      workers.push(worker());
    }
    
    
    // 等待所有worker完成
    await Promise.all(workers);
    
    // 浏览器上传阶段结束
    isBrowserUploading = false;
    
    if (isSftpUploadCancelled) {
      throw new Error('上传已取消');
    }
    
    // 检查是否有文件上传失败
    if (failedUploads > 0) {
      const successCount = skippedFiles.length + (filesToUpload.length - failedUploads);
      progressText.textContent = `上传完成: ${successCount}/${files.length} 成功, ${failedUploads} 个失败`;
      progressText.style.color = '#f59e0b';
      progressPercent.textContent = `${Math.round(successCount / files.length * 100)}%`;
      progressBar.style.width = `${Math.round(successCount / files.length * 100)}%`;
      // 不继续等待SFTP传输，因为有文件失败了
      if (cancelBtn) {
        cancelBtn.style.display = 'none';
      }
      return;
    }
    
    // 浏览器上传完成（包括跳过的文件），更新第一行显示
    progressText.textContent = `正在上传到SFTP，详情查看任务日志`;
    progressPercent.textContent = '100%';
    progressBar.style.width = '100%';
    progressBar.style.background = '#10b981'; // 绿色表示所有文件已上传到服务器
    
    // 等待最多5分钟让SFTP传输完成
    let waitCount = 0;
    const maxWait = 300; // 5分钟
    while (waitCount < maxWait && currentSftpTaskId && !isSftpUploadCancelled) {
      try {
        const res = await fetch(`/api/sftp/upload-status/${currentSftpTaskId}`);
        const data = await res.json();
        
        // 如果任务不存在（可能已完成并清理），检查任务列表状态
        if (!res.ok) {
          // 尝试从任务列表获取最终状态
          try {
            const tasksRes = await fetch('/api/tasks');
            const tasksData = await tasksRes.json();
            const currentTask = tasksData.tasks.find(t => t.id === currentSftpTaskId);
            if (currentTask && currentTask.status === '完成') {
              // 任务已完成，更新UI
              progressText.textContent = '上传完成';
              progressPercent.textContent = '100%';
              progressBar.style.width = '100%';
              progressBar.style.background = '#10b981';
              if (cancelBtn) cancelBtn.style.display = 'none';
            }
          } catch (e) {}
          break;
        }
        
        // 更新进度显示
        if (data.message) {
          progressText.textContent = data.message;
        }
        if (data.progress !== undefined) {
          progressPercent.textContent = data.progress + '%';
          progressBar.style.width = data.progress + '%';
        }
        
        // 如果任务完成，退出等待并隐藏按钮
        if (data.status === 'completed' || data.status === 'failed' || data.status === 'cancelled') {
          if (cancelBtn) cancelBtn.style.display = 'none';
          break;
        }
      } catch (e) {
        // 网络错误，继续等待
      }
      await new Promise(r => setTimeout(r, 1000));
      waitCount++;
    }

    // 刷新任务列表以更新SFTP任务状态
    refreshTasks();
  } catch (error) {
    // 如果是用户取消，不显示为错误
    if (error.message === '上传已取消' || isSftpUploadCancelled) {
      progressText.textContent = '上传已取消';
      progressText.style.color = '#f59e0b';
      localStorage.removeItem('sftpUploadTaskId'); // 清除任务ID
      localStorage.removeItem(`sftpUploadFiles_${currentSftpTaskId}`); // 清除文件信息
      localStorage.removeItem('sftpFileSelection'); // 清除文件选择
    } else {
      progressText.textContent = '上传失败：' + error.message;
      progressText.style.color = '#ef4444';
      localStorage.removeItem('sftpUploadTaskId'); // 清除任务ID
      localStorage.removeItem(`sftpUploadFiles_${currentSftpTaskId}`); // 清除文件信息
      localStorage.removeItem('sftpFileSelection'); // 清除文件选择
    }
    if (cancelBtn) {
      cancelBtn.style.display = 'none';
      cancelBtn.textContent = '取消上传';
      cancelBtn.disabled = false;
    }
  } finally {
    // 清除 xhr 引用
    window.sftpXhrs = [];
    // 确保隐藏取消按钮
    if (cancelBtn) {
      cancelBtn.style.display = 'none';
      cancelBtn.textContent = '取消上传';
      cancelBtn.disabled = false;
    }
  }
}

// 全局轮询控制，防止重复轮询
let isPollingSftpStatus = false;

// 轮询 SFTP 上传状态
async function pollSftpUploadStatus(taskId, progressText, progressPercent, progressBar, progressDetails, cancelBtn, files) {
  // 防止重复轮询
  if (isPollingSftpStatus) {
    return;
  }
  isPollingSftpStatus = true;
  
  const maxAttempts = 600; // 最多轮询 10 分钟
  let attempts = 0;

  // 获取日志显示区域
  const logContainer = document.querySelector('#sftpUploadLogs');
  const fileProgressList = document.querySelector('#sftpFileProgressList');
  
  // 如果没有传入 files，尝试从 localStorage 获取（恢复场景）
  let filesList = files;
  if (!filesList && taskId) {
    const savedFilesInfo = localStorage.getItem(`sftpUploadFiles_${taskId}`);
    if (savedFilesInfo) {
      try {
        const filesInfo = JSON.parse(savedFilesInfo);
        filesList = filesInfo.files || [];
      } catch (e) {}
    }
  }

  // 初始化文件列表显示（使用后端返回的状态数据）
  // 注意：只有在非浏览器上传阶段才显示"正在获取文件状态..."
  if (fileProgressList && !isBrowserUploading) {
    fileProgressList.innerHTML = '<div style="padding: 8px; color: #6b7280; font-size: 12px; text-align: center;">正在获取文件状态...</div>';
  }

  try {
    while (attempts < maxAttempts) {
      // 检查是否已取消
      if (isSftpUploadCancelled) {
        progressText.textContent = '上传已取消';
        progressText.style.color = '#f59e0b';
        if (cancelBtn) {
          cancelBtn.style.display = 'none';
        }
        return;
      }

      // 浏览器上传阶段：减少轮询频率（每5秒一次），且不更新UI
      if (isBrowserUploading) {
        await sleep(5000);
        attempts++;
        continue;
      }

      try {
        const res = await fetch(`/api/sftp/upload-status/${taskId}`);
        const data = await res.json();

        if (!res.ok) {
          // 任务可能已完成并清理，检查任务列表状态
          try {
            const tasksRes = await fetch('/api/tasks');
            const tasksData = await tasksRes.json();
            const currentTask = tasksData.tasks.find(t => t.id === taskId);
            if (currentTask && currentTask.status === '完成') {
              // 任务已完成，更新UI
              progressText.textContent = '上传完成';
              progressBar.style.width = '100%';
              progressPercent.textContent = '100%';
              progressBar.style.background = '#10b981';
              if (cancelBtn) cancelBtn.style.display = 'none';
              localStorage.removeItem('sftpUploadTaskId');
              localStorage.removeItem(`sftpUploadFiles_${taskId}`);
              localStorage.removeItem('sftpFileSelection');
              isPollingSftpStatus = false;
              return;
            }
          } catch (e) {}
          throw new Error(data.error || '获取状态失败');
        }

        const { status, progress, message, details, speed, currentFile, uploadedFiles, totalFiles, logs, phase, files: fileStatusList } = data;

        // SFTP上传阶段：左边显示文件数量，右边显示百分比
        if (uploadedFiles !== undefined && totalFiles && totalFiles > 0) {
          progressText.textContent = `正在上传文件到Imager服务器 ${uploadedFiles}/${totalFiles}`;
        } else if (message) {
          progressText.textContent = message;
        }
        
        // 使用后端返回的 progress 值统一设置进度条和百分比
        if (progress !== undefined) {
          progressBar.style.width = progress + '%';
          progressPercent.textContent = progress + '%';
        }
        
        // 更新每个文件的状态
        if (fileStatusList && fileStatusList.length > 0 && fileProgressList) {
        // 如果文件列表还没初始化，从 localStorage 获取原始文件列表并合并状态
        if (!fileProgressList.querySelector('[id^="file-progress-item-"]')) {
          // 从 localStorage 获取原始文件列表
          let allFiles = [];
          const savedFilesInfo = localStorage.getItem(`sftpUploadFiles_${taskId}`);
          if (savedFilesInfo) {
            try {
              const filesInfo = JSON.parse(savedFilesInfo);
              allFiles = filesInfo.files || [];
            } catch (e) {}
          }
          
          // 创建后端文件状态映射
          const backendFileStatus = {};
          if (fileStatusList && fileStatusList.length > 0) {
            fileStatusList.forEach(f => {
              backendFileStatus[f.name] = f;
            });
          }
          
          // 合并文件列表状态
          const displayFiles = allFiles.length > 0 ? allFiles : fileStatusList;
          let html = displayFiles.map((f, idx) => {
            const backendStatus = backendFileStatus[f.name] || backendFileStatus[allFiles[idx]?.name];
            let status = backendStatus ? backendStatus.status : 'pending';
            let percent = backendStatus ? backendStatus.percent : 0;
            let name = backendStatus ? backendStatus.name : f.name;
            let size = backendStatus ? backendStatus.size : f.size;
            
            return `
            <div id="file-progress-item-${idx}" style="padding: 8px; border-bottom: 1px solid #e5e7eb;">
              <div style="display: flex; justify-content: space-between; align-items: center;">
                <span style="font-size: 13px; color: #374151;">${escapeHtml(name)}</span>
                <span id="file-progress-status-${idx}" style="font-size: 12px; color: ${getFileStatusColor(status)};">${getFileStatusText(status)}${status === 'pending' ? ' (需要重新上传)' : ''}</span>
              </div>
              <div style="margin-top: 4px; display: flex; justify-content: space-between; align-items: center;">
                <span id="file-progress-size-${idx}" style="font-size: 11px; color: #9ca3af;">${formatSize(size)}</span>
                <span id="file-progress-percent-${idx}" style="font-size: 11px; color: #6b7280;">${percent > 0 ? percent + '%' : ''}</span>
              </div>
              <div style="width: 100%; height: 3px; background: #e5e7eb; border-radius: 2px; margin-top: 4px; overflow: hidden;">
                <div id="file-progress-bar-${idx}" style="width: ${percent}%; height: 100%; background: ${getFileStatusColor(status)}; transition: width 0.3s;"></div>
              </div>
            </div>
          `}).join('');
          fileProgressList.innerHTML = html;
        } else {
          // 更新已有文件的状态
          // 创建后端文件状态映射（按文件名）
          const backendFileStatusMap = {};
          if (fileStatusList && fileStatusList.length > 0) {
            fileStatusList.forEach(f => {
              backendFileStatusMap[f.name] = f;
            });
          }

          // 遍历所有已初始化的文件项
          const allFileItems = fileProgressList.querySelectorAll('[id^="file-progress-item-"]');
          allFileItems.forEach((item, idx) => {
            const statusEl = item.querySelector(`#file-progress-status-${idx}`);
            const percentEl = item.querySelector(`#file-progress-percent-${idx}`);
            const barEl = item.querySelector(`#file-progress-bar-${idx}`);
            const nameEl = item.querySelector('span:first-child');

            // 获取当前显示的文件名
            const currentFileName = nameEl ? nameEl.textContent : '';

            // 检查该文件是否在后端状态中
            const backendStatus = backendFileStatusMap[currentFileName];

            if (backendStatus) {
              // 文件在后端状态中，更新为后端返回的状态
              if (statusEl) statusEl.textContent = getFileStatusText(backendStatus.status);
              if (percentEl) percentEl.textContent = backendStatus.percent > 0 ? backendStatus.percent + '%' : '';
              if (barEl) {
                barEl.style.width = backendStatus.percent + '%';
                barEl.style.background = getFileStatusColor(backendStatus.status);
              }
            }
            // 如果文件不在后端状态中，保持当前状态（pending状态），不做任何修改
          });
        }
      }

          // 更新日志显示
      if (logContainer && logs && logs.length > 0) {
        const lastLogs = logs.slice(-5); // 显示最近5条日志
        logContainer.innerHTML = lastLogs.map(log => `<div style="font-size: 12px; color: #666; margin: 2px 0;">${escapeHtml(log)}</div>`).join('');
        logContainer.scrollTop = logContainer.scrollHeight;
        
        // 将日志显示到对应的文件进度条下方
        if (filesList && fileProgressList) {
          updateFileProgressLogs(logs, filesList);
        }
      }

      // 检查任务列表状态：每30秒检查一次，避免频繁调用
      if (attempts % 30 === 0) {
        try {
          const tasksRes = await fetch('/api/tasks');
          const tasksData = await tasksRes.json();
          const currentTask = tasksData.tasks.find(t => t.id === taskId);
          if (currentTask && currentTask.status === '完成' && status !== 'completed') {
            progressText.textContent = '完成所有文件上传';
            progressBar.style.width = '100%';
            progressPercent.textContent = '100%';
          }
        } catch (e) {
          // 忽略错误，继续轮询
        }
      }

      if (status === 'completed') {
        progressText.textContent = '上传完成';
        progressBar.style.width = '100%';
        progressPercent.textContent = '100%';
        if (progressDetails) progressDetails.textContent = '';
        if (logContainer && logs) {
          logContainer.innerHTML = logs.map(log => `<div style="font-size: 12px; color: #22c55e; margin: 2px 0;">${escapeHtml(log)}</div>`).join('');
        }
        if (cancelBtn) {
          cancelBtn.style.display = 'none';
        }
        localStorage.removeItem('sftpUploadTaskId'); // 清除任务ID
        localStorage.removeItem(`sftpUploadFiles_${taskId}`); // 清除文件信息
        localStorage.removeItem('sftpFileSelection'); // 清除文件选择
        isPollingSftpStatus = false; // 重置轮询标志
        return;
      }

      if (status === 'failed') {
        progressText.textContent = '上传失败：' + (message || '未知错误');
        progressText.style.color = '#ef4444';
        if (logContainer && logs) {
          logContainer.innerHTML = logs.map(log => `<div style="font-size: 12px; color: #ef4444; margin: 2px 0;">${escapeHtml(log)}</div>`).join('');
        }
        if (cancelBtn) {
          cancelBtn.style.display = 'none';
        }
        localStorage.removeItem('sftpUploadTaskId'); // 清除任务ID
        localStorage.removeItem(`sftpUploadFiles_${taskId}`); // 清除文件信息
        localStorage.removeItem('sftpFileSelection'); // 清除文件选择
        isPollingSftpStatus = false; // 重置轮询标志
        return;
      }

      if (status === 'cancelled') {
        progressText.textContent = '上传已取消';
        progressText.style.color = '#f59e0b';
        if (logContainer && logs) {
          logContainer.innerHTML = logs.map(log => `<div style="font-size: 12px; color: #f59e0b; margin: 2px 0;">${escapeHtml(log)}</div>`).join('');
        }
        if (cancelBtn) {
          cancelBtn.style.display = 'none';
        }
        localStorage.removeItem('sftpUploadTaskId'); // 清除任务ID
        localStorage.removeItem(`sftpUploadFiles_${taskId}`); // 清除文件信息
        localStorage.removeItem('sftpFileSelection'); // 清除文件选择
        isPollingSftpStatus = false; // 重置轮询标志
        return;
      }
      
        // SFTP上传阶段：自动轮询已关闭
        break; // 退出循环，不再自动轮询
      } catch (error) {
        // 出错时退出循环
        break;
      }
    }
  } finally {
    // 确保在任何情况下都重置轮询标志
    isPollingSftpStatus = false;
  }
}

// HTML 转义函数
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ========== ModelScope 模型下载 ==========

// 下载类型切换
document.getElementById('msDownloadType')?.addEventListener('change', function() {
  const fileLabel = document.getElementById('msFileLabel');
  if (this.value === 'file') {
    fileLabel.style.display = 'block';
  } else {
    fileLabel.style.display = 'none';
  }
});

// ModelScope 下载表单提交
let currentMsTaskId = null;

document.getElementById('modelscopeForm')?.addEventListener('submit', async function(e) {
  e.preventDefault();
  
  const downloadType = document.getElementById('msDownloadType').value;
  const modelId = document.getElementById('msModelId').value.trim();
  const localDir = document.getElementById('msLocalDir').value.trim();
  const filePath = document.getElementById('msFilePath').value.trim();
  
  if (!modelId || !localDir) {
    alert('请填写模型 ID 和保存目录');
    return;
  }
  
  if (downloadType === 'file' && !filePath) {
    alert('请填写要下载的文件路径');
    return;
  }
  
  // 显示进度区域
  const progressDiv = document.getElementById('modelscopeProgress');
  const progressText = document.getElementById('msProgressText');
  const progressPercent = document.getElementById('msProgressPercent');
  const progressBar = document.getElementById('msProgressBar');
  const cancelBtn = document.getElementById('msCancelBtn');
  
  progressDiv.style.display = 'block';
  progressText.textContent = '正在初始化下载...';
  progressPercent.textContent = '0%';
  progressBar.style.width = '0%';
  progressText.style.color = '';
  progressBar.style.background = '#10b981';
  cancelBtn.style.display = 'inline-block';
  cancelBtn.textContent = '取消下载';
  cancelBtn.disabled = false;
  
  try {
    // 发起下载请求
    const res = await fetch('/api/modelscope/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        modelId,
        localDir,
        downloadType,
        filePath: downloadType === 'file' ? filePath : null
      })
    });
    
    const data = await res.json();
    
    if (!res.ok) {
      throw new Error(data.error || '下载失败');
    }
    
    currentMsTaskId = data.taskId;
    
    // 刷新任务列表
    refreshTasks();
    
    // 轮询进度
    let lastLogCount = 0;
    const pollProgress = async () => {
      try {
        const statusRes = await fetch(`/api/modelscope/progress/${currentMsTaskId}`);
        const statusData = await statusRes.json();
        
        if (statusRes.ok) {
          progressBar.style.width = (statusData.progress || 0) + '%';
          progressPercent.textContent = (statusData.progress || 0) + '%';
          progressText.textContent = statusData.message || '下载中...';
          
          if (statusData.status === '完成') {
            progressText.textContent = '下载完成';
            progressPercent.textContent = '100%';
            progressBar.style.width = '100%';
            progressText.style.color = '#10b981';
            progressBar.style.background = '#10b981';
            cancelBtn.style.display = 'none';
            currentMsTaskId = null;
            refreshTasks();
            return;
          }
          
          if (statusData.status === '失败' || statusData.status === '已取消') {
            progressText.textContent = statusData.message || statusData.status;
            progressText.style.color = statusData.status === '已取消' ? '#f59e0b' : '#ef4444';
            cancelBtn.style.display = 'none';
            currentMsTaskId = null;
            refreshTasks();
            return;
          }
          
          // 继续轮询
          setTimeout(pollProgress, 5000);
        }
      } catch (err) {
        console.error('获取进度失败:', err);
        setTimeout(pollProgress, 5000);
      }
    };
    
    pollProgress();
    
  } catch (error) {
    progressText.textContent = '错误: ' + error.message;
    progressText.style.color = '#ef4444';
    cancelBtn.style.display = 'none';
    currentMsTaskId = null;
  }
});

// 取消 ModelScope 下载
document.getElementById('msCancelBtn')?.addEventListener('click', async function() {
  if (!currentMsTaskId) return;
  
  const cancelBtn = this;
  cancelBtn.disabled = true;
  cancelBtn.textContent = '取消中...';
  
  try {
    const res = await fetch(`/api/modelscope/cancel/${currentMsTaskId}`, { method: 'POST' });
    const data = await res.json();
    
    if (res.ok) {
      document.getElementById('modelscopeProgress').style.display = 'none';
      cancelBtn.style.display = 'none';
      currentMsTaskId = null;
      refreshTasks();
    } else {
      alert(data.error || '取消失败');
      cancelBtn.disabled = false;
      cancelBtn.textContent = '取消下载';
    }
  } catch (error) {
    alert('取消失败: ' + error.message);
    cancelBtn.disabled = false;
    cancelBtn.textContent = '取消下载';
  }
});
