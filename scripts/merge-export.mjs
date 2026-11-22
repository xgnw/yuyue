#!/usr/bin/env node
/**
 * 把「书源管理 → 导出」得到的 JSON 合并进仓库书源清单
 * ---------------------------------------------------------------------------
 * 作用：让导入的书源在所有设备、所有浏览器上都生效（不再只活在 localStorage）。
 *
 * 用法：
 *   node scripts/merge-export.mjs 愉阅书源-2026-11-21.json           # 只追加新源（安全的默认）
 *   node scripts/merge-export.mjs 愉阅书源-2026-11-21.json --sync    # 仓库清单 = 导出清单（连删除也同步）
 *   ... --rebuild                                                   # 顺手重跑 build-sources.mjs
 *
 * 处理内容：
 *   1. 丢掉带 JS 规则的源（Worker / 浏览器引擎都跑不了），与导入时的口径一致；
 *   2. 按 bookSourceUrl 去重，已在清单里的源不重复添加、也不覆盖原有体检状态；
 *   3. 写回 public/sources.json（部署后立刻对所有人生效）；
 *   4. 新源同时记进 data/extra-sources.json，这样以后重跑 build-sources.mjs 也不会丢。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '..');
const LIST = path.join(ROOT, 'public', 'sources.json');
const EXTRA = path.join(ROOT, 'data', 'extra-sources.json');

const KEEP_KEYS = ['bookSourceName', 'bookSourceUrl', 'bookSourceGroup', 'bookSourceType',
  'enabled', 'header', 'searchUrl', 'ruleSearch', 'ruleBookInfo', 'ruleToc', 'ruleContent'];
const RULE_KEYS = ['searchUrl', 'ruleSearch', 'ruleBookInfo', 'ruleToc', 'ruleContent'];
const needsJs = s => RULE_KEYS.some(k => /<js>|@js:|@webview:|java\./i.test(JSON.stringify(s[k] || '')));

const slim = s => {
  const o = {};
  for (const k of KEEP_KEYS) if (s[k] !== undefined && s[k] !== '' && s[k] !== null) o[k] = s[k];
  return o;
};
const idOf = s => crypto.createHash('md5')
  .update(`${s.bookSourceName || ''}|${s.bookSourceUrl || ''}`).digest('hex').slice(0, 10);

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--'));
const sync = args.includes('--sync');
const rebuild = args.includes('--rebuild');

if (!file) {
  console.error('用法: node scripts/merge-export.mjs <导出的 json> [--sync] [--rebuild]');
  process.exit(1);
}
if (!fs.existsSync(file)) {
  console.error('找不到文件:', file);
  process.exit(1);
}

const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
const incoming = (Array.isArray(raw) ? raw : (raw.list || raw.sources || raw.data || []))
  .filter(s => s && (s.bookSourceUrl || s.bookSourceName));

const jsCount = incoming.filter(needsJs).length;
const usable = incoming.filter(s => !needsJs(s));

const current = fs.existsSync(LIST) ? JSON.parse(fs.readFileSync(LIST, 'utf8')) : [];
const byUrl = new Map(current.map(s => [s.bookSourceUrl || s.bookSourceName, s]));

const next = [];        // 合并后的完整清单
const added = [];       // 这次真正新增的源（只进 extra，不删东西）
let reused = 0;
let dropped = 0;

const uniq = new Map();
for (const s of usable) {
  const key = s.bookSourceUrl || s.bookSourceName;
  if (!key) continue;
  if (uniq.has(key)) { dropped++; continue; }
  uniq.set(key, slim(s));
}

if (sync) {
  // 仓库清单 = 导出清单：删除也会同步下去，但保留已有源的体检状态
  for (const [key, s] of uniq) {
    const old = byUrl.get(key);
    if (old) {
      next.push(Object.assign({}, old, s, { _id: old._id || idOf(s), _audit: old._audit || {}, _status: old._status || 'untested' }));
      reused++;
    } else {
      const rec = Object.assign({}, s, { _id: idOf(s), _audit: {}, _status: 'untested', enabled: s.enabled !== false });
      next.push(rec); added.push(rec);
    }
  }
  const gone = current.filter(s => !uniq.has(s.bookSourceUrl || s.bookSourceName)).length;
  console.log(`同步模式：清单 ${current.length} → ${next.length}（保留 ${reused}，新增 ${added.length}，移除 ${gone}）`);
} else {
  next.push(...current);
  for (const [key, s] of uniq) {
    if (byUrl.has(key)) { reused++; continue; }
    const rec = Object.assign({}, s, { _id: idOf(s), _audit: {}, _status: 'untested', enabled: s.enabled !== false });
    next.push(rec); added.push(rec);
  }
  console.log(`追加模式：清单 ${current.length} → ${next.length}（新增 ${added.length}，已在清单 ${reused}）`);
}

fs.mkdirSync(path.dirname(LIST), { recursive: true });
fs.writeFileSync(LIST, JSON.stringify(next));

if (added.length) {
  const extra = fs.existsSync(EXTRA) ? JSON.parse(fs.readFileSync(EXTRA, 'utf8')) : [];
  const seen = new Set(extra.map(s => s.bookSourceUrl || s.bookSourceName));
  const merged = extra.concat(added.filter(s => !seen.has(s.bookSourceUrl || s.bookSourceName)));
  fs.mkdirSync(path.dirname(EXTRA), { recursive: true });
  fs.writeFileSync(EXTRA, JSON.stringify(merged, null, 1));
  console.log(`extra-sources.json: ${merged.length} 个（重跑 build-sources.mjs 也不会丢）`);
}

if (jsCount) console.log(`跳过 ${jsCount} 个 JS 源（云端跑不了）`);
if (dropped) console.log(`跳过 ${dropped} 个重复源`);
console.log('->', LIST);

if (rebuild) {
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'build-sources.mjs')], { stdio: 'inherit' });
  process.exitCode = r.status || 0;
} else {
  console.log('下一步：git add -A && git commit -m "更新书源清单" && git push，部署完成后所有设备都生效');
}
