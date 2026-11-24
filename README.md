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
* **阅读足迹**：「我的」页有浏览历史 / 搜索历史入口；浏览历史记到第几章，点「继续」回到上次那一章，刷新后仍在（存本机 `localStorage`）。
* **书架**：详情页「加入书架」对在线书同样生效，来源元信息一起存本地，刷新后书架照样认得；书架页右上角「+」直接去找书；「管理」模式可多选，底部「移出书架」有二次确认，也能单本移出。
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

### 首页布局

首页只做三件事，从上到下：搜索、书架、搜索历史。

* 搜索框在顶部，回车或点「搜索」直接进多源结果页；
* 搜索框还支持粘贴文章 / 小说章节链接：`http(s)://` 或 `www.` 开头会自动抓取整页、净化成一篇单章「网页文章」或「网页章节」，链接不写进搜索历史；
* 书架只展示最近读的 6 本，卡片下方是「读到 x/y 章 · z%」，空书架给一个「去搜索」按钮，点「全部 ›」进完整书架页；
* 搜索历史保留最近 8 个词，点一下立即重搜；每个词右边「×」只删这一条，右侧「清空」一键清掉全部；
* 底部导航只有「首页 / 我的」两项；书架页、阅读足迹、书源管理等都是二级页，从首页或「我的」进入。

> 书架里没读过、没加过的演示书仍是本地示例数据。社区模块已移除（只保留看书、书架、阅读足迹）。

### 粘贴文章 / 章节链接，自动净化

在首页搜索框粘贴一篇普通文章或小说章节链接（`http(s)://` 或 `www.` 开头），不用点搜索，松手就自动开始：

1. `/api/page` 抓整页 HTML；
2. 先判断是文章还是小说章节：看 `og:novel:*` 元信息、`第X章/节/回` 标题和 URL 里的 `/read/`、`/chapter` 等特征；
3. 浏览器里用 `DOMParser` 找正文容器，按段落长度、文字密度打分，取最高分那个；章节模式优先 `#chaptercontent`、`.read-content`、`#booktxt` 等章节容器，并惩罚链接文字多的目录页；
4. 去掉脚本、表单、导航、页眉页脚、侧栏、广告、分享、评论、推荐、「上一章/下一章/最新网址」等噪声；
5. 只保留标题、作者、来源、正文段落、小标题、引用、列表和图片，重新排版；
6. 普通文章作为「网页文章」、小说章节作为「网页章节」进现有阅读器，字号 / 主题 / 听书 / 进度都能用；章节模式顶部显示书名，正文标题是章节名。

* 图片经 `/api/img` 代理，避开防盗链；文章 / 章节存本机 `localStorage`，最多留最近 8 篇，关掉页面再开仍能从「阅读足迹」继续读；
* 阅读器底栏的「原文」按钮可回原站；搜索框粘贴的链接不会写进搜索历史；
* 遇到登录页、反爬页、视频页或正文太短，会提示「这个页面可能不是文章或小说章节」，并可重试或打开原文；
* 实测阮一峰周刊第 239 期：4664 字、136 段、39 图；少数派《派早报》：2087 字、4 图；悠久小说网《剑来》第 87 章：1685 字、31 段，书名/章节名/作者/来源都识别正确，正文无站点广告。

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
| 文章 / 章节净化 | 目标站要能返回完整 HTML；需要登录、强反爬或正文由前端渲染的页面可能抽不出正文 |

## 八、和 Cloudflare 版的差别

| | Cloudflare 版 | Vercel 版 |
| --- | --- | --- |
| 规则引擎 | 浏览器 `engine.js` | 服务端 Python `srlib.py` |
| 抓取 | Worker `/p` 代理 | 函数内 requests 直抓 |
| 书源规则兼容 | XPath/CSS/JSONPath 子集，无 JS | Python 引擎，无 JS |
| 搜索并发 | 浏览器 `Promise.all`（边搜边出） | 线程池 24 并发，一次性返回 |
| 缓存 | IndexedDB | IndexedDB |
| 运维 | 一个 Worker + 静态资源 | 一个 Python 函数 + 静态文件 |
