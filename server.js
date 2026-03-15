const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;
const ROOT = __dirname;

const state = {
  harborConfig: null,
  tasks: []
};

function sendJson(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 2 * 1024 * 1024) {
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

function createTask(type, source, target) {
  const task = {
    id: Date.now().toString(36),
    time: new Date().toLocaleString(),
    type,
    source,
    target,
    status: '已创建'
  };
  state.tasks.unshift(task);
  return task;
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
      sendJson(res, 200, { tasks: state.tasks });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/harbor/config') {
      const body = await parseJsonBody(req);
      const { harborUrl, project, username, password } = body;
      if (!harborUrl || !project || !username || !password) {
        sendJson(res, 400, { error: 'Missing required fields' });
        return;
      }

      state.harborConfig = { harborUrl, project, username, password };
      sendJson(res, 200, { message: '配置已保存', harbor: `${harborUrl}/${project}` });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/images/sync') {
      if (!state.harborConfig) {
        sendJson(res, 400, { error: 'Harbor config required' });
        return;
      }

      const body = await parseJsonBody(req);
      const { sourceImage, targetRepo, targetTag } = body;
      if (!sourceImage || !targetRepo || !targetTag) {
        sendJson(res, 400, { error: 'Missing required fields' });
        return;
      }

      const target = `${state.harborConfig.harborUrl.replace(/^https?:\/\//, '')}/${targetRepo}:${targetTag}`;
      const task = createTask('公网同步', sourceImage, target);
      sendJson(res, 200, { task });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/images/upload') {
      if (!state.harborConfig) {
        sendJson(res, 400, { error: 'Harbor config required' });
        return;
      }

      const body = await parseJsonBody(req);
      const { fileName, importRepo, importTag } = body;
      if (!fileName || !importRepo || !importTag) {
        sendJson(res, 400, { error: 'Missing required fields' });
        return;
      }

      const target = `${state.harborConfig.harborUrl.replace(/^https?:\/\//, '')}/${importRepo}:${importTag}`;
      const task = createTask('tar 导入', fileName, target);
      sendJson(res, 200, { task });
      return;
    }

    if (req.method === 'GET') {
      serveFile(req, res, pathname);
      return;
    }

    sendJson(res, 405, { error: 'Method not allowed' });
  } catch (error) {
    sendJson(res, 400, { error: error.message });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on http://0.0.0.0:${PORT}`);
});
