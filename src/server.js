'use strict';

const http = require('node:http');
const { classify, GeofenceError, MAX_BODY_BYTES } = require('./geometry');

// 校验失败类错误 → 4xx；其余 → 500
function statusFor(code) {
  if (code === 'BODY_TOO_LARGE') return 413;
  if (code === 'INVALID_JSON') return 400;
  return 400;
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function handleClassify(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('allow', 'POST');
    sendJson(res, 405, {
      error: { code: 'METHOD_NOT_ALLOWED', message: '仅支持 POST /api/geofences/classify' },
    });
    return;
  }

  const chunks = [];
  let size = 0;
  let responded = false;

  const reject = (status, payload) => {
    if (responded || res.headersSent) return;
    responded = true;
    sendJson(res, status, payload);
  };

  req.on('data', (chunk) => {
    if (responded) return;
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      // 先发出 413，响应刷完后再中断未读完的请求体
      reject(413, {
        error: {
          code: 'BODY_TOO_LARGE',
          message: `请求正文超过 ${MAX_BODY_BYTES} 字节（1 MiB）上限`,
        },
      });
      res.on('finish', () => req.destroy());
      return;
    }
    chunks.push(chunk);
  });

  req.on('end', () => {
    if (responded) return;
    let body;
    try {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.length === 0) throw new SyntaxError('empty body');
      body = JSON.parse(raw);
    } catch (err) {
      reject(400, {
        error: {
          code: 'INVALID_JSON',
          message: `请求体不是合法 JSON（正文上限 ${MAX_BODY_BYTES} 字节）: ${err.message}`,
        },
      });
      return;
    }

    try {
      const results = classify(body);
      reject(200, { results });
    } catch (err) {
      if (err instanceof GeofenceError) {
        reject(statusFor(err.code), {
          error: { code: err.code, message: err.message, where: err.where },
        });
      } else {
        reject(500, {
          error: { code: 'INTERNAL_ERROR', message: '服务器内部错误' },
        });
      }
    }
  });

  req.on('error', () => {
    // 客户端中断或超限销毁；若尚未响应则兜底
    if (!responded && !res.headersSent) {
      responded = true;
      try {
        sendJson(res, 400, { error: { code: 'BAD_REQUEST', message: '请求读取失败' } });
      } catch {
        // 连接已不可写
      }
    }
  });
}

function createServer() {
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/health' && req.method === 'GET') {
      sendJson(res, 200, { status: 'ok' });
      return;
    }
    if (url.pathname === '/api/geofences/classify') {
      handleClassify(req, res);
      return;
    }
    sendJson(res, 404, { error: { code: 'NOT_FOUND', message: '未知路由' } });
  });
}

if (require.main === module) {
  const port = parseInt(process.env.PORT || '8080', 10);
  const server = createServer();
  server.listen(port, '0.0.0.0', () => {
    console.log(`geofence classify API listening on 0.0.0.0:${port}`);
  });

  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = { createServer };
