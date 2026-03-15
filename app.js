const taskList = document.querySelector('#taskList');
const configStatus = document.querySelector('#configStatus');

function renderTasks(tasks) {
  taskList.innerHTML = '';
  for (const task of tasks) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${task.time}</td>
      <td>${task.type}</td>
      <td>${task.source}</td>
      <td>${task.target}</td>
      <td>${task.status}</td>
    `;
    taskList.appendChild(tr);
  }
}

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

async function refreshTasks() {
  const res = await fetch('/api/tasks');
  const data = await res.json();
  renderTasks(data.tasks || []);
}

document.querySelector('#harborForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);
  try {
    const result = await request('/api/harbor/config', {
      harborUrl: formData.get('harborUrl'),
      project: formData.get('project'),
      username: formData.get('username'),
      password: formData.get('password')
    });
    configStatus.textContent = `已保存 Harbor 配置：${result.harbor}`;
  } catch (error) {
    configStatus.textContent = `保存失败：${error.message}`;
  }
});

document.querySelector('#syncForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);

  try {
    await request('/api/images/sync', {
      sourceImage: formData.get('sourceImage'),
      targetRepo: formData.get('targetRepo'),
      targetTag: formData.get('targetTag')
    });
    event.currentTarget.reset();
    await refreshTasks();
  } catch (error) {
    configStatus.textContent = `同步任务失败：${error.message}`;
  }
});

document.querySelector('#uploadForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);
  const file = formData.get('imageTar');

  if (!(file instanceof File) || !file.name) {
    configStatus.textContent = '请选择有效的 tar 包';
    return;
  }

  try {
    await request('/api/images/upload', {
      fileName: file.name,
      importRepo: formData.get('importRepo'),
      importTag: formData.get('importTag')
    });
    event.currentTarget.reset();
    await refreshTasks();
  } catch (error) {
    configStatus.textContent = `上传任务失败：${error.message}`;
  }
});

refreshTasks();
