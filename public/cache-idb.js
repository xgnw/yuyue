/* ==========================================================================
   离线缓存（浏览器本地版）
   ---------------------------------------------------------------------------
   为什么不是服务端：Vercel / Cloudflare 都没有"常驻进程 + 持久磁盘"，所以把
   "下载整本"这件事搬到浏览器，正文存进 IndexedDB。对外仍然暴露和原服务端
   一致的 /api/cache/* 契约，前端的进度条、删除缓存逻辑不用改。
   ========================================================================== */
(function (global) {
  'use strict';

  const DB = 'shiyue';
  const STORE = 'books';
  const VER = 1;
  const CONCURRENCY = 4;      // 同时抓几章（别把第三方站点打挂）
  const SAVE_EVERY = 4;       // 每抓几章落一次盘

  let dbp = null;
  const running = new Map();  // job -> record（内存里保留正在跑的任务）

  function openDB() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, VER);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const os = db.createObjectStore(STORE, { keyPath: 'key' });
          os.createIndex('job', 'job', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  }

  async function store(mode = 'readonly') {
    const db = await openDB();
    return db.transaction(STORE, mode).objectStore(STORE);
  }

  function reqP(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  /* 稳定 12 位 job id：同一本书从任何入口进来都是同一个缓存 */
  function bookKey(src, url) {
    const s = src + '|' + url;
    let h1 = 0x811c9dc5, h2 = 0x01000193;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      h1 = (h1 ^ c) * 16777619 >>> 0;
      h2 = (h2 + c * (i + 7)) * 2654435761 >>> 0;
    }
    return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')).slice(0, 12);
  }

  function bytesOf(chapters) {
    try { return new Blob([JSON.stringify(chapters)]).size; } catch (e) { return 0; }
  }

  async function getRecord(src, url) {
    const os = await store();
    return reqP(os.get(bookKey(src, url)));
  }

  async function putRecord(rec) {
    const os = await store('readwrite');
    return reqP(os.put(rec));
  }

  async function delRecord(src, url) {
    const os = await store('readwrite');
    return reqP(os.delete(bookKey(src, url)));
  }

  function view(rec) {
    if (!rec) return { job: bookKey('', ''), cached: false, state: 'none', done: 0, total: 0, failed: 0, size: 0, title: '' };
    return {
      job: rec.job, cached: rec.state === 'done' || rec.done >= rec.total && rec.total > 0,
      state: rec.state, done: rec.done, total: rec.total, failed: rec.failed,
      size: rec.size || bytesOf(rec.chapters), title: rec.title || '', updated: rec.updated
    };
  }

  /* ---------------------------------------------------------------- 下载 */
  async function runDownload(rec) {
    if (rec._alive) return;
    rec._alive = true;
    rec.state = 'running';
    let savedAt = 0;
    const queue = rec.order.filter(u => !rec.chapters[u]);
    rec.total = rec.order.length;
    rec.done = rec.order.length - queue.length;
    rec.failed = 0;

    let cursor = 0;
    const workers = new Array(Math.min(CONCURRENCY, queue.length || 1)).fill(0).map(async () => {
      while (cursor < queue.length) {
        const url = queue[cursor++];
        try {
          const text = await global.PLAT.content(rec.src, url, rec.bookUrl);
          if (text && text.trim()) { rec.chapters[url] = text; rec.done++; }
          else { rec.failed++; }
        } catch (e) {
          rec.failed++;
        }
        if (rec.done - savedAt >= SAVE_EVERY) {
          savedAt = rec.done;
          rec.size = bytesOf(rec.chapters);
          rec.updated = Date.now();
          await putRecord(strip(rec));
        }
      }
    });
    await Promise.all(workers);

    rec.size = bytesOf(rec.chapters);
    rec.updated = Date.now();
    rec.state = rec.done > 0 ? 'done' : 'error';
    if (rec.state === 'error') rec.err = '所有章节都失败了，换个书源试试';
    rec._alive = false;
    await putRecord(strip(rec));
    running.delete(rec.job);
  }

  /* 不把运行时字段（下划线开头、Map）写进 IndexedDB */
  function strip(rec) {
    const out = {};
    for (const k of Object.keys(rec)) if (!k.startsWith('_')) out[k] = rec[k];
    return out;
  }

  async function start(src, url, title) {
    const existing = await getRecord(src, url);
    if (existing && existing.state === 'running' && running.has(existing.job)) return view(existing);

    const job = bookKey(src, url);
    const rec = existing || {
      key: bookKey(src, url), job, src, bookUrl: url, title: title || '',
      chapters: {}, order: [], done: 0, total: 0, failed: 0, size: 0,
      state: 'running', updated: Date.now()
    };
    rec.title = title || rec.title || '';
    rec.job = job;

    // 目录：走平台层拿（HTTP 版是 /api/book，CF 版是浏览器引擎）
    const meta = await global.PLAT.book(src, url);
    rec.order = (meta.chapters || []).map(c => c.url);
    rec.names = {};
    (meta.chapters || []).forEach(c => { rec.names[c.url] = c.name; });
    if (meta.name) rec.title = meta.name;
    rec.total = rec.order.length;
    rec.state = 'running';
    rec.updated = Date.now();
    running.set(job, rec);
    await putRecord(strip(rec));
    runDownload(rec);      // 后台跑，不阻塞这次请求
    return view(rec);
  }

  /* ---------------------------------------------------------------- 对外 API */
  const api = {
    async info(src, url) {
      const rec = running.get(bookKey(src, url)) || await getRecord(src, url);
      return view(rec);
    },

    async status(job) {
      for (const rec of running.values()) if (rec.job === job) return view(rec);
      const os = await store();
      const found = await reqP(os.index('job').get(job));
      return view(found);
    },

    async start(src, url, title) { return start(src, url, title); },

    async remove(src, url) {
      await delRecord(src, url);
      running.delete(bookKey(src, url));
      return { removed: true, job: bookKey(src, url) };
    },

    async list() {
      const os = await store();
      const all = await reqP(os.getAll());
      const list = all.map(r => ({
        job: r.job, title: r.title, author: r.author || '', sourceName: r.sourceName || '',
        bookUrl: r.bookUrl, chapters: r.total, size: r.size, updated: r.updated
      }));
      return { total: list.length, list: list.sort((a, b) => (b.updated || 0) - (a.updated || 0)) };
    },

    /* 读正文前先查本地；命中就完全不走网络 */
    async chapter(src, bookUrl, url) {
      const rec = await getRecord(src, bookUrl);
      return (rec && rec.chapters && rec.chapters[url]) || '';
    },

    /* 把 /api/cache/* 的请求分派进来 */
    async handle(pathAndQuery, opts) {
      const q = new URLSearchParams(pathAndQuery.split('?')[1] || '');
      const path = pathAndQuery.split('?')[0];
      const body = opts && opts.body ? (typeof opts.body === 'string' ? JSON.parse(opts.body) : opts.body) : {};
      if (path === '/api/cache/info') return api.info(q.get('src'), q.get('url'));
      if (path === '/api/cache/status') return api.status(q.get('job'));
      if (path === '/api/cache/list') return api.list();
      if (path === '/api/cache/start') return api.start(body.src, body.url, body.title);
      if (path === '/api/cache/remove') return api.remove(body.src, body.url);
      throw new Error('unknown cache api: ' + path);
    }
  };

  global.IdbCache = api;
})(window);
