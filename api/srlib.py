# -*- coding: utf-8 -*-
"""
srlib.py — 阅读(Legado)书源规则引擎的一个务实子集实现
目标：只用标准库 + lxml，把 bookSourceType=0 的纯 HTML 书源跑起来。
支持：{{key}}/searchKey、@css/裸CSS、class.x.0@tag.a.0@text 私有语法、xpath、
      | 与 & 与 %% 组合、#/## 正则替换、POST 搜索、GBK 页面。
明确不支持：@js:、@webview:、java.*、登录态（遇到就标记 unsupported，前端提示换源）。
"""
import gzip, io, json, re, socket, ssl, time, zlib
import urllib.error, urllib.parse, urllib.request

from lxml import html as LH
from lxml import etree

UA = ("Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36")

NS = {"re": "http://exslt.org/regular-expressions"}

EXTRACT = {"text", "textnodes", "textNodes", "href", "src", "html", "owntext",
           "ownText", "content", "all", "data-src", "value", "title"}


# ---------------------------------------------------------------- HTTP
def _decompress(raw, enc_header=""):
    """按魔术字节解压，不完全信任 Content-Encoding（这些站点经常乱标。"""
    if raw[:2] == b"\x1f\x8b":
        try:
            return gzip.decompress(raw)
        except Exception:
            return raw
    if raw[:4] == b"\x28\xb5\x2f\xfd":
        try:
            import zstandard
            return zstandard.ZstdDecompressor().decompress(raw)
        except Exception:
            return raw
    if "deflate" in (enc_header or "") or raw[:1] == b"\x78":
        try:
            return zlib.decompress(raw)
        except Exception:
            try:
                return zlib.decompress(raw, -zlib.MAX_WBITS)
            except Exception:
                return raw
    return raw


def _decode(raw, ctype=""):
    charset = None
    m = re.search(r"charset=([\w-]+)", ctype or "", re.I)
    if m:
        charset = m.group(1).lower()
    cands = ([charset] if charset else []) + ["utf-8", "gb18030"]
    for c in cands:
        try:
            return raw.decode(c)
        except (LookupError, UnicodeDecodeError):
            continue
    head = raw[:4096].decode("ascii", "ignore")
    m = re.search(r'charset=["\']?([\w-]+)', head, re.I)
    if m:
        try:
            return raw.decode(m.group(1))
        except (LookupError, UnicodeDecodeError):
            pass
    return raw.decode("utf-8", "replace")


def fetch(url, method="GET", headers=None, body=None, timeout=15, retries=2):
    """返回 (text, final_url)。自动解压、嗅探编码；遇到 404/403 限流会重试。"""
    h = {"User-Agent": UA, "Accept-Encoding": "gzip, deflate",
         "Accept-Language": "zh-CN,zh;q=0.9"}
    if headers:
        for k, v in headers.items():
            if k and v:
                h[str(k)] = str(v)
    if "Referer" not in h and "referer" not in h:
        p = urllib.parse.urlparse(url)
        if p.scheme and p.netloc:
            h["Referer"] = "%s://%s/" % (p.scheme, p.netloc)
    data = body.encode("utf-8") if isinstance(body, str) else body
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    last_err = None
    for attempt in range(retries + 1):
        try:
            req = urllib.request.Request(url, data=data, headers=h,
                                         method="POST" if body is not None else method)
            with urllib.request.urlopen(req, timeout=timeout, context=ctx) as r:
                raw = _decompress(r.read(), r.headers.get("Content-Encoding", ""))
                return _decode(raw, r.headers.get("Content-Type", "")), r.geturl()
        except urllib.error.HTTPError as e:
            raw = _decompress(e.read(), e.headers.get("Content-Encoding", ""))
            text = _decode(raw, e.headers.get("Content-Type", ""))
            # 站点常见的“限流式 404”，重试往往就是 200
            if e.code in (403, 404, 429, 500, 502, 503) and attempt < retries:
                last_err = "HTTP %d" % e.code
                time.sleep(0.8 * (attempt + 1))
                continue
            if e.code in (403, 404, 429, 500, 502, 503):
                raise IOError("HTTP %d %s" % (e.code, url))
            return text, url
        except (socket.timeout, TimeoutError) as e:
            last_err = e
            if attempt < retries:
                time.sleep(1.0)
                continue
            raise
        except Exception as e:
            last_err = e
            if attempt < retries:
                time.sleep(0.8)
                continue
            raise
    raise IOError(str(last_err))


def parse_html(text):
    if not text:
        return None
    try:
        return LH.fromstring(text)
    except Exception:
        try:
            return LH.fromstring("<html><body>" + text + "</body></html>")
        except Exception:
            return None


def abs_url(base, u):
    if not u:
        return u
    u = u.strip()
    if u.startswith("//"):
        return "https:" + u
    return urllib.parse.urljoin(base or "", u)


# ---------------------------------------------------------------- CSS -> XPath
def _attr_eq(name, val, op="="):
    if op == "=":
        return "[@%s='%s']" % (name, val)
    if op == "~=":
        # 阅读里 ~= 是正则匹配，靠 lxml 的 EXSLT re:test 实现
        return '[re:test(@%s,"%s")]' % (name, val.replace('"', ""))
    if op == "*=":
        return "[contains(@%s,'%s')]" % (name, val)
    if op == "^=":
        return "[starts-with(@%s,'%s')]" % (name, val)
    if op == "$=":
        return "[substring(@%s,string-length(@%s)-%d)='%s']" % (name, name, len(val) - 1, val)
    return ""


def _compound(sel):
    """把 div#a.b[c='d']:nth-child(2) 转成 xpath 谓词串，返回 (tag, preds)"""
    sel = sel.strip()
    if not sel or sel == "*":
        return "*", ""
    tag = "*"
    m = re.match(r"^([A-Za-z0-9\-\*]+)", sel)
    if m and m.group(1) != "*":
        tag = m.group(1)
        sel = sel[m.end():]
    elif m:
        sel = sel[m.end():]
    preds = []
    for tok in re.findall(r"[.#\[]|:[a-zA-Z-]+\([^)]*\)|:[a-zA-Z-]+", sel):
        pass
    i = 0
    while i < len(sel):
        c = sel[i]
        if c == "#":
            m = re.match(r"#([^.#\[:]+)", sel[i:])
            if m:
                preds.append("[@id='%s']" % m.group(1))
                i += m.end()
                continue
        if c == ".":
            m = re.match(r"\.([^.#\[:]+)", sel[i:])
            if m:
                preds.append("[contains(concat(' ',normalize-space(@class),' '),' %s ')]" % m.group(1))
                i += m.end()
                continue
        if c == "[":
            depth, j = 0, i
            while j < len(sel):
                if sel[j] == "[":
                    depth += 1
                elif sel[j] == "]":
                    depth -= 1
                    if depth == 0:
                        break
                j += 1
            inner = sel[i + 1:j]
            mm = re.match(r"([\w:-]+)\s*(?:([*^$~]?=)\s*['\"]?([^'\"]*)['\"]?)?$", inner.strip())
            if mm:
                attr, op, val = mm.group(1), mm.group(2), mm.group(3)
                preds.append(_attr_eq(attr, val, op) if op else "[@%s]" % attr)
            i = j + 1
            continue
        if c == ":":
            mc = re.match(r":contains\(([^)]*)\)", sel[i:])
            if mc:
                preds.append("[contains(normalize-space(.), '%s')]" % mc.group(1).replace("'", ""))
                i += mc.end()
                continue
            m = re.match(r":(nth-child|nth-of-type|first-child|last-child|first-of-type|last-of-type)\(?([^)]*)\)?", sel[i:])
            if m:
                name, arg = m.group(1), (m.group(2) or "").strip()
                if name == "first-child":
                    preds.append("[count(preceding-sibling::*)=0]")
                elif name == "last-child":
                    preds.append("[count(following-sibling::*)=0]")
                elif name in ("nth-child", "nth-of-type"):
                    if arg.isdigit():
                        preds.append("[count(preceding-sibling::*)=%d]" % (int(arg) - 1))
                    else:
                        mm2 = re.match(r"([\d]*)n\+?(\d*)", arg.replace(" ", ""))
                        if mm2:
                            a = int(mm2.group(1) or 1)
                            b = int(mm2.group(2) or 0)
                            preds.append("[position() mod %d = %d]" % (a, (b % a) if a else 0))
                i += m.end()
                continue
            i += 1
            continue
        i += 1
    return tag, "".join(preds)


def _tokenize_css(group):
    """按括号层级切分 CSS：属性值里的 + > ~ 空格不会被误当成组合符"""
    toks, buf, depth, i = [], "", 0, 0
    while i < len(group):
        ch = group[i]
        if ch in "[(":
            depth += 1
            buf += ch
        elif ch in "])":
            depth = max(0, depth - 1)
            buf += ch
        elif depth == 0 and ch in " \t\n\r":
            if buf:
                toks.append(buf)
                buf = ""
        elif depth == 0 and ch in ">+~":
            if buf:
                toks.append(buf)
                buf = ""
            toks.append(ch)
        else:
            buf += ch
        i += 1
    if buf:
        toks.append(buf)
    return toks


def css_to_xpath(css):
    """支持：逗号分组、后代空格、子选择 >、相邻 +、通用兄弟 ~"""
    css = css.strip()
    parts = []
    for group in re.split(r",(?![\[\]()'\"])", css):
        group = group.strip()
        if not group:
            continue
        segs = []
        comb = None
        for t in _tokenize_css(group):
            if t in (">", "+", "~"):
                comb = t
                continue
            tag, preds = _compound(t)
            segs.append((comb or " ", tag, preds))
            comb = None
        if not segs:
            continue
        xp = ".//%s%s" % (segs[0][1], segs[0][2])
        for c, tag, preds in segs[1:]:
            if c == ">":
                xp += "/%s%s" % (tag, preds)
            elif c == "+":
                xp += "/following-sibling::%s%s[1]" % (tag, preds)
            elif c == "~":
                xp += "/following-sibling::%s%s" % (tag, preds)
            else:
                xp += "//%s%s" % (tag, preds)
        parts.append(xp)
    if not parts:
        return ".//*"
    return " | ".join(parts)


# ---------------------------------------------------------------- 规则链
def split_alt(rule):
    """按顶层 | & %% 拆分，返回 (kind, [parts])；kind 取 | & %%"""
    out, buf, depth, i = [], "", 0, 0
    s = rule
    kind = "|"
    while i < len(s):
        if s[i] in "['\"":
            q = s[i]
            j = i + 1
            while j < len(s) and s[j] != q:
                j += 1
            buf += s[i:j + 1]
            i = j + 1
            continue
        if s[i] in "[(":
            depth += 1
        elif s[i] in "])":
            depth -= 1
        if depth == 0:
            if s.startswith("%%", i):
                out.append(buf); buf = ""; kind = "%%"; i += 2; continue
            if s.startswith("&&", i):
                out.append(buf); buf = ""; kind = "&"; i += 2; continue
            if s.startswith("||", i):
                out.append(buf); buf = ""; kind = "|"; i += 2; continue
            if s[i] == "&":
                out.append(buf); buf = ""; kind = "&"; i += 1; continue
            if s[i] == "|":
                out.append(buf); buf = ""; kind = "|"; i += 1; continue
        buf += s[i]
        i += 1
    out.append(buf)
    return kind, [p for p in out if p.strip()]


def strip_replace(rule):
    """拆出 ##正则##替换 或 #正则"""
    m = re.search(r"##(.+?)##(.*)$", rule, re.S)
    if m:
        return rule[:m.start()], (m.group(1), m.group(2))
    m = re.search(r"#(.+)$", rule)
    if m and "@" in rule[:m.start()] or (m and rule[:m.start()].strip().startswith((".", "//", "#"))):
        try:
            re.compile(m.group(1))
            return rule[:m.start()], (m.group(1), "")
        except re.error:
            return rule, None
    return rule, None


def apply_replace(vals, rep):
    if not rep:
        return vals
    pat, tpl = rep
    # 阅读的模板用 $1，Python 用 \1，统一转换（避免 \1 被当成转义）
    tpl_py = re.sub(r"\$(\d+)", lambda m: "\\g<%s>" % m.group(1), tpl)
    out = []
    for v in vals:
        try:
            out.append(re.sub(pat, tpl_py, v))
        except re.error:
            out.append(v)
    return out


def _seg_query(seg):
    """解析阅读私有语法的单段，返回 (查询类型, 参数, 索引, 排除集合)"""
    seg = seg.strip()
    if seg.startswith("+"):  # 阅读里 + 表示“追加”，对单段无意义，剥掉
        seg = seg[1:].strip()
    if seg.startswith("css:"):
        seg = seg[4:].strip()
    idx, excl = None, set()
    m = re.search(r"!([\d:\-]+)$", seg)
    if m:
        for part in m.group(1).split(":"):
            part = part.strip()
            if not part:
                continue
            if re.match(r"^-?\d+$", part):
                excl.add(int(part))
        seg = seg[:m.start()]
    m = re.match(r"^(.+?)\.(-?\d+)$", seg)
    if m:
        seg, idx = m.group(1), int(m.group(2))
    if seg.startswith("class."):
        return ("class", seg[6:], idx, excl)
    if seg.startswith("id."):
        return ("id", seg[3:], idx, excl)
    if seg.startswith("tag."):
        return ("tag", seg[4:], idx, excl)
    if seg.startswith("text."):
        return ("nested", "", None, excl) if False else ("text", seg[5:], idx, excl)
    if seg == "children":
        return ("children", "", None, excl)
    if seg.startswith("[") and seg.endswith("]"):
        return ("children", "", None, excl)
    return ("css", seg, idx, excl)


def _pick(nodes, idx, excl):
    if excl:
        nodes = [n for i, n in enumerate(nodes) if i not in excl]
    if idx is None:
        return list(nodes)
    try:
        return [nodes[idx]]
    except IndexError:
        return []


def _sel(node, kind, arg):
    if node is None:
        return []
    if kind == "css":
        try:
            return node.xpath(css_to_xpath(arg), namespaces=NS)
        except Exception:
            return []
    if kind == "class":
        try:
            return node.xpath(".//*[contains(concat(' ',normalize-space(@class),' '),' %s ')]" % arg, namespaces=NS)
        except Exception:
            return []
    if kind == "id":
        return node.xpath(".//*[@id=$v]", v=arg, namespaces=NS)
    if kind == "tag":
        try:
            return node.xpath(".//" + arg.replace("*", "*"), namespaces=NS)
        except Exception:
            return []
    if kind == "text":
        return node.xpath(".//*[contains(text(),$v)]", v=arg, namespaces=NS)
    if kind == "children":
        return list(node)
    return []


def _extract(node, kw):
    kwl = kw.lower()
    if kwl in ("text",):
        t = "".join(node.itertext())
        return re.sub(r"[\r\t\u00a0]+", " ", t).strip()
    if kwl == "textnodes":
        return "\n".join(x.strip() for x in node.itertext() if x.strip())
    if kwl == "html":
        return LH.tostring(node, encoding="unicode") if isinstance(node, etree._Element) else str(node)
    if kwl == "owntext":
        return (node.text or "").strip()
    if kwl in ("href", "src", "content", "value", "title", "data-src"):
        v = node.get(kw)
        if v is None and kwl == "src":
            v = node.get("data-src") or node.get("data-original") or node.get("_src")
        return (v or "").strip()
    if kwl == "all":
        return (node.text or "").strip()
    return (node.text or "").strip()


def eval_chain(rule, roots, base_url="", raw_nodes=False):
    """返回 (nodes_or_texts, 是否带抽取)。raw_nodes=True 时无抽取段也返回元素。"""
    rule = rule.strip()
    if not rule:
        return roots, False
    prefix = ""
    m = re.match(r"^@(css|xpath|json|regex|match|replace|encode|decode|filter|http|webview|js):(.+)$", rule, re.S)
    if m:
        prefix, rule = m.group(1), m.group(2).strip()
    if prefix in ("js", "webview", "http", "regex", "json"):
        raise NotImplementedError("rule needs " + prefix)
    if prefix == "css":
        rule = "@css " + rule  # 标记，稍后处理
    segs = [s for s in re.split(r"@(?![^@]*$)", rule) if s.strip()] if "@" in rule else [rule]
    # 上面的切分不对，这里手工切：按 @ 切，但 @ 只作分隔（阅读语法的 @ 就是分隔符）
    segs = [s for s in rule.split("@") if s.strip()]
    nodes = roots
    extracted = False
    for i, seg in enumerate(segs):
        s = seg.strip()
        low = s.lower()
        if low in EXTRACT:
            vals = []
            for n in (nodes if isinstance(nodes, list) else [nodes]):
                if isinstance(n, str):
                    vals.append(n)
                else:
                    vals.append(_extract(n, s))
                    if low in ("href", "src", "data-src", "content"):
                        if vals[-1]:
                            vals[-1] = abs_url(base_url, vals[-1])
            nodes, extracted = vals, True
            continue
        if s.startswith("@"):  # 已处理的 prefix
            s = s.lstrip("@")
        if s.startswith("//") or s.startswith("./"):
            xs = s
            new = []
            for n in nodes:
                if isinstance(n, str):
                    continue
                try:
                    new.extend(n.xpath(xs, namespaces=NS))
                except Exception:
                    pass
            nodes = new
            continue
        if s.lower().startswith("xpath:"):
            xs = s[6:].strip()
            new = []
            for n in nodes:
                if isinstance(n, str):
                    continue
                if xs.startswith("//"):
                    xs2 = "." + xs
                elif not xs.startswith("."):
                    xs2 = ".//" + xs
                else:
                    xs2 = xs
                try:
                    new.extend(n.xpath(xs2, namespaces=NS))
                except Exception:
                    pass
            nodes = new
            continue
        kind, arg, idx, excl = _seg_query(s)
        new = []
        for n in nodes:
            if isinstance(n, str):
                continue
            new.extend(_sel(n, kind, arg))
        nodes = _pick(new, idx, excl)
    if not extracted:
        if raw_nodes:
            return nodes, False
        texts = []
        for n in nodes:
            if isinstance(n, str):
                texts.append(n)
            else:
                try:
                    texts.append(_extract(n, "text"))
                except Exception:
                    pass
        return texts, True
    return nodes, True


def eval_rule(rule, doc, base_url="", single=True):
    """对外入口：返回字符串(single) 或 元素列表"""
    if not rule:
        return "" if single else []
    rule, rep = strip_replace(rule)
    kind, parts = split_alt(rule)
    results = []
    for p in parts:
        try:
            vals, _ = eval_chain(p, [doc], base_url)
        except NotImplementedError:
            raise
        except Exception:
            vals = []
        vals = [v for v in (vals or []) if v not in (None, "")]
        results.append(vals)
    if kind == "&":
        merged = []
        for r in results:
            merged.extend(r)
        out = merged
    elif kind == "%%":
        out = []
        for i in range(max((len(r) for r in results), default=0)):
            for r in results:
                if i < len(r):
                    out.append(r[i])
    else:
        out = []
        for r in results:
            if r:
                out = r
                break
    out = apply_replace(out, rep)
    if single:
        return out[0] if out else ""
    return out


def eval_list(rule, doc, base_url=""):
    """书列表/目录列表：返回元素列表"""
    if not rule:
        return []
    rule, _ = strip_replace(rule)
    kind, parts = split_alt(rule)
    out = []
    for p in parts:
        try:
            nodes, _ = eval_chain(p, [doc], base_url, raw_nodes=True)
        except NotImplementedError:
            raise
        except Exception:
            nodes = []
        els = [n for n in nodes if not isinstance(n, str)]
        if kind == "&":
            out.extend(els)
        elif not out:
            out = els
    return out


# ---------------------------------------------------------------- 书源包装
KEYWORDS = {"{{key}}": "key", "searchKey": "key", "${key}": "key",
            "{{page}}": "page", "searchPage": "page", "${page}": "page"}


def hdrs(src):
    """header 可能是 dict、JSON 字符串或 "K: V" 多行字符串，统一成 dict"""
    h = src.get("header")
    if isinstance(h, dict):
        return dict(h)
    if isinstance(h, str) and h.strip():
        try:
            v = json.loads(h)
            return v if isinstance(v, dict) else {}
        except Exception:
            out = {}
            for line in h.splitlines():
                if ":" in line:
                    k, v = line.split(":", 1)
                    out[k.strip()] = v.strip()
            return out
    return {}


def norm_base(src):
    u = (src.get("bookSourceUrl") or "").split("#")[0].strip()
    if not u:
        return ""
    if u.startswith("//"):
        u = "https:" + u
    if not re.match(r"^https?://", u):
        if re.match(r"^[\w\-]+\.[\w\-.]+(/|$)", u):
            u = "https://" + u
        else:
            return ""
    return u


def build_search(src, key, page=1):
    """解析 searchUrl，返回 (url, method, body, headers, charset)"""
    su = (src.get("searchUrl") or "").strip()
    if not su:
        raise ValueError("no searchUrl")
    charset = None
    body = None
    headers = hdrs(src)
    m = re.match(r"^(.+?),(?=\s*\{)(\{.*\})$", su, re.S)
    if m:
        su = m.group(1).strip()
        try:
            cfg = json.loads(m.group(2))
            body = cfg.get("body")
            charset = cfg.get("charset")
            if cfg.get("method"):
                method = cfg["method"].upper()
            if cfg.get("headers"):
                headers.update(cfg["headers"])
            if cfg.get("url"):
                su = cfg["url"]
        except json.JSONException:
            pass
    method = "POST" if body else "GET"
    base = norm_base(src)
    if su.startswith("/"):
        su = base.rstrip("/") + su
    elif not su.startswith("http"):
        su = abs_url(base, su)
    ek = urllib.parse.quote(key, safe="")
    for k, v in KEYWORDS.items():
        su = su.replace(k, str(page) if v == "page" else ek)
    if body:
        for k, v in KEYWORDS.items():
            body = body.replace(k, str(page) if v == "page" else ek)
    return su, method, body, headers, charset


def clean_name(v):
    v = re.sub(r"\s+", " ", (v or "")).strip()
    v = re.sub(r"^[《〈【\[\(]+", "", v)
    v = re.sub(r"[》〉】\]\)]+$", "", v)
    return v.strip()


def clean_author(v):
    v = re.sub(r"\s+", " ", (v or "")).strip()
    v = re.sub(r"^(作者|作\s*者|著)\s*[：:]\s*", "", v)
    return v.strip()


def html_to_text(blob):
    """把 @html 抓到的片段转成纯文本：去脚本样式、br 变换行、标签全剥"""
    if not blob or "<" not in blob:
        return blob or ""
    b = re.sub(r"<(script|style|iframe)[^>]*>.*?</\1>", "", blob, flags=re.I | re.S)
    b = re.sub(r"<br\s*/?>", "\n", b, flags=re.I)
    b = re.sub(r"</?(p|div|h\d|li|tr|td)[^>]*>", "\n", b, flags=re.I)
    b = re.sub(r"<[^>]+>", "", b)
    b = (b.replace("&nbsp;", " ").replace("&amp;", "&").replace("&lt;", "<")
          .replace("&gt;", ">").replace("&quot;", '"').replace("&#39;", "'"))
    return b


def chapter_order_fix(chapters):
    """有的站点目录是新章在前，靠名字里的数字判断，必要时整体倒序"""
    if len(chapters) < 4:
        return chapters
    def num(nm):
        m = re.search(r"第?\s*([零一二三四五六七八九十百千万\d]+)\s*[章节回]", nm)
        if not m:
            return None
        s = m.group(1)
        if s.isdigit():
            return int(s)
        return None
    a, b = num(chapters[0]["name"]), num(chapters[-1]["name"])
    if a is not None and b is not None and a > b + 2:
        return list(reversed(chapters))
    # 前 3 章数字连续递减也判定为倒序
    seq = [num(c["name"]) for c in chapters[:4]]
    if all(isinstance(x, int) for x in seq) and seq[0] > seq[1] > seq[2]:
        return list(reversed(chapters))
    return chapters


NOISE_SENT = re.compile(
    r"(提供免费|免费阅读|免费小说|网友上传|整理而成|版权属|版权归|24小时|请收藏|本站|"
    r"首发|无弹窗|更新最快|更多精彩|精心创作|非常好看|小说阅读网|笔趣阁|"
    r"最快更新|加入书签|TXT下载|求收藏|求推荐|请记住)")
# “书名,书名是作者X精心创作的一本非常好看的小说”这类模板话术
NOISE_TPL = re.compile(r"^(?:[^,，]{1,20}[,，])?[^,，]{1,20}是作者[\u4e00-\u9fa5A-Za-z0-9_]{1,12}"
                       r"[^。]{0,40}(?:小说|作品)", re.S)


def clean_intro(v):
    v = re.sub(r"\s+", " ", (v or "")).strip()
    v = re.sub(r"^[简簡]介[：:]\s*", "", v)
    v = re.sub(r"\s*[（(][^（）()]{0,40}(www\.|http|\.com|\.info|\.org)[^（）()]{0,40}[）)]", "", v)
    v = re.sub(r"[，,]?\s*(TXT|txt|全文)?下载", "", v)
    v = re.sub(r"[，,]?\s*(免费阅读|无弹窗|最新章节|全文阅读)[，,]?", "", v)
    # 按句剔除站点推广句，保留真正的剧情简介
    parts = re.split(r"(?<=[。！？!?])", v)
    keep = [p for p in parts if p and not NOISE_SENT.search(p)]
    v = "".join(keep).strip()
    v = NOISE_TPL.sub("", v).strip()
    return v.strip(" ，,。.;；")


def clean_url(u):
    return re.sub(r"[#\s]+$", "", (u or "").strip())


def needs_js(src):
    blob = json.dumps(src, ensure_ascii=False).lower()
    return ("@js:" in blob) or ("@webview:" in blob) or ("java." in blob) or bool(src.get("loginUrl"))


def search(src, key, page=1, timeout=15):
    """执行一次搜索，返回 [{name, author, url, cover, intro, last, source}]"""
    name_col = src.get("bookSourceName", "")
    url, method, body, headers, charset = build_search(src, key, page)
    text, final = fetch(url, method=method, headers=headers, body=body, timeout=timeout)
    doc = parse_html(text)
    if doc is None:
        return []
    rs = src.get("ruleSearch") or {}
    items = eval_list(rs.get("bookList") or "", doc, final)
    out = []
    for it in items[:20]:
        def g(field, single=True, base=None):
            r = rs.get(field) or ""
            if not r:
                return ""
            try:
                return eval_rule(r, it, base or final, single=single)
            except NotImplementedError:
                raise
            except Exception:
                return "" if single else []
        n = clean_name(g("name"))
        if not n:
            continue
        u = g("bookUrl").strip()
        cover = g("coverUrl").strip()
        out.append({"name": n, "author": clean_author(g("author")), "url": clean_url(abs_url(final, u)),
                    "cover": clean_url(abs_url(final, cover)), "intro": clean_intro(g("intro")),
                    "last": g("lastChapter").strip(), "kind": g("kind").strip(),
                    "source": name_col})
    return out


def book_detail(src, book_url, timeout=15):
    headers = hdrs(src)
    text, final = fetch(book_url, headers=headers, timeout=timeout)
    doc = parse_html(text)
    if doc is None:
        raise ValueError("empty book page")
    rb = src.get("ruleBookInfo") or {}
    def g(field):
        r = rb.get(field) or ""
        if not r:
            return ""
        try:
            return eval_rule(r, doc, final)
        except Exception:
            return ""
    return {"name": g("name"), "author": g("author"), "intro": g("intro"),
            "cover": abs_url(final, g("coverUrl")), "kind": g("kind"),
            "last": g("lastChapter"), "url": final}


def toc(src, book_url, timeout=15):
    headers = hdrs(src)
    rb = src.get("ruleBookInfo") or {}
    toc_url = book_url
    if rb.get("tocUrl"):
        try:
            text, final = fetch(book_url, headers=headers, timeout=timeout)
            doc = parse_html(text)
            t = eval_rule(rb.get("tocUrl"), doc, final)
            if t:
                toc_url = abs_url(final, t)
        except Exception:
            pass
    text, final = fetch(toc_url, headers=headers, timeout=timeout)
    doc = parse_html(text)
    if doc is None:
        raise ValueError("empty toc page")
    rt = src.get("ruleToc") or {}
    chapters = []
    for it in eval_list(rt.get("chapterList") or "", doc, final):
        def g(field):
            r = rt.get(field) or ""
            if not r:
                return ""
            try:
                return eval_rule(r, it, final)
            except Exception:
                return ""
        cn = g("chapterName").strip()
        cu = g("chapterUrl").strip()
        if cn and cu:
            chapters.append({"name": cn, "url": abs_url(final, cu)})
    return {"url": final, "chapters": chapter_order_fix(chapters)}


def content(src, chapter_url, timeout=15):
    headers = hdrs(src)
    text, final = fetch(chapter_url, headers=headers, timeout=timeout)
    doc = parse_html(text)
    if doc is None:
        raise ValueError("empty chapter page")
    rc = src.get("ruleContent") or {}
    raw = ""
    rule = rc.get("content") or ""
    if rule:
        try:
            rule2, rep = strip_replace(rule)
            kind, parts = split_alt(rule2)
            best = ""
            for p in parts:
                try:
                    nodes, _ = eval_chain(p, [doc], final)
                except Exception:
                    continue
                vals = [n if isinstance(n, str) else "\n".join(x.strip() for x in n.itertext() if x.strip()) for n in nodes]
                blob = "\n".join(v for v in vals if v)
                if len(blob) > len(best):
                    best = blob
            raw = best
        except NotImplementedError:
            raise
    if not raw:
        ps = doc.xpath("//p|//div", namespaces=NS)
        cand = max(("\n".join(x.strip() for x in p.itertext() if x.strip()) for p in ps), key=len, default="")
        raw = cand
    # 常见噪音清理
    raw = html_to_text(raw)
    for pat in (r"本章未完.*?点击.*?继续阅读", r"请记住本站.*?域名", r"最新网址[：:]?.*", r"章节错误.*?举报",
                r"（?推荐各位书友阅读[：:].{0,30}）?",
                r"\s*[（(][^（）()]{0,40}(www|http|ωωω|ｗｗｗ)[^（）()]{0,40}[）)]",
                r"\s*[^\u4e00-\u9fa5\s]{0,24}更新最快",
                r"\s*（本章完）"):
        raw = re.sub(pat, "", raw)
    raw = re.sub(r"【[^】]{0,20}(网|站|ωωω|ＵＪ)[^】]*】", "", raw)
    # 搜索引擎引流话术（常被塞在段落中间或单独成行）
    raw = re.sub(r"(佰度|百度|谷歌|360|搜狗)\s*搜索[^。！？\n]{0,40}(下载|电子书|小说|TXT)[^。！？\n]{0,10}[！!]?", "", raw)
    raw = re.sub(r"全集\s*TXT\s*电子书[^。！？\n]{0,10}[！!]?", "", raw)
    raw = re.sub(r"[（(]?\s*电子书免费下载[^。！？\n]{0,10}[）)]?[！!]?", "", raw)
    lines = [l.strip() for l in re.split(r"\n+", raw) if l.strip()]
    nav_words = {"返回", "首页", "设置", "关灯", "开灯", "目录", "书架", "搜索", "加入书签",
                 "手机阅读", "电脑版", "举报", "返回目录", "上一章", "下一章", "上一页", "下一页"}
    paras = []
    for i, l in enumerate(lines):
        # 开头的站点导航块：返回/首页/设置/关灯、纯 JS 调用、带(第x/y页)的重复标题、超短无标点残行
        if i < 8:
            if l in nav_words:
                continue
            if re.fullmatch(r"[\w$]+(?:\.[\w$]+)?\(\s*\)\s*;?", l):
                continue
            if re.search(r"[（(]\s*第\s*\d+\s*/\s*\d+\s*页\s*[）)]", l):
                continue
            if len(l) <= 10 and not re.search(r"[，。！？、；：“”‘’…—]", l):
                continue
        if len(l) <= 30 and re.search(r"(最新章节|目\s*录|上一章|下一章|加入书架|投推荐票|手机阅读|本章未完|最新网址|\[?www\.|ωωω|请收藏|无弹窗|免费阅读|免费小说|首发)", l):
            continue
        # 站点尾巴：手打/书库/章节列表/请记住域名 这类整行都是推广语
        if len(l) <= 60 and re.search(
                r"(高速文字手打|文字手打|手打|章节列表|请记住|首发域名|本站|书友|笔趣阁|书库|顶点|"
                r"全文阅读|返回目录|电脑版|手机版|更新最快|加入书签|求月票|求推荐票|章节报错|"
                r"佰度|百度|搜索引擎|电子书|免费下载|全集TXT)", l):
            continue
        # 整行是网址（正文里出现超链接基本都是站点广告）
        if len(l) <= 200 and re.search(r"https?://|www\.|ωωω|ｗｗｗ", l) and not re.search(r"[。！？，]", l[:40]):
            continue
        l = re.sub(r"^[，,、。；;：:\s]+", "", l)
        if len(l) < 6 and not re.search(r"[\u4e00-\u9fa5]{2}", l):
            continue
        paras.append(l)
    # 二次兜底：有些站点把导航块塞在不可见字符之间，行号判断会错位，
    # 这里直接从头裁掉"明显不是正文开头"的碎片（最多裁 8 段，别把正文裁没了）
    def _junk(h):
        return (h in nav_words
                or re.fullmatch(r"(?:[\w$]+(?:\.[\w$]+)?\(\s*\)\s*;?\s*)+", h)
                or re.search(r"[（(]\s*第\s*\d+\s*/\s*\d+\s*页\s*[）)]", h)
                or (len(h) <= 10 and not re.search(r"[，。！？、；：“”‘’…—]", h))
                # 菜单小标题（"热搜小说：" 这种短词+冒号）
                or (len(h) <= 14 and re.search(r"[：:]$", h)
                    and not re.search(r"[，。！？、；“”‘’…—]", h.rstrip("：:")))
                # 页面大标题：带"第x章"又带站名分隔符（"书名 第一卷 xx 第一章 xxx_网站"）
                or (re.search(r"第[0-9零一二三四五六七八九十百千]+章", h)
                    and re.search(r"[_|｜\-–~]", h)
                    and not re.search(r"[。！？]", h[-1:]))
                # 站点自我介绍：以"xx小说网，……提供下载/阅读"开头的一段
                or (len(h) <= 80 and re.search(r"小说网|书城|书吧|文学网", h)
                    and re.search(r"下载|阅读|提供|收藏|免费|全本", h))
                # 正文顶部重复的章节名（"第一卷 笼中雀 第一章 惊蛰"），短且无句读
                or (len(h) <= 40 and re.search(r"第[0-9零一二三四五六七八九十百千]+章", h)
                    and not re.search(r"[。！？，]", h))
                # "作者：xxx 更新时间：2018-…" 这类页眉
                or (len(h) <= 60 and re.search(r"作\s*者", h) and re.search(r"更新|时间", h)))

    # 导航菜单块：连续二三十行都是"玄幻/言情/总裁"这种 2~12 字的纯词条，
    # 只有在后面确实出现正常段落时才整块丢弃，避免把散文开头的短句删掉
    def _prose_after(idx, span=40):
        for j in range(idx, min(len(paras), idx + span)):
            if len(paras[j]) >= 18 and re.search(r"[。！？]", paras[j]):
                return True
        return False

    cut = 0
    while cut < len(paras) and cut < 30:
        h = paras[cut]
        if len(h) <= 12 and not re.search(r"[，。！？、；“”‘’…—]", h.rstrip("：:")):
            cut += 1
            continue
        break
    if 0 < cut and _prose_after(cut):
        paras = paras[cut:]

    # 菜单块之后才轮到大标题/页眉，所以这段必须放在裁完导航之后
    dropped = 0
    while paras and dropped < 40 and _junk(paras[0]):
        paras.pop(0)
        dropped += 1
    return "\n\n".join(paras).strip()


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", required=True)
    ap.add_argument("--key", default="剑来")
    ap.add_argument("--limit", type=int, default=8)
    ap.add_argument("--only", default="")
    a = ap.parse_args()
    data = json.load(open(a.json, encoding="utf-8"))
    n = 0
    for s in data:
        if a.only and a.only not in s.get("bookSourceName", ""):
            continue
        if needs_js(s) or s.get("bookSourceType") != 0:
            continue
        n += 1
        if n > a.limit:
            break
        print("==>", s.get("bookSourceName"))
        t0 = time.time()
        try:
            r = search(s, a.key, 1, timeout=12)
            print("   %.1fs  %d 条" % (time.time() - t0, len(r)))
            for x in r[:3]:
                print("      -", x["name"], "|", x["author"], "|", x["url"][:80])
        except Exception as e:
            print("   FAIL", type(e).__name__, str(e)[:90])


