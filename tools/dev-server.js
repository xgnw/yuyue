#!/usr/bin/env node
/* ==========================================================================
   本地调试服务器（仅开发用）
   ---------------------------------------------------------------------------
   本地没有 Cloudflare 运行时，这里用 Node 复刻 Worker 的两条逻辑：
   /p 抓取代理、/api/img 封面代理，其余请求当静态文件返回。
   用法：node tools/dev-server.js  然后打开 http://127.0.0.1:5199
   ========================================================================== */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'public');
const PORT = Number(process.env.PORT || 5199);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, Object.assign({ 'access-control-allow-origin': '*' }, headers));
  res.end(body);
}

async function proxy(req, res, url) {
  const target = req.method === 'POST' ? (req.headers['x-target'] || '') : (url.searchParams.get('u') || '');
  let u;
  try { u = new URL(target); } catch (e) { return send(res, 400, 'bad target'); }
  if (!/^http(s)?:/.test(u.protocol)) return send(res, 400, 'bad target');

  const headers = {
    'user-agent': UA,
    referer: url.searchParams.get('r') || u.origin + '/',
    accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
    'accept-language': 'zh-CN,zh;q=0.9'
  };
  let body;
  if (req.method === 'POST') {
    headers['content-type'] = req.headers['x-target-type'] || 'application/x-www-form-urlencoded';
    body = await readBody(req);
  }
  try {
    const up = await fetch(u.toString(), { method: req.method, headers, body, redirect: 'follow' });
    const buf = Buffer.from(await up.arrayBuffer());
    send(res, up.status, buf, {
      'content-type': up.headers.get('content-type') || 'text/html; charset=utf-8',
      'x-final-url': up.url || u.toString(),
      'cache-control': 'no-store'
    });
  } catch (e) {
    send(res, 502, 'proxy error: ' + e.message);
  }
}

async function image(res, url) {
  const target = url.searchParams.get('u');
  let u;
  try { u = new URL(target); } catch (e) { return send(res, 400, 'bad target'); }
  try {
    const up = await fetch(u.toString(), { headers: { 'user-agent': UA, referer: u.origin + '/', accept: 'image/*' } });
    if (!up.ok) return send(res, 404, '');
    const buf = Buffer.from(await up.arrayBuffer());
    send(res, 200, buf, { 'content-type': up.headers.get('content-type') || 'image/jpeg', 'cache-control': 'public, max-age=86400' });
  } catch (e) { send(res, 502, ''); }
}

function readBody(req) {
  return new Promise(resolve => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/p') return proxy(req, res, url);
  if (url.pathname === '/api/img') return image(res, url);

  const file = path.join(ROOT, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
  if (!file.startsWith(ROOT)) return send(res, 403, 'forbidden');
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'not found');
    send(res, 200, buf, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  });
}).listen(PORT, () => console.log('dev server: http://127.0.0.1:' + PORT));
