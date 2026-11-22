/* ==========================================================================
   平台适配层 · Cloudflare 版
   ---------------------------------------------------------------------------
   /api/* 的请求在这里被分派：
     · 搜索 / 目录 / 正文  ->  浏览器里的 ShuyeEngine（engine.js）
     · 整本缓存           ->  IndexedDB（cache-idb.js）
     · 图片代理            ->  Worker 的 /api/img（img src 直接走，不经过这里）
   书源列表从同目录的 sources.json 懒加载，启用状态存 localStorage。
   ========================================================================== */
(function (global) {
  'use strict';

  const EN_KEY = 'shiyue.sources.enabled';
  let readyPromise = null;

  function enabledMap() {
    try { return JSON.parse(localStorage.getItem(EN_KEY) || '{}'); } catch (e) { return {}; }
  }
  function saveEnabled(map) {
    localStorage.setItem(EN_KEY, JSON.stringify(map));
  }

  async function boot() {
    const map = enabledMap();
    const res = await fetch('sources.json', { cache: 'force-cache' });
    const list = await res.json();
    list.forEach(s => { s.enabled = map[s._id] !== undefined ? map[s._id] !== false : (s.enabled !== false); });
    ShuyeEngine.load(list);
    return list;
  }

  function ensure() {
    if (!readyPromise) readyPromise = boot();
    return readyPromise;
  }

  const stats = () => {
    const all = ShuyeEngine.sources;
    return {
      total: all.length,
      enabled: all.filter(s => s.enabled !== false).length,
      ok: all.filter(s => s._status === 'ok').length
    };
  };

  async function handleSearch(q) {
    const key = q.get('key') || '';
    const limit = Number(q.get('limit') || 14);
    return ShuyeEngine.search(key, limit);
  }

  async function call(pathAndQuery, opts = {}) {
    const [path, qs] = pathAndQuery.split('?');
    const q = new URLSearchParams(qs || '');
    const body = opts.body ? (typeof opts.body === 'string' ? JSON.parse(opts.body) : opts.body) : {};

    // 缓存接口不依赖书源加载，先处理
    if (path.startsWith('/api/cache/')) return IdbCache.handle(pathAndQuery, opts);

    if (path === '/api/health') {
      await ensure();
      return { ok: true, port: 0, mode: 'cloudflare', sources: stats() };
    }

    if (path === '/api/sources') {
      await ensure();
      const rank = { ok: 0, untested: 1, part: 2, dead: 3 };
      const list = ShuyeEngine.sources.slice().sort((a, b) =>
        (rank[a._status] ?? 4) - (rank[b._status] ?? 4) || (a.bookSourceName || '').localeCompare(b.bookSourceName || '')
      ).map(s => ({
        id: s._id, name: ShuyeEngine.disp(s.bookSourceName), group: s.bookSourceGroup,
        host: ShuyeEngine.baseUrl(s).replace(/^https?:\/\//, ''),
        enabled: s.enabled !== false, status: s._status || 'untested',
        ms: s._audit && s._audit.ms, count: s._audit && s._audit.search,
        toc: s._audit && s._audit.toc, chars: s._audit && s._audit.content,
        sample: s._audit && s._audit.sample
      }));
      return { total: list.length, list };
    }

    if (path === '/api/sources/toggle') {
      await ensure();
      const s = ShuyeEngine.byId(body.id);
      if (!s) throw new Error('书源不存在');
      s.enabled = !!body.enabled;
      const map = enabledMap();
      map[s._id] = s.enabled; saveEnabled(map);
      return { ok: true, enabled: s.enabled };
    }

    if (path === '/api/sources/test') {
      await ensure();
      const s = ShuyeEngine.byId(body.id);
      if (!s) throw new Error('书源不存在');
      const t0 = performance.now();
      try {
        const rs = await ShuyeEngine.searchOne(s, body.key || '剑来', 1);
        const ms = Math.round(performance.now() - t0);
        return { ok: rs.length > 0, count: rs.length, ms, sample: rs[0] ? rs[0].name : '', status: rs.length ? 'ok' : 'dead' };
      } catch (e) {
        return { ok: false, err: String(e.message || e).slice(0, 80), status: 'dead' };
      }
    }

    if (path === '/api/sources/import') {
      await ensure();
      const arr = body.json ? (Array.isArray(body.json) ? body.json : [body.json]) : [];
      if (!arr.length) throw new Error('只支持粘贴书源 JSON（云端版不代抓远程地址）');
      const merged = ShuyeEngine.sources.filter(s => !arr.some(x => x.bookSourceUrl === s.bookSourceUrl));
      ShuyeEngine.load(merged.concat(arr));
      return { added: arr.length, total: ShuyeEngine.sources.length };
    }

    if (path === '/api/search') { await ensure(); return handleSearch(q); }

    if (path === '/api/book') {
      await ensure();
      const src = q.get('src'), url = q.get('url');
      if (!src || !url) throw new Error('缺少 src/url');
      return ShuyeEngine.book(src, url);
    }

    if (path === '/api/content') {
      await ensure();
      const src = q.get('src'), url = q.get('url'), bookUrl = q.get('book') || '';
      // 有整本缓存就直接用，命中时零网络
      const hit = await IdbCache.chapter(src, bookUrl, url);
      if (hit) return { text: hit, cached: true };
      return { text: await ShuyeEngine.content(src, url, bookUrl) };
    }

    throw new Error('未知接口：' + path);
  }

  global.PLAT = {
    mode: 'cloudflare',
    call,
    ready: ensure,
    book: (src, url) => call(`/api/book?src=${encodeURIComponent(src)}&url=${encodeURIComponent(url)}`),
    content: (src, url, bookUrl) => call(`/api/content?src=${encodeURIComponent(src)}&url=${encodeURIComponent(url)}&book=${encodeURIComponent(bookUrl || '')}`).then(x => x.text)
  };

  // 预热：首屏健康检查之前就开始加载书源
  ensure().catch(() => {});
})(window);
