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

  const CUSTOM_KEY = 'yuyue.sources.custom';

  function customList() {
    try { const a = JSON.parse(localStorage.getItem(CUSTOM_KEY) || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; }
  }
  function saveCustom(list) {
    try { localStorage.setItem(CUSTOM_KEY, JSON.stringify(list)); } catch (e) { /* 超限就只保留本次会话 */ }
  }

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

  // Vercel 函数没有常驻磁盘，导入的书源只活在当前实例内存里。
  // 所以浏览器把同一份存 localStorage，每次加载页面自动补发给函数，冷启动后就又有了。
  const boot = (async () => {
    const list = customList();
    if (!list.length) return;
    try { await request('/api/sources/import', { method: 'POST', body: { json: list } }); } catch (e) { /* 补发失败不阻塞页面 */ }
  })();

  async function call(pathAndQuery, opts = {}) {
    const [path, qs] = pathAndQuery.split('?');
    if (path.startsWith('/api/cache/')) return IdbCache.handle(pathAndQuery, opts);

    // 除导入本身外，都等「补发导入书源」完成，避免列表/搜索漏掉用户自己的源
    if (path !== '/api/sources/import') { try { await boot; } catch (e) { } }

    if (path === '/api/sources/import') {
      const d = await request(pathAndQuery, opts);
      if (d && d.imported && d.imported.length) {
        const old = customList().filter(s => !d.imported.some(x => x.bookSourceUrl === s.bookSourceUrl));
        saveCustom(old.concat(d.imported));
      }
      return d;
    }

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
    ready: () => boot,
    book: (src, url) => call(`/api/book?src=${encodeURIComponent(src)}&url=${encodeURIComponent(url)}`),
    content: (src, url, bookUrl) => call(`/api/content?src=${encodeURIComponent(src)}&url=${encodeURIComponent(url)}&book=${encodeURIComponent(bookUrl || '')}`).then(x => x.text)
  };
})(window);
