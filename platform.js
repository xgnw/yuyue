/* ==========================================================================
   平台适配层 · Vercel 版
   ---------------------------------------------------------------------------
   与 Cloudflare 版保持同一套接口契约，区别只在数据来源：
     · 搜索 / 目录 / 正文  ->  同域 Python 函数 /api/*
     · 整本缓存           ->  IndexedDB（cache-idb.js）
     · 封面                ->  /api/img 图片代理（index.html 里直接写死）
   前端只认 window.PLAT.call(path, opts)，换部署平台时只替换本文件。
   ========================================================================== */
(function (global) {
  'use strict';

  async function request(pathAndQuery, opts = {}) {
    const init = { cache: 'no-store', headers: {} };
    if (opts.method && opts.method !== 'GET') {
      init.method = opts.method;
      init.headers['Content-Type'] = 'application/json';
      init.body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body || {});
    }
    const res = await fetch(pathAndQuery, init);
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok) {
      const msg = (data && (data.error || data.message)) || `HTTP ${res.status}`;
      throw new Error(msg);
    }
    return data;
  }

  async function call(pathAndQuery, opts = {}) {
    const [path, qs] = pathAndQuery.split('?');
    if (path.startsWith('/api/cache/')) return IdbCache.handle(pathAndQuery, opts);

    // 正文先查 IndexedDB（整本下载过的书离线也能读），命中就零网络
    if (path === '/api/content') {
      const q = new URLSearchParams(qs || '');
      const src = q.get('src') || '', url = q.get('url') || '', bookUrl = q.get('book') || '';
      const hit = await IdbCache.chapter(src, bookUrl, url);
      if (hit) return { text: hit, cached: true };
      return request(pathAndQuery, opts);
    }
    return request(pathAndQuery, opts);
  }

  global.PLAT = {
    mode: 'vercel',
    call,
    ready: () => Promise.resolve(),
    book: (src, url) => call(`/api/book?src=${encodeURIComponent(src)}&url=${encodeURIComponent(url)}`),
    content: (src, url, bookUrl) => call(`/api/content?src=${encodeURIComponent(src)}&url=${encodeURIComponent(url)}&book=${encodeURIComponent(bookUrl || '')}`).then(x => x.text)
  };
})(window);
