const taskList = document.querySelector('#taskList');
const configStatus = document.querySelector('#configStatus');
const verifyBtn = document.querySelector('#verifyBtn');
const taskDetailCard = document.querySelector('#taskDetailCard');
const taskDetail = document.querySelector('#taskDetail');
const syncTargetRepo = document.querySelector('#syncTargetRepo');
const uploadTargetRepo = document.querySelector('#uploadTargetRepo');

let refreshInterval = null;
let harborRepos = [];

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
        <button class="btn-small btn-retry" onclick="retryTask('${task.id}')" ${isSuccess ? 'disabled' : ''}>重新执行</button>
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

verifyBtn.addEventListener('click', verifyConnection);

document.querySelector('#harborForm').addEventListener('submit', async (event) => {
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

document.querySelector('#syncForm').addEventListener('submit', async (event) => {
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

document.querySelector('#uploadForm').addEventListener('submit', async (event) => {
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
          
          // 计算上传速度
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

    // 架构显示文本
    const archText = task.arch === 'all' ? '多架构' : (task.arch === 'system' ? '系统自匹配' : (task.arch || '多架构'));
    
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
        <p><strong>镜像架构:</strong> ${archText}</p>
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

loadHarborRepos();
refreshTasks();
loadServerLogs();

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
