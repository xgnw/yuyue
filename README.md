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
* **阅读器翻章**：头部有 ‹ › 上一章 / 下一章（首末章自动置灰），手机上也能左右滑翻章；打开目录会自动滚到「在读」那一章，点任意章节直接跳到该章开头，不再受上次滚动位置影响。
* **整本下载**：Vercel 函数没有持久盘，所以**不在服务端存**——前端逐章请求正文写进浏览器 **IndexedDB**，断网可读，删除只影响本机。
* **封面**：`/api/img?u=` 图片代理，补 Referer 绕防盗链。

## 二、目录

```
index.html          前端全部页面（搜索/详情/阅读器/书源管理/离线缓存）
platform.js         /api/* 适配层：同域请求 + IndexedDB 缓存优先
cache-idb.js        IndexedDB 整本缓存（接口形状对齐本地版 server.py 的 /api/cache/*）
infer.js            从小说详情页链接自动推断规则、生成 Legado 书源（造源器）
api/
  index.py          Flask 入口：/api/health、/api/sources、/api/search、/api/book、/api/content、/api/img、/api/page
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
| POST | `/api/sources/delete` | `{urls}` 或 `{url}` 删除书源，返回 total/removed/urls |
| POST | `/api/sources/purge` | 一次删掉体检为 dead 的源，返回 total/removed/urls |
| GET | `/api/sources/export` | 导出当前生效的整份清单（内置 + 导入 - 删除），用于合并进仓库 |
| POST | `/api/sources/status` | `{map:{url:status}}` 把浏览器记下的测试结果补发进函数内存 |
| GET | `/api/search?key=&limit=` | 并发搜索（limit 上限 300，默认 60） |
| GET | `/api/book?src=&url=` | 详情 + 目录 |
| GET | `/api/content?src=&url=&book=` | 单章正文（`book` 用于前端缓存命中） |
| GET | `/api/img?u=` | 封面代理 |
| GET/POST | `/api/page?u=&r=` | 抓任意页面原始正文（造源用；带 SSRF 白名单、12s 超时、3MB 上限、按 charset 解码） |

`/api/cache/*` 不在服务端实现，由前端 `cache-idb.js` 接管，接口形状与本地版一致。

## 六、更新书源

```bash
node scripts/build-sources.mjs
```

优先读 `api/data/sources-full.json`（放一份全量 601 源，6MB，**不要提交**），
没有就现抓公开合集；脚本会剔掉 JS 源、按体检结果打标、精简字段后写 `api/data/sources.json`。
如果输出里 `searchUrl: 0`，说明线上导出缺字段，改用本地全量文件重跑。

也可直接复用 cloudflare 分支的 `public/sources.json`（同一份清单，格式兼容）。

### 批量测试书源

书源管理页有「测试全部 N 个」：并发 6 个源，边测边更新列表和进度（`已测 x/y · 可用 · 仅搜索 · 失效`），
失败自动重试一次；结果写进函数内存，同时存浏览器 `localStorage`，页面加载时补发，冷启动后仍然显示真实状态。
批量测试只验证搜索环节——「仅搜索」表示能搜到书，不代表目录/正文一定通。

### 首页实时榜（不是演示数据）

首页「榜单 / 热门讨论 / 精选推荐」和「热点」「书单」两个 tab 全部由真实书源汇总：

* 每个分类带一组候选书名（6 本知名作品），打开首页时并发检索（每个候选只查前 24 个源、同时 3 个）；
* 精确命中的书按「收录它的书源数量」排序，带真实封面/作者/简介；点进去就是真实在线书详情；
* 按分类缓存 2 小时（`localStorage` 键 `shiyue.hot.v1`），右上角「刷新」强制重算；
* 搜不到的候选不占位；同人长尾（如「从笑傲江湖开始横推武道」）不算这本书；
* 源站的「暂无封面」占位图会被自动识别并换成本站渐变封面。

实测（2026-11-22，服务端 24 并发视角）：总榜 剑来 17 源 · 诡秘之主 15 源 · 斗破苍穹 14 源 · 庆余年 12 源 ·
盗墓笔记 10 源 · 三体 4 源；武侠 鹿鼎记 5 源 · 天龙八部 5 源 · 倚天屠龙记 4 源。

> 社区帖子、书架里的演示书仍是本地示例数据，不在「实时」范围内。

### 从详情页链接造源（不依赖第三方书源合集）

书源管理页有一行按钮：「导入书源 | **造源** | 导出」。点「造源」粘贴小说**详情页**链接（一行一个，最多 3 个），
它会依次抓详情页 → 目录页 → 首章 → 搜索页，推断出规则并生成标准 Legado 书源，弹识别报告卡
（书名、目录条数、正文字数、搜索命中数、搜索地址），点「导入并测试」写入列表并立即验证搜索。

抓页走新增的 `/api/page`（Python 侧 `requests` 直抓，带 SSRF 白名单、12s 超时、3MB 上限、按 charset 解码），
推断逻辑全在根目录 `infer.js`，产出的规则**不含 `@js:`**，两版引擎都能跑。

两个真实站点实测（2026-11）：

| 站点 | 书名 | 目录 | 正文 | 搜索 |
| --- | --- | --- | --- | --- |
| 悠久小说网 `www.ujxsw.org` | 剑来 | 1313 章 | 2676 字（引擎 3079） | 8 条命中 |
| 必去书库 `m.biqusk.info` | 剑来 | 25 章 | 542 字（引擎 1760） | 8 条命中 |

**Python 引擎的两个坑（造源时已规避）**：

* 读不到 `<head>`，`title@text` 恒为空 → 书名规则改为具体元素选择器（`#bookinfo h1@text##作者.*##`、`.nav_name h1@text`）；
* `##pattern##replacement` 只认第一对、`||` 会被当成字面量 → 生成规则里不用多段替换和 `||` 兜底。

### 让自己导入的书源在所有设备生效

1. 任意设备打开 **书源管理 → 导出**，得到 `愉阅书源-日期.json`；
2. 把文件放到本项目根目录，执行：

```bash
node scripts/merge-export.mjs 愉阅书源-2026-11-21.json          # 只追加新源（默认，安全）
node scripts/merge-export.mjs 愉阅书源-2026-11-21.json --sync   # 仓库清单 = 导出清单，连删除一起同步
```

3. `git add -A && git commit -m "更新书源清单" && git push`，Vercel 重新部署后所有设备都是这份清单。

脚本会过滤 JS 源、按 `bookSourceUrl` 去重、写回 `api/data/sources.json`，并把新源记进
`api/data/extra-sources.json`——这样以后重跑 `build-sources.mjs` 也不会把导入的源冲掉。

## 七、已知限制

| 项目 | 说明 |
| --- | --- |
| 书源启用状态 | 无数据库，toggle 只在当前函数实例内存里生效，冷启动后恢复默认 |
| 导入的书源 | 同样只活在函数实例内存；浏览器把这份存 `localStorage`（键 `yuyue.sources.custom`），每次加载页面自动补发，冷启动后依然在 |
| 删除的书源 | 浏览器把删除名单存 `localStorage`（键 `yuyue.sources.removed`），加载时补发给函数；只影响本机，重新导入可恢复 |
| 测试状态 | 存 `localStorage`（键 `yuyue.sources.status`），加载时补发 `/api/sources/status`；批量测试只验证搜索环节，失败会自动重试一次 |
| JS 书源 | Python 引擎不支持 `<js>`，构建期已剔除；导入时也会自动跳过（提示里显示跳过数量） |
| 造源 | 只对静态 HTML 站点有效；详情页/目录页靠 JS 渲染或搜索要签名的站会识别失败（报告卡会写原因），一次最多 3 条链接 |
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
