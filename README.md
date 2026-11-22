# 拾页 · Cloudflare 版

书源聚合阅读器，整套逻辑跑在 Cloudflare 上：**前端页面 + 一个 Worker**（抓取代理 + 封面代理），
书源规则引擎在浏览器里执行，不需要任何服务器，也就不用养 Python 进程。

> 同一个仓库另有 `vercel` 分支：把规则引擎放到 Vercel 的 Python 函数里跑。
> 两版 UI 完全一致，只是数据层不同，方便对比取舍。

---

## 一、它是怎么工作的

```
浏览器（public/index.html + engine.js）
   │  ① 读 sources.json（书源清单，构建期已过滤掉跑不了的源）
   │  ② 按书源规则抓页面 —— 但跨域抓不了，所以……
   ▼
Worker（worker/index.js）
   │  /p?u=<目标URL>&r=<Referer>   补 UA/Referer，把原始字节透传回来
   │  /api/img?u=<封面URL>          封面代理，绕开防盗链
   ▼
第三方站点（书源指向的小说站）
```

* **搜索**：取体检状态为 ok/part 的源，浏览器里并发请求（每个源一次 `/p`），合并同名书目、按相关度分层。
* **目录 / 正文**：只请求选中的那一个源，正文在浏览器里清洗（去广告行、导航块、页眉）。
* **整本下载**：前端逐章调用正文接口，存进 **IndexedDB**，断网也能读，清除缓存只在本机生效。
* **不支持**：`<js>` / `@js:` / `@webview:` / `java.` 规则。Worker 运行时禁止 `eval`，所以这些源在构建期就被剔除（当前 601 个源里留下 244 个）。

## 二、目录

```
public/
  index.html      前端全部页面（搜索/详情/阅读器/书源管理）
  engine.js       浏览器内的书源规则引擎（XPath/CSS/JSONPath 子集）
  platform.js     /api/* 分派：搜索目录正文交给 engine，缓存交给 IndexedDB
  cache-idb.js    IndexedDB 整本缓存，接口形状与本地版 server.py 一致
  sources.json    过滤后的书源清单（303KB / 244 源，可直接提交）
worker/
  index.js        /p 抓取代理、/api/img 封面代理、其余交给静态资源
scripts/
  build-sources.mjs  重新生成 public/sources.json
tools/
  dev-server.js   本地模拟 Worker，不需要装 wrangler 也能跑（默认 5199）
data/
  audit.json      书源体检结果（哪些源能搜/能读目录/能取正文），构建时用来排序打标
```

## 三、本地跑

```bash
node tools/dev-server.js          # http://127.0.0.1:5199
```

想用真实的 Worker 环境：

```bash
npm i -g wrangler
wrangler dev                      # http://127.0.0.1:8787
```

## 四、部署到 Cloudflare

### 方式 A：命令行（最快）

```bash
npm i -g wrangler
wrangler login
wrangler deploy                   # 读取 wrangler.toml，上传 worker + public/ 静态资源
```

部署完会给出 `https://<name>.<account>.workers.dev`，直接打开就能用。

### 方式 B：Dashboard 连 Git

1. Cloudflare Dashboard → Workers & Pages → Create → Connect to Git，选这个仓库的 **cloudflare 分支**；
2. Build command 留空，Deploy command 用 `npx wrangler deploy`；
3. 根目录就是仓库根（`wrangler.toml` 在这）。

> 免费版限制：单次请求最多 50 个子请求。一次搜索只会对十几个源发请求，够用；
> 整本下载是逐章发起的，每章都是一次独立请求，不受这条限制。

## 五、更新书源

```bash
node scripts/build-sources.mjs
```

脚本会：剔除含 JS 的源 → 按 `data/audit.json` 打 `_status` → 精简字段 → 按"能用优先"排序写成 `public/sources.json`。

数据来源优先级：

1. `data/sources-full.json`（本地放一份全量 601 源，最稳，**不要提交进仓库**，6MB）；
2. 没有就现抓 `https://www.yckceo.com/yuedu/shuyuans/json/id/1340.json`。
   注意线上导出偶尔缺 `searchUrl` 字段，脚本会打印 `searchUrl: 0` 提醒你改用方式 1。

体检结果 `data/audit.json` 可以自己造：格式是 `{recs:[{name,host,search,toc,content,ms,err,sample}]}`，
`search/toc` 是条数、`content` 是正文字数。没有这个文件也能跑，只是所有源都标成 `untested`、排序靠后。

## 六、已知限制

| 项目 | 说明 |
| --- | --- |
| JS 书源 | Worker 禁 eval，这类源在构建期被过滤；浏览器版引擎支持 XPath/CSS/JSONPath/正则替换子集 |
| 搜索速度 | 取决于源站响应，一般 2~3 秒；慢源会被并发拖住，可在书源管理里停用 |
| 封面 | 部分源没有封面字段，卡片显示渐变占位 |
| 缓存 | 存在浏览器 IndexedDB，换设备/清站点数据就没了 |
| 版权 | 书源来自公开合集，正文版权归原站与作者，仅供个人阅读测试 |

## 七、和 Vercel 版的差别

| | Cloudflare 版 | Vercel 版 |
| --- | --- | --- |
| 规则引擎 | 浏览器 `engine.js` | 服务端 Python `srlib.py` |
| 抓取 | Worker `/p` 代理 | 函数内 requests 直抓，无跨域问题 |
| 书源数量 | 244（构建期过滤 JS 源） | 244（同一份清单） |
| 搜索并发 | 浏览器 `Promise.all` | 服务端线程池 8 并发 |
| 缓存 | IndexedDB | IndexedDB |
| 费用 | 免费额度足够个人用 | Hobby 免费额度，函数有执行时长上限 |
