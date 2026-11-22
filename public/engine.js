/* ==========================================================================
   愉阅 · 浏览器书源引擎（Cloudflare 版）
   ---------------------------------------------------------------------------
   和本地 Python 版（srlib.py）同构：一个书源 = 一份 JSON，规则就是
   "URL 模板 + 选择器链 + 正则替换"。这里把同一套思路搬到浏览器：
     · XPath 走原生 document.evaluate，CSS 走 querySelectorAll，零解析依赖
     · 跨域请求交给同域 Worker 代理（/p），补 UA / Referer，绕 CORS
     · 正文缓存进 IndexedDB（见 cache-idb.js）
   支持：class./tag./id. 简写、@css:、@xpath:、@json:、text/textNodes/html/
        ownText/href/src/@attr、.i 与 !i 取第几个、逗号并列、&& 合并、|| 兜底、
        ## 正则替换、{{key}}/{{page}}/{{baseUrl}}/{{@@rule}} 模板。
   不支持：<js> 脚本规则、@webview:、登录态站点（构建期会被过滤掉）。
   ========================================================================== */
(function (global) {
  'use strict';

  const PROXY = '/p';
  const TIMEOUT = 15000;
  const NAV = ['返回', '首页', '设置', '关灯', '开灯', '目录', '书架', '搜索', '加入书签', '手机阅读', '电脑版', '举报'];

  /* ------------------------------------------------------------ 抓页面 */
  async function fetchRaw(url, opt = {}) {
    const headers = {};
    if (opt.method === 'POST') {
      headers['x-target'] = url;
      if (opt.contentType) headers['x-target-type'] = opt.contentType;
    }
    const q = new URLSearchParams();
    if (opt.method !== 'POST') q.set('u', url);
    if (opt.referer) q.set('r', opt.referer);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), opt.timeout || TIMEOUT);
    let res;
    try {
      res = await fetch(PROXY + '?' + q.toString(), {
        method: opt.method === 'POST' ? 'POST' : 'GET',
        headers, body: opt.method === 'POST' ? opt.body : undefined, signal: ctl.signal
      });
    } finally { clearTimeout(timer); }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const buf = await res.arrayBuffer();
    return { text: decode(buf, res.headers.get('content-type') || ''), finalUrl: res.headers.get('x-final-url') || url };
  }

  /* GBK / GB2312 站点不少：先看响应头，再看 HTML 里的 meta */
  function decode(buf, ctype) {
    let charset = (/charset=([\w-]+)/i.exec(ctype) || [])[1] || '';
    if (!charset) {
      const head = new TextDecoder('latin1').decode(buf.slice(0, 2048));
      const m = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head);
      charset = m ? m[1] : 'utf-8';
    }
    charset = charset.toLowerCase();
    try { return new TextDecoder(charset === 'gb2312' ? 'gbk' : charset).decode(buf); }
    catch (e) { return new TextDecoder('utf-8').decode(buf); }
  }

  const parseHTML = html => new DOMParser().parseFromString(html, 'text/html');

  function abs(base, href) {
    if (!href) return '';
    try { return new URL(href, base).toString(); } catch (e) { return href; }
  }

  /* --------------------------------------------------- 一步选择器解析 */
  // tag.a.2 / ul.1 / p.p2.1 / tr!0 / li[0] / class.x / #id / .cls / [attr=v]
  function parseStep(step) {
    let m = step.match(/^(.+)\!(\d+)$/);
    if (m) return { sel: m[1], idx: Number(m[2]) };
    m = step.match(/^(.+?)\[(\d+)\]$/);
    if (m && !step.startsWith('[')) return { sel: m[1], idx: Number(m[2]) };
    m = step.match(/^(.+)\.(\d+)$/);
    if (m && !/^\d+$/.test(m[1].replace(/^\./, ''))) return { sel: m[1], idx: Number(m[2]) };
    return { sel: step, idx: -1 };
  }

  function cssOf(sel) {
    if (sel.startsWith('class.')) return '.' + sel.slice(6).trim();
    if (sel.startsWith('id.')) return '#' + sel.slice(3).trim();
    if (sel.startsWith('tag.')) return sel.slice(4).trim();
    return sel;
  }

  function qsa(root, css) {
    // [property~=category|status] 这种多值属性展开成并列选择器
    const multi = css.match(/\[([\w-]+)([~|^$*]?=)([^[\]]*\|[^[\]]*)\]/);
    if (multi) {
      const list = multi[3].split('|').map(v => `[${multi[1]}${multi[2]}${v}]`).join(',');
      try { return Array.from(root.querySelectorAll(list)); } catch (e) { return []; }
    }
    try { return Array.from(root.querySelectorAll(css)); } catch (e) { return []; }
  }

  function xpathAll(root, expr) {
    const doc = root.ownerDocument || root;
    try {
      const snap = doc.evaluate(expr, root, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      const out = [];
      for (let i = 0; i < snap.snapshotLength; i++) out.push(snap.snapshotItem(i));
      return out;
    } catch (e) { return []; }
  }

  /* --------------------------------------------------- JSONPath（够用版） */
  function jsonPath(data, path) {
    path = path.replace(/^@json:/, '').replace(/^json:/, '').trim();
    if (path.startsWith('$')) path = path.slice(1);
    const tokens = [];
    let i = 0;
    while (i < path.length) {
      if (path[i] === '.') { i++; if (path[i] === '.') { tokens.push({ t: 'deep' }); i++; } }
      if (path[i] === '[') {
        const end = path.indexOf(']', i);
        const inner = path.slice(i + 1, end);
        if (inner === '*') tokens.push({ t: 'all' });
        else if (/^\d+$/.test(inner)) tokens.push({ t: 'idx', v: Number(inner) });
        else tokens.push({ t: 'key', v: inner.replace(/['"]/g, '') });
        i = end + 1; continue;
      }
      let j = i;
      while (j < path.length && !'.[]'.includes(path[j])) j++;
      if (j > i) tokens.push({ t: 'key', v: path.slice(i, j) });
      i = j;
    }
    let cur = [data];
    for (const tk of tokens) {
      const next = [];
      for (const v of cur) {
        if (tk.t === 'key') { if (v && typeof v === 'object' && v[tk.v] !== undefined) next.push(v[tk.v]); }
        else if (tk.t === 'idx') { if (Array.isArray(v) && v[tk.v] !== undefined) next.push(v[tk.v]); }
        else if (tk.t === 'all') {
          if (Array.isArray(v)) next.push(...v);
          else if (v && typeof v === 'object') next.push(...Object.values(v));
        } else if (tk.t === 'deep') {
          const want = tk.v;
          const walk = x => {
            if (x && typeof x === 'object') {
              if (want && x[want] !== undefined) next.push(x[want]);
              Object.values(x).forEach(walk);
            }
          };
          walk(v);
        }
      }
      cur = next;
    }
    return cur;
  }

  /* --------------------------------------------------- 文本 / HTML 提取 */
  function textOf(v) {
    if (Array.isArray(v)) return v.length ? textOf(v[0]) : '';
    if (typeof v === 'string') return v.trim();
    if (!v) return '';
    if (!v.nodeType) return objText(v);
    return (v.textContent || '').replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  }

  function objText(v) {
    if (v == null) return '';
    if (typeof v === 'string' || typeof v === 'number') return String(v);
    if (Array.isArray(v)) return v.map(objText).join('\n');
    return Object.values(v).map(objText).filter(Boolean).join('\n');
  }

  // textNodes：保留 <br> 和块级元素的换行，正文清洗要用
  function textNodesOf(node) {
    if (typeof node === 'string') return node.trim();
    let out = '';
    const walk = n => {
      for (const c of n.childNodes) {
        if (c.nodeType === 3) out += c.nodeValue;
        else if (c.nodeType === 1) {
          const tag = c.tagName.toLowerCase();
          if (tag === 'br') { out += '\n'; continue; }
          const block = /^(p|div|li|h\d|tr|section|article|blockquote)$/.test(tag);
          if (block) out += '\n';
          walk(c);
          if (block) out += '\n';
        }
      }
    };
    walk(node);
    return out.replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  }

  function htmlToText(html) {
    if (!html) return '';
    if (!/<[a-z]/i.test(html)) return html;
    const doc = parseHTML('<body><div id="__r">' + html + '</div></body>');
    const box = doc.getElementById('__r');
    return box ? textNodesOf(box) : html;
  }

  /* --------------------------------------------------- 规则求值 */
  // 顶层切分：忽略 {{}} 里的分隔符和引号
  function splitTop(str, sep) {
    const out = []; let buf = '', depth = 0, quote = '';
    for (let i = 0; i < str.length; i++) {
      const c = str[i];
      if (quote) { buf += c; if (c === quote) quote = ''; continue; }
      if (c === '"' || c === "'") { quote = c; buf += c; continue; }
      if (c === '{') depth++;
      if (c === '}') depth--;
      if (depth <= 0 && str.startsWith(sep, i)) { out.push(buf); buf = ''; i += sep.length - 1; continue; }
      buf += c;
    }
    out.push(buf);
    return out;
  }

  function applyTemplates(str, ctx) {
    if (!str || !str.includes('{{')) return str;
    return str.replace(/\{\{([^{}]+)\}\}/g, (_, inner) => {
      const t = inner.trim();
      if (t === 'key') return ctx.key || '';
      if (t === 'page') return String(ctx.page || 1);
      if (t === 'baseUrl' || t === 'base') return ctx.sourceUrl || '';
      if (t === 'chapter.title') return ctx.chapterTitle || '';
      if (t.startsWith('@@')) return textOf(selVals(t.slice(2), ctx.root, ctx));
      if (t.startsWith('$')) return textOf(jsonPath(ctx.json !== undefined ? ctx.json : ctx.root, t));
      return '';
    });
  }

  // 把规则求成"节点或值"的列表
  function selNodes(rule, root, ctx = {}) {
    if (rule == null) return [];
    rule = String(rule).trim();
    if (!rule) return [];
    if (rule.includes('<js>') || rule.startsWith('@js:') || rule.startsWith('@webview:')) return [];

    rule = applyTemplates(rule, ctx);

    if (rule.startsWith('@css:')) return qsa(root, rule.slice(5).trim());
    if (rule.startsWith('@xpath:') || rule.startsWith('//') || rule.startsWith('(')) return xpathAll(root, rule.slice(rule.startsWith('@xpath:') ? 7 : 0).trim());
    if (rule.startsWith('@json:') || /^\$[.[]/.test(rule)) return jsonPath(ctx.json !== undefined ? ctx.json : root, rule);

    let items = [root];
    for (const stepRaw of splitTop(rule, '@')) {
      const step = stepRaw.trim();
      if (!step) continue;

      // 终止字段
      if (/^(text|textNodes|html|ownText|all|content|href|src)$/.test(step) || /^@[\w-]+$/.test(step)) {
        const field = step.replace(/^@/, '');
        return items.map(it => fieldOf(it, field)).filter(v => v !== '');
      }

      // 当前是 JSON 对象/数组：按键或 JSONPath 取
      if (items.length && items.every(x => x && typeof x === 'object' && !x.nodeType)) {
        if (step === '[*]') { items = items.flatMap(x => Array.isArray(x) ? x : Object.values(x)); continue; }
        if (step.startsWith('$')) { items = items.flatMap(x => jsonPath(x, step)); continue; }
        const key = step.replace(/^\./, '');
        items = items.flatMap(x => (x && typeof x === 'object' && x[key] !== undefined) ? [x[key]] : []);
        continue;
      }

      const { sel, idx } = parseStep(step);
      let nodes;
      if (sel.startsWith('xpath:')) nodes = xpathAll(root, sel.slice(6));
      else {
        nodes = [];
        for (const g of splitTop(cssOf(sel), ',').map(s => s.trim()).filter(Boolean)) {
          for (const it of items) {
            if (it.nodeType === 1 || it.nodeType === 9) nodes.push(...qsa(it, g));
          }
        }
      }
      items = idx >= 0 ? (nodes[idx] ? [nodes[idx]] : []) : nodes;
      if (!items.length) return [];
    }
    return items;
  }

  function fieldOf(node, field) {
    if (typeof node === 'string') return node.trim();
    if (node == null) return '';
    if (!node.nodeType) return objText(node);
    if (field === 'text') return textOf(node);
    if (field === 'ownText') return (node.textContent || '').trim();
    if (field === 'textNodes') return textNodesOf(node);
    if (field === 'html') return node.innerHTML || '';
    if (field === 'all') return node.outerHTML || '';
    if (field === 'href') return node.getAttribute ? (node.getAttribute('href') || '') : '';
    if (field === 'src') return node.getAttribute ? (node.getAttribute('src') || '') : '';
    if (field === 'content') return node.getAttribute ? (node.getAttribute('content') || '') : '';
    return node.getAttribute ? (node.getAttribute(field) || '') : '';
  }

  // 把规则求成字符串（同名书源规则里 90% 都是取一个值）
  function selVals(rule, root, ctx = {}) {
    if (rule == null) return '';
    rule = String(rule).trim();
    if (!rule) return '';
    if (rule.includes('<js>') || rule.startsWith('@js:') || rule.startsWith('@webview:')) return '';

    // || 兜底取第一个非空
    if (rule.includes('||')) {
      for (const p of splitTop(rule, '||')) {
        const v = selVals(p, root, ctx);
        if (v) return v;
      }
      return '';
    }

    // && 合并（用空格连起来）
    if (rule.includes('&&')) {
      return splitTop(rule, '&&').map(p => selVals(p, root, ctx)).filter(Boolean).join(' ');
    }

    // ## 正则替换：rule##pattern##replacement
    if (rule.includes('##')) {
      const parts = rule.split('##');
      const base = parts.shift();
      let s = selVals(base, root, ctx);
      for (let i = 0; i + 1 < parts.length; i += 2) {
        if (!parts[i]) continue;
        try { s = s.replace(new RegExp(parts[i], 'g'), parts[i + 1] || ''); } catch (e) { }
      }
      return applyTemplates(s, ctx);
    }

    const nodes = selNodes(rule, root, ctx);
    if (!nodes.length) return '';
    return nodes.map(n => (typeof n === 'string' ? n.trim() : textOf(n))).filter(Boolean).join('\n');
  }

  /* ------------------------------------------------------------ 正文清洗 */
  function cleanText(raw) {
    if (!raw) return '';
    let s = String(raw).replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');
    const kills = [
      /本章未完[^\n]{0,40}(点击|继续)[^\n]{0,20}/g, /请记住(本书|本站)[^\n]{0,40}/g, /最新网址[：:]?[^\n]{0,60}/g,
      /[（(]?\s*[^\s（）()]{0,24}(www\.|http|ωωω|ｗｗｗ)[^\s（）()]{0,40}\s*[）)]/gi,
      /佰度搜索[^\n]{0,40}/g, /[^\n]{0,30}(免费下载|全集TXT|电子书)[^\n]{0,20}/g,
      /[^\n]{0,20}(一秒记住|一秒記住)[^\n]{0,40}/g, /[^\n]{0,20}手机用户请浏览[^\n]{0,40}/gi,
      // 站点横幅：【悠久小説網ωωω.ＵＪХＳw.ｎｅｔ】，免费小说无弹窗免费阅读！
      /【[^】]{0,20}(网|網|站|ωωω|ＵＪ)[^】]*】[^\n]{0,40}/g,
      /^[^\n]{0,60}(免费阅读|无弹窗|免费小说)[^\n]{0,40}$/gm,
    ];
    kills.forEach(re => { s = s.replace(re, ''); });

    const out = [];
    for (const l of s.split(/\n+/).map(x => x.trim()).filter(Boolean)) {
      if (l.length <= 30 && /(最新章节|目\s*录|上一章|下一章|加入书架|投推荐票|手机阅读|本章未完|最新网址|请收藏|无弹窗|免费阅读|免费小说|首发)/.test(l)) continue;
      if (l.length <= 60 && /(文字手打|章节列表|请记住|首发域名|本站|书友|笔趣阁|书库|顶点|全文阅读|返回目录|电脑版|手机版|加入书签|求月票|求推荐票|章节报错)/.test(l)) continue;
      if (l.length <= 200 && /(https?:\/\/|www\.|ωωω|ｗｗｗ)/.test(l) && !/[。！？，]/.test(l.slice(0, 40))) continue;
      out.push(l);
    }
    // ① 导航菜单块：开头连续几十行都是"玄幻/言情/总裁"这类 2~12 字纯词条，
    //    只有后面确实出现正常段落时才整块丢掉（散文开头的短句不能误伤）
    const hasProseAfter = (idx, span = 40) => {
      for (let j = idx; j < Math.min(out.length, idx + span); j++) {
        if (out[j].length >= 18 && /[。！？]/.test(out[j])) return true;
      }
      return false;
    };
    let cut = 0;
    while (cut < out.length && cut < 30) {
      const h = out[cut];
      if (h.length <= 12 && !/[，。！？、；“”‘’…—]/.test(h.replace(/[：:]$/, ''))) { cut++; continue; }
      break;
    }
    if (cut > 0 && hasProseAfter(cut)) out.splice(0, cut);

    // ② 菜单之后的页面大标题 / 页眉 / 站点自我介绍，逐条往下剥
    const isJunk = h =>
      NAV.includes(h) ||
      /^(?:[\w$]+(?:\.[\w$]+)?\(\s*\)\s*;?\s*)+$/.test(h) ||
      /[（(]\s*第\s*\d+\s*\/\s*\d+\s*页\s*[）)]/.test(h) ||
      (h.length <= 10 && !/[，。！？、；：“”‘’…—]/.test(h)) ||
      (h.length <= 14 && /[：:]$/.test(h) && !/[，。！？、；“”‘’…—]/.test(h.replace(/[：:]$/, ''))) ||
      (/第[0-9零一二三四五六七八九十百千]+章/.test(h) && /[_|｜\-–~]/.test(h) && !/[。！？]/.test(h.slice(-1))) ||
      (h.length <= 80 && /小说网|书城|书吧|文学网/.test(h) && /下载|阅读|提供|收藏|免费|全本/.test(h)) ||
      (h.length <= 40 && /第[0-9零一二三四五六七八九十百千]+章/.test(h) && !/[。！？，]/.test(h)) ||
      (h.length <= 60 && /作\s*者/.test(h) && /更新|时间/.test(h));

    let dropped = 0;
    while (out.length && dropped < 40 && isJunk(out[0])) { out.shift(); dropped++; }
    return out.join('\n\n');
  }

  /* ------------------------------------------------------------ 简介清洗 */
  // 不少源把"书名是作者X精心创作的小说，本站提供免费阅读…"整段当简介，这里按句剔除
  const NOISE_SENT = /(提供免费|免费阅读|免费小说|网友上传|整理而成|版权属|版权归|24小时|请收藏|本站|首发|无弹窗|更新最快|更多精彩|精心创作|非常好看|小说阅读网|笔趣阁|最快更新|加入书签|TXT下载|求收藏|求推荐|请记住)/;
  const NOISE_TPL = /^(?:[^,，]{1,20}[,，])?[^,，]{1,20}是作者[\u4e00-\u9fa5A-Za-z0-9_]{1,12}[^。]{0,40}(?:小说|作品)/;

  function cleanIntro(v) {
    let s = String(v || '').replace(/\s+/g, ' ').trim();
    s = s.replace(/^[简簡]介[：:]\s*/, '');
    s = s.replace(/\s*[（(][^（）()]{0,40}(www\.|http|\.com|\.info|\.org)[^（）()]{0,40}[）)]/gi, '');
    s = s.replace(/[，,]?\s*(TXT|txt|全文)?下载/g, '');
    s = s.replace(/[，,]?\s*(免费阅读|无弹窗|最新章节|全文阅读)[，,]?/g, '');
    s = s.split(/(?<=[。！？!?])/).filter(p => p && !NOISE_SENT.test(p)).join('');
    s = s.replace(NOISE_TPL, '');
    return s.replace(/^[ ，,。.;；]+|[ ，,。.;；]+$/g, '').trim();
  }

  /* ------------------------------------------------------------ 书源 */
  let SOURCES = [];
  let BY_ID = new Map();

  function disp(name) {
    return String(name || '').replace(/[\u{1F000}-\u{1FAFF}\u2190-\u21FF\u2600-\u27BF\u2B00-\u2BFF\uFE0F]/gu, '').trim() || '书源';
  }

  function load(list) {
    SOURCES = (list || []).filter(Boolean).map(s => Object.assign({}, s, { _id: s._id || s.bookSourceUrl }));
    BY_ID = new Map(SOURCES.map(s => [s._id, s]));
    return SOURCES;
  }

  const byId = id => BY_ID.get(id);
  const baseUrl = s => String(s.bookSourceUrl || '').replace(/\/+$/, '');
  const enabled = s => s.enabled !== false;

  /* 含脚本/登录的规则浏览器端跑不了（构建期也会再过滤一次） */
  function supported(s) {
    const blob = [s.searchUrl, JSON.stringify(s.ruleSearch || {}), JSON.stringify(s.ruleBookInfo || {}),
                  JSON.stringify(s.ruleToc || {}), JSON.stringify(s.ruleContent || {})].join(' ');
    return !/<js>|@js:|@webview:|java\./.test(blob);
  }

  /* 搜索地址可能是 "path,{\"method\":\"POST\",\"body\":\"...\"}" */
  function searchRequest(s, key, page = 1) {
    let raw = String(s.searchUrl || '').trim();
    let opt = { method: 'GET', body: '', contentType: '' };
    const brace = raw.indexOf(',{');
    if (brace > 0) {
      try {
        const cfg = JSON.parse(raw.slice(brace + 1));
        raw = raw.slice(0, brace);
        opt.method = String(cfg.method || 'GET').toUpperCase();
        opt.body = cfg.body || '';
        opt.contentType = 'application/x-www-form-urlencoded' + (cfg.charset === 'gbk' ? '; charset=gbk' : '');
      } catch (e) { }
    }
    const enc = encodeURIComponent(key);
    const url = abs(baseUrl(s) + '/', raw.replace(/\{\{key\}\}/g, enc).replace(/\{\{page\}\}/g, String(page)));
    return {
      url, method: opt.method,
      body: opt.body ? opt.body.replace(/\{\{key\}\}/g, enc).replace(/\{\{page\}\}/g, String(page)) : '',
      contentType: opt.contentType
    };
  }

  function normalizeItem(rec, pageUrl, s) {
    const name = String(rec.name || '').trim().replace(/^《|》$/g, '');
    const url = abs(pageUrl, rec.url || '');
    if (!name || !url) return null;
    return {
      name, url,
      author: String(rec.author || '').replace(/^作者[：:]\s*/, '').trim(),
      cover: rec.cover ? abs(pageUrl, rec.cover) : '',
      intro: cleanIntro(rec.intro),
      kind: String(rec.kind || '').trim(),
      lastChapter: String(rec.lastChapter || '').trim(),
      sourceId: s._id, sourceName: disp(s.bookSourceName)
    };
  }

  async function searchOne(s, key, page = 1) {
    if (!supported(s)) throw new Error('脚本规则，浏览器版不支持');
    const req = searchRequest(s, key, page);
    const pageRes = await fetchRaw(req.url, { method: req.method, body: req.body, contentType: req.contentType, referer: baseUrl(s) + '/', timeout: 9000 });
    const doc = parseHTML(pageRes.text);
    const rs = s.ruleSearch || {};
    const ctx = { root: doc, sourceUrl: baseUrl(s), key, page };

    let items = selNodes(rs.bookList, doc, ctx);
    if (!items.length) return [];

    const out = [];
    for (const item of items.slice(0, 8)) {
      const ictx = item.nodeType ? Object.assign({}, ctx, { root: item, json: undefined })
                                 : Object.assign({}, ctx, { root: doc, json: item });
      // JSON 源里字段规则常写成 $.title，也可能只写 title
      const pick = (rule) => {
        if (!rule) return '';
        if (!item.nodeType && typeof item === 'object' && /^[\w]+$/.test(rule)) {
          const v = item[rule];
          return v == null ? '' : String(v);
        }
        return selVals(rule, ictx.root, ictx);
      };
      const rec = {
        name: pick(rs.name), url: pick(rs.bookUrl), author: pick(rs.author),
        cover: pick(rs.coverUrl), intro: pick(rs.intro),
        kind: pick(rs.kind), lastChapter: pick(rs.lastChapter)
      };
      const n = normalizeItem(rec, pageRes.finalUrl, s);
      if (n) out.push(n);
    }
    if (rs.checkKeyWord && rs.checkKeyWord !== 'none') {
      const norm = x => x.replace(/[\s《》（）()·,，:：]+/g, '');
      const q = norm(key);
      return out.filter(x => norm(x.name).includes(q) || norm(x.author).includes(q));
    }
    return out;
  }

  /* 把原始命中聚合成「书名 -> 多来源」的结果，搜索中途也会调用（返部分结果） */
  function buildResult(key, results, stats, t0, partial, poolTotal) {
    const agg = {};
    for (const r of results) {
      const k = r.name.replace(/[\s《》]+/g, '');
      const a = agg[k];
      if (!a) {
        agg[k] = Object.assign({}, r, { sources: [r.sourceName], variants: [{ sid: r.sourceId, url: r.url, source: r.sourceName }] });
      } else {
        if (!a.sources.includes(r.sourceName)) a.sources.push(r.sourceName);
        if (!a.variants.some(v => v.url === r.url)) a.variants.push({ sid: r.sourceId, url: r.url, source: r.sourceName });
        if ((r.intro || '').length > (a.intro || '').length) a.intro = r.intro;
        if (!a.cover && r.cover) a.cover = r.cover;
      }
    }

    const norm = x => (x || '').replace(/[\s《》（）()·,，:：]+/g, '').toLowerCase();
    const q = norm(key);
    for (const x of Object.values(agg)) {
      const n = norm(x.name);
      if (q && (n === q || q.includes(n) || (n.length > 2 && n.includes(q)))) x.rel = 0;
      else {
        const grams = q.length > 1 ? Array.from({ length: q.length - 1 }, (_, i) => q.slice(i, i + 2)) : [q];
        const cov = grams.filter(g => n.includes(g)).length / Math.max(1, grams.length);
        const headOk = q.length > 2 ? n.includes(q.slice(0, 2)) : n.includes(q);
        x.rel = (cov >= 0.75 && headOk) ? 1 : 2;
      }
    }
    const out = Object.values(agg).sort((a, b) => (a.rel - b.rel) || (b.sources.length - a.sources.length));
    return {
      q: key, took: Math.round(performance.now() - t0), results: out, raw: results.length, stats,
      exact: out.filter(x => x.rel === 0).length, near: out.filter(x => x.rel === 1).length,
      partial: !!partial, done: stats.length, total: poolTotal || stats.length
    };
  }

  async function search(key, limit = 400, page = 1, onBatch) {
    // 全部启用且规则可跑的源都参与搜索，排序按实测状态：可用 > 部分可用 > 未测 > 失效
    // （limit 只作为上限保护，默认 400，够覆盖导入后的总量）
    const rank = s => s._status === 'ok' ? 0 : s._status === 'part' ? 1 : s._status === 'dead' ? 3 : 2;
    const pool = SOURCES.filter(s => enabled(s) && supported(s)).sort((a, b) => rank(a) - rank(b)).slice(0, Math.max(1, limit));
    const t0 = performance.now();
    const results = [], stats = [];
    let lastEmit = 0;
    const emit = () => {
      if (!onBatch) return;
      const now = performance.now();
      if (now - lastEmit < 500) return; // 最多每 0.5s 推一次，避免频繁重绘
      lastEmit = now;
      try { onBatch(buildResult(key, results, stats, t0, true, pool.length)); } catch (e) { /* 回调出错不影响搜索 */ }
    };
    // 其他源全部并发抓（浏览器对同一域名本来就有连接上限，这里不再人为压并发）
    await Promise.all(pool.map(async s => {
      const ts = performance.now();
      try {
        const rs = await searchOne(s, key, page);
        results.push(...rs);
        stats.push({ source: disp(s.bookSourceName), id: s._id, count: rs.length, err: '', ms: Math.round(performance.now() - ts) });
      } catch (e) {
        stats.push({ source: disp(s.bookSourceName), id: s._id, count: 0, err: String(e.message || e).slice(0, 60), ms: Math.round(performance.now() - ts) });
      }
      emit();
    }));

    const res = buildResult(key, results, stats, t0, false, pool.length);
    if (onBatch) { try { onBatch(res); } catch (e) { } }
    return res;
  }

  /* ------------------------------------------------------------ 目录 */
  async function book(srcId, url) {
    const s = byId(srcId);
    if (!s) throw new Error('书源不存在');
    if (!supported(s)) throw new Error('脚本规则，浏览器版不支持');
    const pageRes = await fetchRaw(url, { referer: baseUrl(s) + '/' });
    const doc = parseHTML(pageRes.text);
    const base = pageRes.finalUrl || url;
    const ctx = { root: doc, sourceUrl: baseUrl(s) };
    const bi = s.ruleBookInfo || {};

    const name = selVals(bi.name, doc, ctx);
    const author = selVals(bi.author, doc, ctx);
    const intro = selVals(bi.intro, doc, ctx);
    const kind = selVals(bi.kind, doc, ctx);
    const last = selVals(bi.lastChapter, doc, ctx);
    let cover = selVals(bi.coverUrl, doc, ctx);
    if (cover) cover = abs(base, cover);

    let tocDoc = doc, tocBase = base;
    const tocUrlRaw = selVals(bi.tocUrl, doc, ctx);
    if (tocUrlRaw && !tocUrlRaw.startsWith('//')) {
      const turl = abs(base, tocUrlRaw);
      if (/^http/.test(turl) && turl !== base) {
        try {
          const tp = await fetchRaw(turl, { referer: base });
          tocDoc = parseHTML(tp.text); tocBase = tp.finalUrl || turl;
        } catch (e) { }
      }
    }

    const rt = s.ruleToc || {};
    const tctx = { root: tocDoc, sourceUrl: baseUrl(s) };
    const list = selNodes(rt.chapterList, tocDoc, tctx);
    const chapters = [];
    for (const it of list) {
      const ictx = Object.assign({}, tctx, { root: it.nodeType ? it : tocDoc });
      const cname = selVals(rt.chapterName, ictx.root, ictx) || textOf(it);
      const curl = selVals(rt.chapterUrl, ictx.root, ictx);
      if (cname && curl) chapters.push({ name: cname, url: abs(tocBase, curl) });
    }

    return {
      name: name || '', author: author.replace(/^作者[：:]\s*/, '') || '', intro: cleanIntro(intro),
      cover: cover || '', kind: kind || '', last: last || '',
      url, source: disp(s.bookSourceName), sourceId: srcId, chapters
    };
  }

  /* ------------------------------------------------------------ 正文 */
  async function content(srcId, url, bookUrl) {
    const s = byId(srcId);
    if (!s) throw new Error('书源不存在');
    if (!supported(s)) throw new Error('脚本规则，浏览器版不支持');
    const rc = s.ruleContent || {};
    const pageRes = await fetchRaw(url, { referer: bookUrl || baseUrl(s) + '/' });
    const doc = parseHTML(pageRes.text);
    const ctx = { root: doc, sourceUrl: baseUrl(s) };

    let raw = selVals(rc.content, doc, ctx);
    // 兜底：常见正文容器
    if (!raw) {
      const box = doc.querySelector('#content, .content, #chaptercontent, .read-content, article');
      if (box) raw = box.innerHTML || textOf(box);
    }

    // 分页正文：跟着 nextContentUrl 再抓两页
    let next = selVals(rc.nextContentUrl, doc, ctx);
    let hops = 0;
    while (next && hops < 2) {
      const nurl = abs(pageRes.finalUrl || url, next);
      if (!/^http/.test(nurl)) break;
      try {
        const p2 = await fetchRaw(nurl, { referer: pageRes.finalUrl || url });
        const d2 = parseHTML(p2.text);
        const more = selVals(rc.content, d2, { root: d2, sourceUrl: ctx.sourceUrl });
        if (!more) break;
        raw += '\n' + more;
        next = selVals(rc.nextContentUrl, d2, { root: d2, sourceUrl: ctx.sourceUrl });
        hops++;
      } catch (e) { break; }
    }

    if (rc.replaceRegex) {
      const parts = String(rc.replaceRegex).split('##');
      for (let i = 0; i + 1 < parts.length; i += 2) {
        if (!parts[i]) continue;
        try { raw = raw.replace(new RegExp(parts[i], 'g'), parts[i + 1] || ''); } catch (e) { }
      }
    }
    return cleanText(htmlToText(raw));
  }

  global.ShuyeEngine = {
    load, supported, search, searchOne, book, content, disp, cleanText,
    get sources() { return SOURCES; },
    byId, baseUrl
  };
})(window);
