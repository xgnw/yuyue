#!/usr/bin/env node
/**
 * 重新生成 api/data/sources.json
 * ---------------------------------------------------------------------------
 * 用法：node scripts/build-sources.mjs
 *
 * 和 cloudflare 分支同一套过滤/精简逻辑，只是输出到 api/data/ 下，
 * 由 Vercel 的 Python 函数在启动时读取。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const SRC_URL = 'https://www.yckceo.com/yuedu/shuyuans/json/id/1340.json';
const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'api', 'data', 'sources.json');
const AUDIT = path.join(ROOT, 'api', 'data', 'audit.json');
const LOCAL = path.join(ROOT, 'api', 'data', 'sources-full.json');
/* 用户自己加/导入的源，由 scripts/merge-export.mjs 维护；全量重抓时也一起带上 */
const EXTRA_FILE = path.join(ROOT, 'api', 'data', 'extra-sources.json');

const RULE_KEYS = ['ruleSearch', 'ruleBookInfo', 'ruleToc', 'ruleContent'];

/* Python 引擎同样不支持 <js>/@js:，构建期就剔掉 */
const needsJs = s => RULE_KEYS.some(k => /<js>|@js:|@webview:|java\./i.test(JSON.stringify(s[k] || '')));

// Python 引擎读顶层 searchUrl，以及四段 rule*
const KEEP_KEYS = ['bookSourceName', 'bookSourceUrl', 'bookSourceGroup', 'bookSourceType',
  'enabled', 'header', 'searchUrl', 'ruleSearch', 'ruleBookInfo', 'ruleToc', 'ruleContent'];

const slim = s => {
  const o = {};
  for (const k of KEEP_KEYS) if (s[k] !== undefined && s[k] !== '' && s[k] !== null) o[k] = s[k];
  return o;
};

const hostOf = s => (s.bookSourceUrl || '').replace(/^https?:\/\//, '').split('/')[0].toLowerCase();
const idOf = s => crypto.createHash('md5')
  .update(`${s.bookSourceName || ''}|${s.bookSourceUrl || ''}`).digest('hex').slice(0, 10);

function loadAudit() {
  if (!fs.existsSync(AUDIT)) return {};
  const map = {};
  for (const rec of JSON.parse(fs.readFileSync(AUDIT, 'utf8')).recs || []) {
    map[(rec.host || '').replace(/^https?:\/\//, '').split('/')[0].toLowerCase()] = rec;
  }
  return map;
}

async function loadRaw() {
  if (fs.existsSync(LOCAL)) {
    console.log('use local', LOCAL);
    return JSON.parse(fs.readFileSync(LOCAL, 'utf8'));
  }
  console.log('fetch', SRC_URL);
  const res = await fetch(SRC_URL, {
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'referer': 'https://www.yckceo.com/'
    }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  return Array.isArray(j) ? j : (j.data || j.sources || []);
}

const rank = { ok: 0, part: 1, untested: 2, dead: 3 };

const main = async () => {
  const list = await loadRaw();
  console.log('raw sources:', list.length);

  const extra = fs.existsSync(EXTRA_FILE) ? JSON.parse(fs.readFileSync(EXTRA_FILE, 'utf8')) : [];
  const seen = new Set(list.map(s => s.bookSourceUrl));
  const extraNew = extra.filter(s => s && s.bookSourceUrl && !seen.has(s.bookSourceUrl));
  if (extraNew.length) console.log('merge extra:', extraNew.length);
  const rawList = list.concat(extraNew);

  const audit = loadAudit();
  const kept = [];
  for (const raw of rawList) {
    if (needsJs(raw)) continue;
    const s = slim(raw);
    const a = audit[hostOf(s)] || {};
    s._id = idOf(s);
    s._audit = a;
    s._status = a.search && a.toc && (a.content || 0) > 200 ? 'ok'
      : (a.search || a.toc) ? 'part'
      : a.host ? 'dead' : 'untested';
    s.enabled = s.enabled !== false;
    kept.push(s);
  }

  kept.sort((a, b) => (rank[a._status] - rank[b._status])
    || ((b._audit.content || 0) - (a._audit.content || 0))
    || (a.bookSourceName || '').localeCompare(b.bookSourceName || ''));

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(kept));
  const stat = {};
  kept.forEach(s => { stat[s._status] = (stat[s._status] || 0) + 1; });
  console.log('kept:', kept.length, stat, 'searchUrl:', kept.filter(s => s.searchUrl).length);
  console.log('->', OUT, (fs.statSync(OUT).size / 1024).toFixed(0) + 'KB');
};

main().catch(e => { console.error(e); process.exit(1); });
