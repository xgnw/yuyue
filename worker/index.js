/* ==========================================================================
   愉阅 · Cloudflare Worker
   ---------------------------------------------------------------------------
   职责只有两件，规则引擎仍然跑在浏览器里（见 public/engine.js）：
     1. /p      抓取代理：给第三方站点补 UA / Referer，把原始字节透传回来
                GET  /p?u=<目标URL>&r=<Referer>
                POST /p?r=<Referer>  目标地址放在请求头 x-target
     2. /api/img 封面代理：按图片域名补 Referer，绕开防盗链
   其余请求全部交给静态资源（wrangler 的 assets 绑定）。
   ========================================================================== */
export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    if (url.pathname === '/p') return proxyPage(req, url);
    if (url.pathname === '/api/img') return proxyImage(url);
    return env.ASSETS.fetch(req);
  }
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/* 只代理公网 http(s)，避免被当成内网探测工具 */
function safeTarget(raw) {
  let u;
  try { u = new URL(raw); } catch (e) { return null; }
  if (!/^http(s)?:/.test(u.protocol)) return null;
  const h = u.hostname;
  if (/^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|\[?::1\]?)/.test(h)) return null;
  if (/\.(local|internal)$/.test(h)) return null;
  return u;
}

function cors(headers = {}) {
  return Object.assign({
    'access-control-allow-origin': '*',
    'access-control-expose-headers': 'x-final-url, content-type'
  }, headers);
}

async function proxyPage(req, url) {
  const target = req.method === 'POST'
    ? safeTarget(req.headers.get('x-target') || '')
    : safeTarget(url.searchParams.get('u') || '');
  if (!target) return new Response('bad target', { status: 400 });

  const referer = url.searchParams.get('r') || (target.origin + '/');
  const headers = {
    'user-agent': UA,
    'referer': referer,
    'accept': 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
    'accept-language': 'zh-CN,zh;q=0.9'
  };
  let body;
  if (req.method === 'POST') {
    headers['content-type'] = req.headers.get('x-target-type') || 'application/x-www-form-urlencoded';
    body = await req.arrayBuffer();
  }

  const upstream = await fetch(target.toString(), {
    method: req.method,
    headers,
    body,
    redirect: 'follow'
  });

  return new Response(upstream.body, {
    status: upstream.status,
    headers: cors({
      'content-type': upstream.headers.get('content-type') || 'text/html; charset=utf-8',
      'x-final-url': upstream.url || target.toString(),
      'cache-control': 'no-store'
    })
  });
}

async function proxyImage(url) {
  const target = safeTarget(url.searchParams.get('u') || '');
  if (!target) return new Response('bad target', { status: 400 });
  const upstream = await fetch(target.toString(), {
    headers: {
      'user-agent': UA,
      'referer': target.origin + '/',
      'accept': 'image/avif,image/webp,image/*,*/*;q=0.8'
    },
    redirect: 'follow'
  });
  if (!upstream.ok) return new Response('', { status: 404 });
  return new Response(upstream.body, {
    headers: cors({
      'content-type': upstream.headers.get('content-type') || 'image/jpeg',
      'cache-control': 'public, max-age=86400'
    })
  });
}
