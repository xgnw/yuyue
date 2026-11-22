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
  const CUSTOM_KEY = 'shiyue.sources.custom';
  const REM_KEY = 'shiyue.sources.removed';
  const ST_KEY = 'shiyue.sources.status';
  let readyPromise = null;

  function enabledMap() {
    try { return JSON.parse(localStorage.getItem(EN_KEY) || '{}'); } catch (e) { return {}; }
  }
  function saveEnabled(map) {
    localStorage.setItem(EN_KEY, JSON.stringify(map));
  }
  // 用户自己导入的书源存本地，刷新后还在
  function customList() {
    try { const a = JSON.parse(localStorage.getItem(CUSTOM_KEY) || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; }
  }
  function saveCustom(list) {
    // 只留必要的几个字段，避免 localStorage 超限
    const slim = list.map(s => ({
      bookSourceName: s.bookSourceName, bookSourceUrl: s.bookSourceUrl, bookSourceGroup: s.bookSourceGroup,
      bookSourceType: s.bookSourceType, header: s.header,
      enabled: s.enabled !== false, searchUrl: s.searchUrl,
      ruleSearch: s.ruleSearch, ruleBookInfo: s.ruleBookInfo, ruleToc: s.ruleToc, ruleContent: s.ruleContent
    }));
    try { localStorage.setItem(CUSTOM_KEY, JSON.stringify(slim)); } catch (e) { /* 超限就只保留本次会话 */ }
  }

  // 删掉的书源按 URL 记账，下次加载不再出现（重新导入同一个源会自动恢复）
  function removedMap() {
    try { const m = JSON.parse(localStorage.getItem(REM_KEY) || '{}'); return (m && typeof m === 'object') ? m : {}; } catch (e) { return {}; }
  }
  function saveRemoved(m) {
    try { localStorage.setItem(REM_KEY, JSON.stringify(m)); } catch (e) { }
  }

  // 手动测试出来的状态（按 URL 记），刷新后仍然生效，也用于排序和「清理失效」
  function statusMap() {
    try { const m = JSON.parse(localStorage.getItem(ST_KEY) || '{}'); return (m && typeof m === 'object') ? m : {}; } catch (e) { return {}; }
  }
  function saveStatus(url, status) {
    const m = statusMap();
    m[url] = status;
    try { localStorage.setItem(ST_KEY, JSON.stringify(m)); } catch (e) { }
  }

  async function boot() {
    const map = enabledMap();
    const removed = removedMap();
    const st = statusMap();
    const res = await fetch('sources.json', { cache: 'force-cache' });
    const list = await res.json();
    const urls = new Set(list.map(s => s.bookSourceUrl));
    const custom = customList().filter(s => s && (s.bookSourceUrl || s.bookSourceName) && !urls.has(s.bookSourceUrl));
    const all = list.concat(custom).filter(s => !removed[s.bookSourceUrl]);
    all.forEach(s => {
      s.enabled = map[s._id || s.bookSourceUrl] !== undefined ? map[s._id || s.bookSourceUrl] !== false : (s.enabled !== false);
      const t = s.bookSourceUrl && st[s.bookSourceUrl];
      if (t) s._status = t;
    });
    ShuyeEngine.load(all);
    return all;
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
    const limit = Number(q.get('limit') || 400);
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
        url: s.bookSourceUrl,
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

    if (path === '/api/sources/delete') {
      await ensure();
      const urls = (Array.isArray(body.urls) ? body.urls : [body.url]).filter(Boolean);
      if (!urls.length) throw new Error('缺少要删除的书源地址');
      const rm = removedMap();
      urls.forEach(u => { rm[u] = 1; });
      saveRemoved(rm);
      const keep = ShuyeEngine.sources.filter(s => !rm[s.bookSourceUrl]);
      ShuyeEngine.load(keep);
      return { ok: true, total: ShuyeEngine.sources.length, removed: urls.length, urls };
    }

    if (path === '/api/sources/purge') {
      await ensure();
      const dead = ShuyeEngine.sources.filter(s => s._status === 'dead' && s.bookSourceUrl);
      if (!dead.length) return { ok: true, total: ShuyeEngine.sources.length, removed: 0 };
      const rm = removedMap();
      dead.forEach(s => { rm[s.bookSourceUrl] = 1; });
      saveRemoved(rm);
      const deadUrls = dead.map(s => s.bookSourceUrl);
      ShuyeEngine.load(ShuyeEngine.sources.filter(s => !rm[s.bookSourceUrl]));
      return { ok: true, total: ShuyeEngine.sources.length, removed: dead.length, urls: deadUrls };
    }

    if (path === '/api/sources/test') {
      await ensure();
      const s = ShuyeEngine.byId(body.id);
      if (!s) throw new Error('书源不存在');
      const t0 = performance.now();
      try {
        const rs = await ShuyeEngine.searchOne(s, body.key || '剑来', 1);
        const ms = Math.round(performance.now() - t0);
        // 只测了搜索这一环：能搜到就算「至少可搜索」，原来全链路可用的继续保持
        const status = rs.length ? (s._status === 'ok' ? 'ok' : 'part') : 'dead';
        s._status = status;
        if (s.bookSourceUrl) saveStatus(s.bookSourceUrl, status);
        return { ok: rs.length > 0, count: rs.length, ms, sample: rs[0] ? rs[0].name : '', status };
      } catch (e) {
        s._status = 'dead';
        if (s.bookSourceUrl) saveStatus(s.bookSourceUrl, 'dead');
        return { ok: false, err: String(e.message || e).slice(0, 80), status: 'dead' };
      }
    }

    if (path === '/api/sources/import') {
      await ensure();
      let arr = [];
      if (body.json) {
        arr = Array.isArray(body.json) ? body.json : [body.json];
      } else if (body.url) {
        // 云端版没有服务器，用 Worker 的 /p 代理去拉 JSON（同域，不受 CORS 限制）
        let resp;
        try {
          resp = await fetch('/p?u=' + encodeURIComponent(body.url), { headers: { accept: 'application/json,*/*' } });
        } catch (e) {
          throw new Error('拉取书源地址失败：' + (e.message || e));
        }
        if (!resp.ok) throw new Error('拉取书源失败：HTTP ' + resp.status);
        const txt = await resp.text();
        let data;
        try {
          data = JSON.parse(txt);
        } catch (e) {
          throw new Error('该地址返回的是网页不是 JSON，请填书源 JSON 导出地址（如 …/shuyuan/json）');
        }
        arr = Array.isArray(data) ? data : [data];
        // 兼容 {sources:[...]} / {data:[...]} / {list:[...]} 这类包一层的合集
        if (arr.length <= 1 && !(arr[0] && (arr[0].bookSourceUrl || arr[0].bookSourceName))) {
          const inner = data && (data.sources || data.data || data.list);
          if (Array.isArray(inner)) arr = inner;
        }
        arr = arr.filter(x => x && (x.bookSourceUrl || x.bookSourceName));
      }
      if (!arr.length) throw new Error('没有解析到书源，请检查地址或粘贴 JSON');
      // 过滤掉跑不了的 JS 源（Worker/浏览器都不能 eval），并去掉重复 URL
      const bad = s => ['searchUrl', 'ruleSearch', 'ruleBookInfo', 'ruleToc', 'ruleContent'].some(k => {
        const v = s[k];
        if (typeof v === 'string') return /(@js:|<js>|java\.)/.test(v);
        if (v && typeof v === 'object') return Object.values(v).some(x => typeof x === 'string' && /(@js:|<js>|java\.)/.test(x));
        return false;
      });
      const jsCount = arr.filter(bad).length;
      arr = arr.filter(s => !bad(s));
      const seen = new Set();
      arr = arr.filter(s => { const u = s.bookSourceUrl || ''; if (seen.has(u)) return false; seen.add(u); return true; });
      if (!arr.length) throw new Error(`全部 ${jsCount} 个源都用了 JS 规则，云端版跑不了`);
      const rest = ShuyeEngine.sources.filter(s => !arr.some(x => x.bookSourceUrl === s.bookSourceUrl));
      ShuyeEngine.load(rest.concat(arr));
      // 新导入的写进 localStorage（同 URL 的旧条目先剔掉），刷新后仍在
      const oldCustom = customList().filter(s => !arr.some(x => x.bookSourceUrl === s.bookSourceUrl));
      saveCustom(oldCustom.concat(arr));
      // 之前删过的源一旦重新导入，就把它从「已删除」名单里去掉
      const rm = removedMap();
      arr.forEach(x => { delete rm[x.bookSourceUrl]; });
      saveRemoved(rm);
      return { added: arr.length, total: ShuyeEngine.sources.length, skippedJs: jsCount };
    }

    if (path === '/api/sources/export') {
      // 导出「当前生效」的整份列表（内置 + 导入 - 删除），拿去合并进仓库 sources.json
      await ensure();
      const KEEP = ['bookSourceName', 'bookSourceUrl', 'bookSourceGroup', 'bookSourceType',
        'enabled', 'header', 'searchUrl', 'ruleSearch', 'ruleBookInfo', 'ruleToc', 'ruleContent'];
      const list = ShuyeEngine.sources.map(s => {
        const o = {};
        KEEP.forEach(k => { if (s[k] !== undefined && s[k] !== '' && s[k] !== null) o[k] = s[k]; });
        return o;
      });
      return { ok: true, count: list.length, list };
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
