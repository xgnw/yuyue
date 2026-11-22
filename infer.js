/* ==========================================================================
   愉阅 · 从详情页链接自动造源（infer.js）
   ---------------------------------------------------------------------------
   输入 1~3 个小说详情页 URL，靠页面结构推断出一份可用的 Legado 书源：
     站点名 / 书名 / 作者 / 简介 / 封面 / 目录地址 / 章节列表 / 正文容器 / 站内搜索
   只在浏览器里跑（需要 DOMParser），两版共用；抓页面走 PLAT.fetchPage()：
     · Cloudflare 版 -> Worker /p 代理
     · Vercel 版     -> /api/page 代理
   生成的规则只落在这套引擎支持的子集里（CSS/XPath + @text/@href/@textNodes），
   所以不会带出 <js> 之类云端跑不了的东西。
   ========================================================================== */
(function (global) {
  'use strict';

  const CJK = /[\u4e00-\u9fa5]/;
  const CJK_G = /[\u4e00-\u9fa5]/g;
  const UA_ACCEPT = 'text/html,application/xhtml+xml,*/*;q=0.8';

  const abs = (base, href) => { try { return new URL(href, base).toString(); } catch (e) { return href || ''; } };
  const text = el => el ? String(el.textContent || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim() : '';
  const cssSafe = s => String(s).replace(/([^\w-])/g, '\\$1');
  const enc = encodeURIComponent;

  function metaOf(doc, key) {
    const m = doc.querySelector(`meta[property="${key}"],meta[name="${key}"]`);
    return m ? (m.getAttribute('content') || '').trim() : '';
  }

  /* 给节点算一个尽量短又能唯一定位的 CSS 选择器（engine 的 qsa 直接能用） */
  function cssPath(el) {
    if (!el || el.nodeType !== 1) return '';
    if (el.id && /^[A-Za-z][\w-]*$/.test(el.id)) return '#' + el.id;
    const parts = [];
    let cur = el, depth = 0;
    while (cur && cur.nodeType === 1 && depth < 4) {
      if (cur.id && /^[A-Za-z][\w-]*$/.test(cur.id)) { parts.unshift('#' + cur.id); break; }
      const tag = cur.tagName.toLowerCase();
      const cls = (cur.getAttribute('class') || '').split(/\s+/)
        .filter(c => /^[A-Za-z][\w-]*$/.test(c)).slice(0, 2);
      parts.unshift(cls.length ? tag + '.' + cls.map(cssSafe).join('.') : tag);
      if (!cur.parentElement || cur.parentElement.tagName === 'BODY') break;
      cur = cur.parentElement; depth++;
    }
    return parts.join(' > ');
  }

  /* 多个节点的最近公共祖先 */
  function commonAncestor(nodes) {
    if (!nodes.length) return null;
    let a = nodes[0];
    const rest = nodes.slice(1);
    while (a && a.nodeType === 1) {
      if (rest.every(n => a.contains(n))) return a;
      a = a.parentElement;
    }
    return nodes[0].parentElement;
  }

  /* 在一批同类节点上试出「列表选择器」：
     按祖先聚类（第 1~6 层），取“装得最多”的那个容器，再要求容器里的链接数和目标接近。
     很多站的列表项散在同一父级甚至 body 下，单看第一个节点的祖先链会选不中。 */
  function chooseList(doc, nodes, opt = {}) {
    if (!nodes.length) return null;
    const min = opt.min || 4;
    const groups = [];
    for (let depth = 1; depth <= 6; depth++) {
      const map = new Map();
      for (const n of nodes) {
        let cur = n;
        for (let i = 0; i < depth && cur; i++) cur = cur.parentElement;
        if (!cur || cur === doc || cur.tagName === 'HTML' || cur.tagName === 'BODY') continue;
        if (!map.has(cur)) map.set(cur, 0);
        map.set(cur, map.get(cur) + 1);
      }
      for (const [el, cnt] of map) if (cnt >= min) groups.push({ el, cnt, depth });
    }
    groups.sort((a, b) => b.cnt - a.cnt || a.depth - b.depth);
    // 在“装得多”的容器里挑覆盖率最高的：命中数减去多余链接的惩罚
    let pick = null, bestScore = -1;
    for (const g of groups.slice(0, 12)) {
      let got = [];
      try { got = Array.from(g.el.querySelectorAll('a[href]')); } catch (e) { continue; }
      const inside = got.filter(a => nodes.includes(a)).length;
      if (inside < Math.min(min, nodes.length * 0.5)) continue;
      const score = inside - (got.length - inside) * 0.3;
      if (score > bestScore) { bestScore = score; pick = { el: g.el, inside, got: got.length }; }
    }
    if (!pick) return null;
    const base = cssPath(pick.el);
    // 目标链接如果都挂在同一种列表项里（li/dd/tr/p），就用列表项做 bookList，
    // 名称和链接取每项里的第一个 <a>，避免同一项里的“最新章节/开始阅读”混进结果
    const tags = new Map();
    for (const n of nodes) {
      const p = n.parentElement;
      if (!p || !pick.el.contains(p)) continue;
      // 用「标签 + 第一个 class」做签名，列表项通常靠这个类区分（li.three 之类）
      const cls = (p.getAttribute('class') || '').split(/\s+/).filter(c => /^[A-Za-z][\w-]*$/.test(c))[0];
      const sig = p.tagName.toLowerCase() + (cls ? '.' + cssSafe(cls) : '');
      tags.set(sig, (tags.get(sig) || 0) + 1);
    }
    let itemSel = '', itemCount = 0;
    for (const [t, c] of tags) if (c > itemCount) { itemSel = t; itemCount = c; }
    if (itemSel && itemSel !== 'a' && itemCount >= nodes.length * 0.8) {
      return { list: base + ' ' + itemSel, name: 'a.0@text', url: 'a.0@href', count: itemCount, base };
    }
    return { list: base + ' a', name: '@text', url: '@href', count: pick.got, base };
  }

  /* ------------------------------------------------------------ 详情页 */
  function inferBookInfo(doc, pageUrl) {
    const out = {};
    const siteName = metaOf(doc, 'og:site_name') || '';
    // 先从 <title> 里取一个干净的书名候选，再拿它去校准 h1/h2
    const titleText = text(doc.querySelector('title'));
    const stripSuffix = s => s.replace(/(最新章节列表|最新章节|全文阅读|TXT全集下载|无弹窗|小说)+$/g, '').trim();
    const titleFirst = stripSuffix(titleText.split(/[_\|｜—]/)[0].trim());
    // 书名：og:novel → 和标题一致的 h1/h2 → 标题第一段
    const ogName = metaOf(doc, 'og:novel:book_name');
    if (ogName) { out.bookName = ogName; out.nameRule = 'meta[property="og:novel:book_name"]@content'; }
    // 用 h1/h2 里“包含标题书名”的那个元素，选择器比 title 更通用（Python 引擎读不到 <head>）
    if (!out.bookName) {
      const cand = Array.from(doc.querySelectorAll('h1,h2,h3'))
        .map(el => ({ el, t: text(el) }))
        .filter(x => x.t && x.t.length <= 40 && CJK.test(x.t) && x.t !== siteName)
        .map(x => Object.assign(x, { name: x.t.replace(/作者[：:].*$/, '').replace(/[《》]/g, '').trim(), hasAuthor: /作者[：:]/.test(x.t) }))
        .filter(x => x.name && x.name.length <= 30 && !/小说网|书库|阅读网|首页|分类|排行/.test(x.name));
      const hit = cand.find(x => titleFirst && (x.name === titleFirst || x.t.includes(titleFirst) || titleFirst.includes(x.name)) && x.name.length > 1)
        || cand[0];
      if (hit) {
        out.bookName = hit.name;
        out.nameRule = cssPath(hit.el) + '@text' + (hit.hasAuthor ? '##作者.*##' : '');
      }
    }
    if (!out.bookName) out.bookName = titleFirst || text(doc.querySelector('title')).slice(0, 20);

    // 作者
    const ogAuthor = metaOf(doc, 'og:novel:author');
    if (ogAuthor) { out.authorRule = `meta[property="og:novel:author"]@content`; out.author = ogAuthor; }
    if (!out.author) {
      const m = (doc.body ? text(doc.body) : '').match(/作\s*者[：:]\s*([^\s|/，,。]{2,20})/);
      if (m) {
        out.author = m[1];
        const holder = Array.from(doc.querySelectorAll('p,div,span,li'))
          .filter(e => /作\s*者/.test(text(e)) && text(e).length < 40).pop();
        if (holder) out.authorRule = cssPath(holder) + '@text##.*作者[：:]\\s*##';
      }
    }

    // 简介
    const ogDesc = metaOf(doc, 'og:description') || metaOf(doc, 'description');
    const introSels = ['#intro', '.intro', '#bookintro', '.book-intro', '.intro-txt', '#bookSummary', '.summary', '.desc', '.book_desc'];
    let introEl = null;
    for (const s of introSels) { const el = doc.querySelector(s); if (el && text(el).length > 40) { introEl = el; break; } }
    if (introEl) out.introRule = cssPath(introEl) + '@textNodes';
    else if (ogDesc && ogDesc.length > 40) out.introRule = 'meta[name="description"]@content';
    out.intro = introEl ? text(introEl).slice(0, 100) : ogDesc.slice(0, 100);

    // 封面
    const ogImg = metaOf(doc, 'og:image');
    let img = null;
    if (ogImg) out.coverRule = 'meta[property="og:image"]@content';
    else {
      img = Array.from(doc.querySelectorAll('img')).find(i => /(cover|book|pic|img)/i.test(i.getAttribute('src') || '') && !/logo|icon|ico/i.test(i.getAttribute('src') || ''));
      if (img) out.coverRule = cssPath(img) + '@src';
    }
    out.cover = ogImg || (img ? img.getAttribute('src') : '');
    return out;
  }

  /* 目录入口：优先「目录/章节」字样的链接，其次同路径的 index.html */
  function findTocUrl(doc, pageUrl) {
    const anchors = Array.from(doc.querySelectorAll('a[href]'));
    const scored = [];
    for (const a of anchors) {
      const href = a.getAttribute('href') || '';
      if (!href || /^(javascript:|#)/i.test(href)) continue;
      const t = text(a);
      let score = 0;
      if (/^(查看)?(全部)?(章节目录|目录|章节列表)$/.test(t)) score += 6;
      else if (/目录|章节/.test(t) && t.length <= 12) score += 3;
      if (/catalog|mulu|chapterlist|list/i.test(href)) score += 2;
      if (score) scored.push({ href: abs(pageUrl, href), score, t, el: a });
    }
    scored.sort((a, b) => b.score - a.score);
    if (!scored.length) return null;
    // 同时给出该链接的选择器：引擎的 tocUrl 只认「选择器@href」，不认写死的路径
    return { url: scored[0].href, rule: cssPath(scored[0].el) + '@href' };
  }

  /* ------------------------------------------------------------ 章节列表 */
  function chapterShape(hrefs) {
    // 把数字抹成 \d+，统计出现最多的“形状”，用它筛章节链接
    const shape = h => h.replace(/\d+/g, '#').replace(/[?&].*$/, '');
    const map = new Map();
    for (const h of hrefs) map.set(shape(h), (map.get(shape(h)) || 0) + 1);
    let best = '', n = 0;
    for (const [k, v] of map) if (v > n && k.includes('#')) { best = k; n = v; }
    return { best, count: n };
  }

  function inferToc(doc, baseUrl) {
    const anchors = Array.from(doc.querySelectorAll('a[href]'))
      .filter(a => {
        const h = a.getAttribute('href') || '';
        if (!h || /^(javascript:|#|mailto:|tel:)/i.test(h)) return false;
        const t = text(a);
        if (!CJK.test(t) || t.length > 40) return false;
        // 明显不是章节的导航词
        if (/^(首页|返回|上一页|下一页|书架|加入书架|立即阅读|下载|手机版|登录|注册|推荐|全部章节|目录|最新章节)$/.test(t)) return false;
        return true;
      });
    const shape = chapterShape(anchors.map(a => a.getAttribute('href')));
    if (!shape.best || shape.count < 5) return null;
    const chapterAnchors = anchors.filter(a => (a.getAttribute('href') || '').replace(/\d+/g, '#').replace(/[?&].*$/, '') === shape.best);
    const list = chooseList(doc, chapterAnchors, { min: 5 });
    if (!list) return null;
    return Object.assign(list, {
      chapters: chapterAnchors.length,
      sample: text(chapterAnchors[0]),
      href: abs(baseUrl, chapterAnchors[0].getAttribute('href'))
    });
  }

  /* ------------------------------------------------------------ 正文容器 */
  const CONTENT_SELS = ['#content', '#chaptercontent', '#chapter-content', '#booktext', '#txt',
    '#novelcontent', '#nr_content', '#articlecontent', '#bookcontent', '#read-content',
    '.content', '.read-content', '.novelcontent', '.nr_content', '.article-content',
    '.entry-content', '.book-content', '.showtxt', '#htmlContent', 'article'];

  function inferContent(doc, chapterUrl) {
    let best = null, bestLen = 0;
    for (const s of CONTENT_SELS) {
      const el = doc.querySelector(s);
      if (!el) continue;
      const len = (text(el).match(CJK_G) || []).length;
      if (len > bestLen) { best = el; bestLen = len; }
    }
    if (!best || bestLen < 200) {
      // 兜底：找中文最多的块，排掉链接很多的外壳
      for (const el of doc.querySelectorAll('div,article,section')) {
        const len = (text(el).match(CJK_G) || []).length;
        const links = el.querySelectorAll('a').length;
        if (len > bestLen && links < Math.max(6, len / 80)) { best = el; bestLen = len; }
      }
    }
    if (!best || bestLen < 200) return null;
    const rule = cssPath(best) + '@textNodes';
    // 分页章节：页面里有「下一页」就带上 nextContentUrl（引擎最多再翻 2 页）
    let next = '';
    const na = Array.from(doc.querySelectorAll('a[href]')).find(a => /^(下一页|下一頁|下页)$/.test(text(a)));
    if (na) next = cssPath(na) + '@href';
    return { rule, chars: bestLen, nextContentUrl: next };
  }

  /* ------------------------------------------------------------ 站内搜索 */
  function formOf(doc, pageUrl) {
    const forms = Array.from(doc.querySelectorAll('form'));
    for (const f of forms) {
      const inputs = Array.from(f.querySelectorAll('input'));
      const q = inputs.find(i => {
        const name = (i.getAttribute('name') || i.getAttribute('id') || '').toLowerCase();
        const type = (i.getAttribute('type') || 'text').toLowerCase();
        if (type === 'hidden' || type === 'submit' || type === 'button') return false;
        if (type === 'search') return true;
        if (['s', 'q', 'k', 'wd', 'kw', 'key', 'keyword', 'searchkey', 'word', 'query', 'search'].includes(name)) return true;
        return /搜索/.test(i.getAttribute('placeholder') || '');
      });
      if (!q) continue;
      const name = q.getAttribute('name') || q.getAttribute('id');
      const action = f.getAttribute('action') || pageUrl;
      const method = (f.getAttribute('method') || 'get').toLowerCase();
      const hidden = inputs.filter(i => (i.getAttribute('type') || '') === 'hidden' && i.getAttribute('name'))
        .map(i => `${i.getAttribute('name')}=${i.getAttribute('value') || ''}`).join('&');
      let target = abs(pageUrl, action);
      const pathPart = target.replace(/^https?:\/\/[^/]+/, '') || '/';
      if (method === 'post') {
        const body = (hidden ? hidden + '&' : '') + `${name}={{key}}`;
        return { searchUrl: pathPart + `,{"method":"POST","body":${JSON.stringify(body)}}`, name, method, action: target };
      }
      const sep = pathPart.includes('?') ? '&' : '?';
      return { searchUrl: pathPart + sep + `${name}={{key}}` + (hidden ? '&' + hidden : ''), name, method, action: target };
    }
    return null;
  }

  const SEARCH_GUESS = ['searchbooks.php?searchkey={{key}}', '/searchbooks.php?searchkey={{key}}',
    '/search.php?searchkey={{key}}', '/search.php?q={{key}}', '/search.php?keyword={{key}}',
    '/search?q={{key}}', '/s?q={{key}}', '/search.html?searchkey={{key}}', '/search.html?keyword={{key}}',
    '/search.html?q={{key}}', '/so.php?q={{key}}'];

  /* ------------------------------------------------------------ 主流程 */
  async function fetchDoc(url, referer) {
    const res = await global.PLAT.fetchPage(url, referer);
    if (!res || !res.text) throw new Error('抓取失败：' + url);
    const doc = new DOMParser().parseFromString(res.text, 'text/html');
    return { doc, finalUrl: res.url || url, text: res.text };
  }

  function hostName(host) {
    return String(host || '').replace(/^www\./, '').replace(/^m\./, '');
  }

  async function inferFromUrl(rawUrl, opt = {}) {
    const url = /^https?:/.test(rawUrl) ? rawUrl : 'http://' + rawUrl;
    const detail = await fetchDoc(url);
    const finalUrl = detail.finalUrl;
    const origin = new URL(finalUrl).origin;
    const host = hostName(new URL(finalUrl).hostname);

    const info = inferBookInfo(detail.doc, finalUrl);
    const problems = [];

    // 目录：优先找详情页上的“目录/章节”链接，同时记下它的选择器（引擎的 tocUrl 只认选择器）
    const tocLink = findTocUrl(detail.doc, finalUrl);
    let tocUrl = tocLink ? tocLink.url : '';
    let tocRule = tocLink ? tocLink.rule : '';
    let tocPage = null;
    if (tocUrl) {
      try { tocPage = await fetchDoc(tocUrl, finalUrl); } catch (e) { problems.push('目录页抓取失败'); }
    }
    if (!tocPage) {
      // 很多站详情页本身就是目录
      tocPage = detail; tocUrl = finalUrl; tocRule = '';
    }
    const toc = inferToc(tocPage.doc, tocPage.finalUrl || tocUrl);
    if (!toc) problems.push('没识别出章节列表');
    else if (!tocUrl || tocUrl === finalUrl) { tocUrl = ''; tocRule = ''; }

    // 正文
    let content = null;
    if (toc && toc.href) {
      try {
        const ch = await fetchDoc(toc.href, tocPage.finalUrl || tocUrl || finalUrl);
        content = inferContent(ch.doc, ch.finalUrl);
      } catch (e) { problems.push('正文页抓取失败'); }
    }
    if (!content) problems.push('没识别出正文容器');

    // 搜索：先看详情页/首页有没有 search 表单，再按常见路径试探
    let search = formOf(detail.doc, finalUrl);
    if (!search) {
      try {
        const home = await fetchDoc(origin + '/', finalUrl);
        search = formOf(home.doc, home.finalUrl);
      } catch (e) { /* 首页抓不到就算了，走路径猜测 */ }
    }
    const bookName = info.bookName || '';
    const detailPathShape = new URL(finalUrl).pathname.replace(/\d+/g, '#');

    async function searchWorks(su) {
      try {
        let reqUrl = su, method = 'GET', body = '';
        const brace = su.indexOf(',{');
        if (brace > 0) {
          const cfg = JSON.parse(su.slice(brace + 1));
          reqUrl = su.slice(0, brace); method = (cfg.method || 'GET').toUpperCase();
          body = String(cfg.body || '').replace(/\{\{key\}\}/g, enc(bookName));
        }
        reqUrl = reqUrl.replace(/\{\{key\}\}/g, enc(bookName));
        const tar = abs(origin + '/', reqUrl);
        const res = await global.PLAT.fetchPage(tar, origin + '/', { method, body });
        if (!res || !res.text) return null;
        const d = new DOMParser().parseFromString(res.text, 'text/html');
        const cand = Array.from(d.querySelectorAll('a[href]')).filter(a => {
          const h = a.getAttribute('href') || '';
          return h && !/^(javascript:|#)/i.test(h) && CJK.test(text(a)) && text(a).length < 60;
        });
        const shape = chapterShape(cand.map(a => a.getAttribute('href')));
        // 结果页里最像“书籍详情链接”的形状：跟详情页 pathname 形状一致
        const hits = cand.filter(a => (a.getAttribute('href') || '').replace(/\d+/g, '#').split('?')[0] === detailPathShape);
        if (hits.length) {
          const list = chooseList(d, hits, { min: 2 });
          return { searchUrl: su, doc: d, finalUrl: res.url, hits: hits.length, list, shape: shape.best };
        }
        return null;
      } catch (e) { return null; }
    }

    let searchResult = null;
    const candidates = [];
    if (search) candidates.push(search.searchUrl);
    for (const g of SEARCH_GUESS) candidates.push(g);
    for (const su of candidates.slice(0, 4)) {
      const r = await searchWorks(su);
      if (r) { searchResult = r; break; }
    }
    if (!searchResult) problems.push('没识别出站内搜索，导入后只能手动搜书');

    const ruleSearch = searchResult
      ? (searchResult.list
        ? { bookList: searchResult.list.list, name: searchResult.list.name, bookUrl: searchResult.list.url, author: '' }
        : { bookList: 'a', name: '@text', bookUrl: '@href', author: '' })
      : null;

    const src = {
      bookSourceName: host + ' · 自建',
      bookSourceUrl: origin,
      bookSourceGroup: '自建',
      bookSourceType: 0,
      enabled: true,
      searchUrl: searchResult ? searchResult.searchUrl : '',
      ruleSearch: ruleSearch || {},
      ruleBookInfo: {
        name: info.nameRule || 'h1@text',
        author: info.authorRule || '',
        intro: info.introRule || '',
        coverUrl: info.coverRule || '',
        tocUrl: tocRule
      },
      ruleToc: toc ? { chapterList: toc.list, chapterName: toc.name, chapterUrl: toc.url } : {},
      ruleContent: content ? { content: content.rule, nextContentUrl: content.nextContentUrl || '' } : {}
    };

    return {
      source: src,
      report: {
        host, bookName, author: info.author,
        tocUrl: tocUrl || finalUrl,
        chapters: toc ? toc.chapters : 0,
        chapterSample: toc ? toc.sample : '',
        contentChars: content ? content.chars : 0,
        searchUrl: src.searchUrl,
        searchHits: searchResult ? searchResult.hits : 0,
        problems
      }
    };
  }

  global.SourceInfer = { inferFromUrl };
  // 调试用：暴露内部纯函数，方便在控制台核对推断结果
  global.SourceInfer._debug = { chooseList, inferToc, inferBookInfo, inferContent, formOf, cssPath, chapterShape };
})(window);
