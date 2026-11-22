"""
愉阅 · Vercel 版后端
---------------------------------------------------------------------------
把本地版的 srlib.py（Legado 规则引擎）原样搬进一个 Flask 函数：
  GET  /api/health          服务与书源概况
  GET  /api/sources         书源列表（含体检状态）
  POST /api/sources/toggle  启用/停用（进程内存，重启即还原）
  POST /api/sources/test    单个书源实测
  GET  /api/search          并发搜索多个源
  GET  /api/book            目录 + 详情
  GET  /api/content         单章正文（正文清洗在引擎里完成）
  GET  /api/img             封面代理（补 Referer，绕防盗链）

注意：Vercel 是无状态函数，没有常驻线程和持久磁盘，所以"整本下载"不在
后端做，改由前端逐章调用 /api/content 并存入浏览器 IndexedDB。
"""
import json
import os
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlparse, parse_qs, quote

import requests
from flask import Flask, request, jsonify, Response

sys.path.insert(0, os.path.dirname(__file__))
import srlib as S  # noqa: E402

HERE = os.path.dirname(__file__)
DATA_DIR = os.path.join(HERE, 'data')
SRC_FILE = os.path.join(DATA_DIR, 'sources.json')
AUDIT_FILE = os.path.join(DATA_DIR, 'audit.json')

app = Flask(__name__, static_folder=os.path.dirname(HERE), static_url_path='')

UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/124.0 Safari/537.36')


# ---------------------------------------------------------------- 数据加载
def src_id(s):
    import hashlib
    raw = (s.get("bookSourceName", "") + "|" + s.get("bookSourceUrl", "")).encode("utf-8")
    return hashlib.md5(raw).hexdigest()[:10]


def load_sources():
    with open(SRC_FILE, encoding='utf-8') as f:
        arr = json.load(f)
    audit = {}
    if os.path.exists(AUDIT_FILE):
        try:
            with open(AUDIT_FILE, encoding='utf-8') as f:
                for rec in json.load(f).get('recs', []):
                    host = re.sub(r'^https?://', '', rec.get('host') or '').split('/')[0].lower()
                    audit[host] = rec
        except Exception:
            pass
    for s in arr:
        s['_id'] = src_id(s)
        a = audit.get(re.sub(r'^https?://', '', s.get('bookSourceUrl') or '').split('/')[0].lower())
        s['_audit'] = a or {}
        if a:
            s['_status'] = 'ok' if (a.get('search') and a.get('toc') and (a.get('content') or 0) > 200) else (
                'part' if (a.get('search') or a.get('toc')) else 'dead')
        else:
            s.setdefault('_status', 'untested')
        s.setdefault('enabled', True)
    return arr


_STATE = {'sources': None}


def sources():
    if _STATE['sources'] is None:
        _STATE['sources'] = load_sources()
    return _STATE['sources']


def disp(name):
    return re.sub(r'[\U0001F000-\U0001FAFF\u2190-\u21FF\u2600-\u27BF\u2B00-\u2BFF\uFE0F]', '', name or '').strip() or '书源'


def get_src(sid):
    for s in sources():
        if s['_id'] == sid:
            return s
    return None


def usable(limit):
    arr = sources()
    ok = [s for s in arr if s.get('_status') == 'ok' and s.get('enabled')]
    part = [s for s in arr if s.get('_status') == 'part' and s.get('enabled')]
    ok.sort(key=lambda s: -(s.get('_audit', {}).get('content') or 0))
    part.sort(key=lambda s: -(s.get('_audit', {}).get('search') or 0))
    out = ok + part
    if len(out) < limit:
        out += [s for s in arr if s.get('_status') == 'untested' and s.get('enabled')][:limit - len(out)]
    return out[:limit]


# ---------------------------------------------------------------- 搜索
def do_search(key, limit=14, page=1):
    results, stats = [], []
    t0 = time.time()

    def one(s):
        st = {'source': disp(s.get('bookSourceName')), 'id': s['_id'], 'count': 0, 'err': '', 'ms': 0}
        ts = time.time()
        try:
            rs = S.search(s, key, page, timeout=5)
            st['count'] = len(rs)
            for r in rs[:6]:
                r['sourceId'] = s['_id']
                r['sourceName'] = disp(s.get('bookSourceName'))
            return rs[:6], st
        except Exception as e:
            st['err'] = type(e).__name__ + ': ' + str(e)[:70]
            return [], st
        finally:
            st['ms'] = int((time.time() - ts) * 1000)

    with ThreadPoolExecutor(max_workers=24) as ex:
        for rs, st in ex.map(one, usable(limit)):
            results.extend(rs)
            stats.append(st)

    agg = {}
    for r in results:
        k = re.sub(r'[\s《》]+', '', r['name'])
        a = agg.get(k)
        if not a:
            agg[k] = dict(r, sources=[r['sourceName']],
                          variants=[{'sid': r['sourceId'], 'url': r['url'], 'source': r['sourceName']}])
        else:
            if r['sourceName'] not in a['sources']:
                a['sources'].append(r['sourceName'])
            if r['url'] not in [v['url'] for v in a['variants']]:
                a['variants'].append({'sid': r['sourceId'], 'url': r['url'], 'source': r['sourceName']})
            if len(r.get('intro') or '') > len(a.get('intro') or ''):
                a['intro'] = r['intro']
            if not a.get('cover') and r.get('cover'):
                a['cover'] = r['cover']

    def norm(x):
        return re.sub(r'[\s《》（）()·,，:：]+', '', x or '').lower()

    q = norm(key)
    for x in agg.values():
        n = norm(x['name'])
        if q and (n == q or q in n or (len(n) > 2 and n in q)):
            x['rel'] = 0
        else:
            grams = {q[i:i + 2] for i in range(len(q) - 1)} if len(q) > 1 else {q}
            cov = sum(1 for g in grams if g in n) / max(1, len(grams)) if grams else 0
            head_ok = q[:2] in n if len(q) > 2 else q in n
            x['rel'] = 1 if (cov >= 0.75 and head_ok) else 2

    out = sorted(agg.values(), key=lambda x: (x.get('rel', 2), -len(x['sources'])))
    return {'q': key, 'took': int((time.time() - t0) * 1000), 'results': out,
            'raw': len(results), 'stats': stats,
            'exact': sum(1 for x in out if x.get('rel') == 0),
            'near': sum(1 for x in out if x.get('rel') == 1)}


# ---------------------------------------------------------------- 路由
@app.after_request
def cors(resp):
    resp.headers['Access-Control-Allow-Origin'] = '*'
    resp.headers['Access-Control-Allow-Headers'] = '*'
    return resp


@app.before_request
def _fix_path():
    """Vercel 把 /api/* 重写到 /api/index，有些运行时会保留完整路径，这里统一剥掉前缀"""
    p = request.environ.get('PATH_INFO', '')
    if p == '/api/index' or p.startswith('/api/index/'):
        request.environ['PATH_INFO'] = '/api' + p[len('/api/index'):]


@app.route('/api/health')
def health():
    arr = sources()
    return jsonify({'ok': True, 'mode': 'vercel', 'sources': {
        'total': len(arr), 'enabled': sum(1 for s in arr if s.get('enabled')),
        'ok': sum(1 for s in arr if s.get('_status') == 'ok')}})


@app.route('/api/sources')
def api_sources():
    rank = {'ok': 0, 'untested': 1, 'part': 2, 'dead': 3}
    arr = sorted(sources(), key=lambda s: (rank.get(s.get('_status'), 4), s.get('bookSourceName') or ''))
    out = []
    for s in arr:
        a = s.get('_audit') or {}
        out.append({'id': s['_id'], 'name': disp(s.get('bookSourceName')), 'group': s.get('bookSourceGroup'),
                    'host': S.norm_base(s), 'enabled': bool(s.get('enabled')),
                    'status': s.get('_status', 'untested'), 'ms': a.get('ms'), 'count': a.get('search'),
                    'toc': a.get('toc'), 'chars': a.get('content'), 'sample': a.get('sample')})
    return jsonify({'total': len(out), 'list': out})


@app.route('/api/sources/toggle', methods=['POST'])
def api_toggle():
    b = request.get_json(force=True, silent=True) or {}
    s = get_src(b.get('id'))
    if not s:
        return jsonify({'error': 'not found'}), 404
    s['enabled'] = bool(b.get('enabled', True))
    return jsonify({'ok': True, 'enabled': s['enabled']})


@app.route('/api/sources/test', methods=['POST'])
def api_test():
    b = request.get_json(force=True, silent=True) or {}
    s = get_src(b.get('id'))
    if not s:
        return jsonify({'error': 'not found'}), 404
    t0 = time.time()
    try:
        rs = S.search(s, b.get('key') or '剑来', 1, timeout=10)
        return jsonify({'ok': bool(rs), 'count': len(rs), 'ms': int((time.time() - t0) * 1000),
                        'sample': rs[0]['name'] if rs else ''})
    except Exception as e:
        return jsonify({'ok': False, 'err': str(e)[:80]})


JS_RULE_RE = re.compile(r'(@js:|<js>|java\.)')


def _is_js_source(s):
    """规则里带脚本的书源，Python 引擎跑不了（与 Cloudflare 版口径一致）"""
    for k in ('searchUrl', 'ruleSearch', 'ruleBookInfo', 'ruleToc', 'ruleContent'):
        v = s.get(k)
        if isinstance(v, str) and JS_RULE_RE.search(v):
            return True
        if isinstance(v, dict):
            for x in v.values():
                if isinstance(x, str) and JS_RULE_RE.search(x):
                    return True
    return False


@app.route('/api/sources/import', methods=['POST'])
def api_import():
    """导入书源：支持粘贴 JSON，也支持给一个 URL 由函数去拉（Vercel 端没有跨域问题）。
    导入结果放在当前函数实例内存里；浏览器会把同一份存 localStorage，冷启动后自动补发。"""
    b = request.get_json(force=True, silent=True) or {}
    arr = []
    if b.get('json'):
        j = b['json']
        arr = j if isinstance(j, list) else [j]
    elif b.get('url'):
        try:
            r = requests.get(b['url'], headers={'User-Agent': UA, 'Accept': 'application/json,*/*'}, timeout=20)
        except Exception as e:
            return jsonify({'error': '拉取书源地址失败：' + str(e)[:60]}), 502
        if r.status_code >= 400:
            return jsonify({'error': '拉取书源失败：HTTP %d' % r.status_code}), 502
        try:
            data = r.json()
        except Exception:
            return jsonify({'error': '该地址返回的是网页不是 JSON，请填书源 JSON 导出地址（如 …/shuyuan/json）'}), 400
        arr = data if isinstance(data, list) else [data]
        if len(arr) <= 1 and not (arr[0].get('bookSourceUrl') or arr[0].get('bookSourceName')):
            inner = data.get('sources') or data.get('data') or data.get('list')
            if isinstance(inner, list):
                arr = inner
    else:
        return jsonify({'error': '缺少 url 或 json'}), 400

    arr = [x for x in arr if isinstance(x, dict) and (x.get('bookSourceUrl') or x.get('bookSourceName'))]
    if not arr:
        return jsonify({'error': '没有解析到书源，请检查地址或粘贴 JSON'}), 400
    js = sum(1 for x in arr if _is_js_source(x))
    arr = [x for x in arr if not _is_js_source(x)]
    seen, keep = set(), []
    for x in arr:
        u = x.get('bookSourceUrl') or ''
        if u and u in seen:
            continue
        seen.add(u)
        keep.append(x)
    if not keep:
        return jsonify({'error': '全部 %d 个源都用了 JS 规则，云端版跑不了' % js}), 400

    cur = sources()
    urls = {x.get('bookSourceUrl') for x in keep}
    cur = [s for s in cur if s.get('bookSourceUrl') not in urls]
    for x in keep:
        x.setdefault('_status', 'untested')
        x.setdefault('enabled', True)
        x.setdefault('_audit', {})
        x['_id'] = src_id(x)
    _STATE['sources'] = cur + keep
    SLIM = ('bookSourceName', 'bookSourceUrl', 'bookSourceGroup', 'enabled',
            'searchUrl', 'ruleSearch', 'ruleBookInfo', 'ruleToc', 'ruleContent')
    imported = [{k: x[k] for k in SLIM if k in x} for x in keep]
    return jsonify({'added': len(keep), 'total': len(_STATE['sources']), 'skippedJs': js, 'imported': imported})


@app.route('/api/search')
def api_search():
    key = (request.args.get('key') or '').strip()
    if not key:
        return jsonify({'error': 'missing key'}), 400
    limit = int(request.args.get('limit') or 60)
    # 上限放到 300：正常 244 个源全参与；线程池 16 + 单源 7s 超时，函数 60s 内能跑完
    return jsonify(do_search(key, min(limit, 300)))


@app.route('/api/book')
def api_book():
    sid, url = request.args.get('src'), request.args.get('url')
    if not sid or not url:
        return jsonify({'error': 'missing src/url'}), 400
    src = get_src(sid)
    if not src:
        return jsonify({'error': 'source not found'}), 404
    t = S.toc(src, url, timeout=15)
    info = {}
    try:
        info = S.book_detail(src, url, timeout=15)
    except Exception:
        pass
    return jsonify({'name': info.get('name') or '', 'author': info.get('author') or '',
                    'intro': info.get('intro') or '', 'cover': info.get('cover') or '',
                    'kind': info.get('kind') or '', 'last': info.get('last') or '',
                    'url': url, 'source': disp(src.get('bookSourceName')), 'sourceId': sid,
                    'chapters': t['chapters']})


@app.route('/api/content')
def api_content():
    sid, url = request.args.get('src'), request.args.get('url')
    if not sid or not url:
        return jsonify({'error': 'missing src/url'}), 400
    src = get_src(sid)
    if not src:
        return jsonify({'error': 'source not found'}), 404
    return jsonify({'text': S.content(src, url, timeout=15)})


@app.route('/api/img')
def api_img():
    u = request.args.get('u') or ''
    if not u:
        return Response('', status=400)
    try:
        p = urlparse(u)
        r = requests.get(u, timeout=12, headers={'User-Agent': UA, 'Referer': f'{p.scheme}://{p.netloc}/'})
        return Response(r.content, status=200, content_type=r.headers.get('Content-Type') or 'image/jpeg',
                        headers={'Cache-Control': 'public, max-age=86400'})
    except Exception:
        return Response('', status=404)


@app.route('/')
def index():
    return app.send_static_file('index.html')


if __name__ == '__main__':
    app.run(host='127.0.0.1', port=int(os.environ.get('PORT', 5200)), debug=False)

