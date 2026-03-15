const state = {
  harborConfig: null,
  tasks: []
};

const taskList = document.querySelector("#taskList");
const configStatus = document.querySelector("#configStatus");

function renderTasks() {
  taskList.innerHTML = "";
  for (const task of state.tasks) {
    const tr = document.createElement("tr");
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

function pushTask(type, source, target, status = "已创建") {
  state.tasks.unshift({
    time: new Date().toLocaleString(),
    type,
    source,
    target,
    status
  });
  renderTasks();
}

document.querySelector("#harborForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);
  state.harborConfig = {
    harborUrl: formData.get("harborUrl"),
    project: formData.get("project"),
    username: formData.get("username"),
    password: formData.get("password")
  };
  configStatus.textContent = `已保存 Harbor 配置：${state.harborConfig.harborUrl}/${state.harborConfig.project}`;
});

document.querySelector("#syncForm").addEventListener("submit", (event) => {
  event.preventDefault();
  if (!state.harborConfig) {
    configStatus.textContent = "请先完成 Harbor 配置";
    return;
  }

  const formData = new FormData(event.currentTarget);
  const sourceImage = formData.get("sourceImage");
  const target = `${state.harborConfig.harborUrl.replace(/^https?:\/\//, "")}/${formData.get("targetRepo")}:${formData.get("targetTag")}`;

  pushTask("公网同步", sourceImage, target);
  event.currentTarget.reset();
});

document.querySelector("#uploadForm").addEventListener("submit", (event) => {
  event.preventDefault();
  if (!state.harborConfig) {
    configStatus.textContent = "请先完成 Harbor 配置";
    return;
  }

  const formData = new FormData(event.currentTarget);
  const file = formData.get("imageTar");
  const target = `${state.harborConfig.harborUrl.replace(/^https?:\/\//, "")}/${formData.get("importRepo")}:${formData.get("importTag")}`;

  if (!(file instanceof File) || !file.name) {
    configStatus.textContent = "请选择有效的 tar 包";
    return;
  }

  pushTask("tar 导入", file.name, target);
  event.currentTarget.reset();
});

renderTasks();
