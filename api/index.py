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
            rs = S.search(s, key, page, timeout=10)
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

    with ThreadPoolExecutor(max_workers=8) as ex:
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


@app.route('/api/search')
def api_search():
    key = (request.args.get('key') or '').strip()
    if not key:
        return jsonify({'error': 'missing key'}), 400
    limit = int(request.args.get('limit') or 14)
    return jsonify(do_search(key, min(limit, 20)))


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
