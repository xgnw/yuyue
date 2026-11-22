# 愉阅 · Vercel 版

书源聚合阅读器，规则引擎沿用本地版那套 Python（`srlib.py` + lxml），
用一个 Flask 函数把它包成 `/api/*` 接口，前端静态页面照旧。

> 同一个仓库另有 `cloudflare` 分支：书源引擎搬到浏览器里、抓取交给 Worker，不用服务器。
> 两版 UI 完全一致，只是数据层不同。

---

## 一、它是怎么工作的

```
浏览器（index.html）
   │  /api/search  /api/book  /api/content   （同域，无跨域问题）
   ▼
Vercel Python 函数（api/index.py，Flask）
   │  srlib.py：Legado 规则解析 + lxml 取数 + 正文清洗 + 简介清洗
   │  requests 直抓第三方站点（补 UA/Referer）
   ▼
书源站点
```

* **搜索**：读 `_status` 为 ok/part 的源，服务端线程池 8 并发抓取，合并同名书目、按相关度分层。
* **目录 / 正文**：`/api/book` 与 `/api/content`，正文清洗在 Python 里完成。
* **整本下载**：Vercel 函数没有持久盘，所以**不在服务端存**——前端逐章请求正文写进浏览器 **IndexedDB**，断网可读，删除只影响本机。
* **封面**：`/api/img?u=` 图片代理，补 Referer 绕防盗链。

## 二、目录

```
index.html          前端全部页面（搜索/详情/阅读器/书源管理/离线缓存）
platform.js         /api/* 适配层：同域请求 + IndexedDB 缓存优先
cache-idb.js        IndexedDB 整本缓存（接口形状对齐本地版 server.py 的 /api/cache/*）
api/
  index.py          Flask 入口：/api/health、/api/sources、/api/search、/api/book、/api/content、/api/img
  srlib.py          书源规则引擎（与本地版同一份，含正文/简介清洗）
  data/
    sources.json    过滤后的书源清单（303KB / 244 源）
    audit.json      书源体检结果，用于排序与标记
requirements.txt    flask / lxml / requests
vercel.json         函数配置（maxDuration、includeFiles、/api/* 重写）
scripts/
  build-sources.mjs 重新生成 api/data/sources.json
```

## 三、本地跑

```bash
pip install -r requirements.txt
python api/index.py            # http://127.0.0.1:5200
```

Windows 上想换端口：`$env:PORT=5200; python api/index.py`。

## 四、部署到 Vercel

### 方式 A：命令行

```bash
npm i -g vercel
vercel                         # 首次会问项目名/目录，直接回车即可
vercel --prod
```

### 方式 B：Dashboard

1. New Project → Import 这个仓库的 **vercel 分支**；
2. Framework Preset 选 **Other**，Build Command 留空，Output Directory 留空；
3. Deploy。Vercel 看到 `requirements.txt` 会自动装 Python 依赖，`vercel.json` 把 `/api/*` 指到 Flask 函数。

> 函数默认内存 1024MB、`maxDuration` 60s（见 `vercel.json`）。
> Hobby 计划单次响应体上限约 4.5MB，单章正文远小于这个值；整本下载是逐章请求，不会撞上限。

## 五、接口一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | `{ok, mode, sources:{total, enabled, ok}}` |
| GET | `/api/sources` | 书源列表（含 status/ms/count/toc/chars） |
| POST | `/api/sources/toggle` | `{id, enabled}`，仅进程内存生效，重启还原 |
| POST | `/api/sources/test` | `{id, key}` 单源实测 |
| POST | `/api/sources/import` | `{url}` 或 `{json}` 导入书源；过滤 JS 源、去重，返回 added/total/skippedJs/imported |
| GET | `/api/search?key=&limit=` | 并发搜索（limit 上限 300，默认 60） |
| GET | `/api/book?src=&url=` | 详情 + 目录 |
| GET | `/api/content?src=&url=&book=` | 单章正文（`book` 用于前端缓存命中） |
| GET | `/api/img?u=` | 封面代理 |

`/api/cache/*` 不在服务端实现，由前端 `cache-idb.js` 接管，接口形状与本地版一致。

## 六、更新书源

```bash
node scripts/build-sources.mjs
```

优先读 `api/data/sources-full.json`（放一份全量 601 源，6MB，**不要提交**），
没有就现抓公开合集；脚本会剔掉 JS 源、按体检结果打标、精简字段后写 `api/data/sources.json`。
如果输出里 `searchUrl: 0`，说明线上导出缺字段，改用本地全量文件重跑。

也可直接复用 cloudflare 分支的 `public/sources.json`（同一份清单，格式兼容）。

## 七、已知限制

| 项目 | 说明 |
| --- | --- |
| 书源启用状态 | 无数据库，toggle 只在当前函数实例内存里生效，冷启动后恢复默认 |
| 导入的书源 | 同样只活在函数实例内存；浏览器把这份存 `localStorage`（键 `yuyue.sources.custom`），每次加载页面自动补发，冷启动后依然在 |
| JS 书源 | Python 引擎不支持 `<js>`，构建期已剔除；导入时也会自动跳过（提示里显示跳过数量） |
| 缓存 | 在浏览器 IndexedDB，换设备就没了；服务端不存正文 |
| 搜索耗时 | 全量源（150 个左右）约 25~40 秒；线程池 24 并发 + 单源 5s 超时，函数上限 60s。只想要快就传小一点的 `limit` |
| 版权 | 书源来自公开合集，正文版权归原站与作者，仅供个人阅读测试 |

## 八、和 Cloudflare 版的差别

| | Cloudflare 版 | Vercel 版 |
| --- | --- | --- |
| 规则引擎 | 浏览器 `engine.js` | 服务端 Python `srlib.py` |
| 抓取 | Worker `/p` 代理 | 函数内 requests 直抓 |
| 书源规则兼容 | XPath/CSS/JSONPath 子集，无 JS | Python 引擎，无 JS |
| 搜索并发 | 浏览器 `Promise.all`（边搜边出） | 线程池 24 并发，一次性返回 |
| 缓存 | IndexedDB | IndexedDB |
| 运维 | 一个 Worker + 静态资源 | 一个 Python 函数 + 静态文件 |
