# 愉阅 · Cloudflare 版

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
* **阅读器翻章**：头部有 ‹ › 上一章 / 下一章（首末章自动置灰），手机上也能左右滑翻章；打开目录会自动滚到「在读」那一章，点任意章节直接跳到该章开头，不再受上次滚动位置影响。
* **阅读足迹**：「我的」页有浏览历史 / 搜索历史入口；浏览历史记到第几章，点「继续」回到上次那一章，刷新后仍在（存本机 `localStorage`）。
* **书架**：详情页「加入书架」对在线书同样生效，来源元信息一起存本地，刷新后书架照样认得；书架页右上角「+」直接去找书。
* **整本下载**：前端逐章调用正文接口，存进 **IndexedDB**，断网也能读，清除缓存只在本机生效。
* **不支持**：`<js>` / `@js:` / `@webview:` / `java.` 规则。Worker 运行时禁止 `eval`，所以这些源在构建期就被剔除（当前 601 个源里留下 244 个）。

## 二、目录

```
public/
  index.html      前端全部页面（搜索/详情/阅读器/书源管理）
  engine.js       浏览器内的书源规则引擎（XPath/CSS/JSONPath 子集）
  platform.js     /api/* 分派：搜索目录正文交给 engine，缓存交给 IndexedDB
  cache-idb.js    IndexedDB 整本缓存，接口形状与本地版 server.py 一致
  infer.js        从小说详情页链接自动推断规则、生成 Legado 书源（造源器）
  sources.json    过滤后的书源清单（303KB / 244 源，可直接提交）
worker/
  index.js        /p 抓取代理、/api/img 封面代理、其余交给静态资源
scripts/
  build-sources.mjs  重新生成 public/sources.json
  merge-export.mjs   把「导出」得到的 JSON 合并进 sources.json（让书源全局生效）
tools/
  dev-server.js   本地模拟 Worker，不需要装 wrangler 也能跑（默认 5199）
data/
  audit.json      书源体检结果（哪些源能搜/能读目录/能取正文），构建时用来排序打标
  extra-sources.json  自己导入/添加的源（merge-export 维护，构建时自动并入）
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

### 自己导入的书源怎么让所有设备都能用

导入的书源默认只活在这台设备的浏览器里。要全局生效，把它并进仓库清单：

1. 任意设备打开 **书源管理 → 导出**，得到 `愉阅书源-日期.json`（内容 = 内置 + 导入 - 删除）；
2. 在 `deploy/cloudflare` 目录执行：

```bash
node scripts/merge-export.mjs 愉阅书源-2026-11-21.json          # 只追加新源（默认，安全）
node scripts/merge-export.mjs 愉阅书源-2026-11-21.json --sync   # 仓库清单 = 导出清单，连删除一起同步
```

3. `git add -A && git commit -m "更新书源清单" && git push`，Workers 重新构建后所有设备共用这份清单。

脚本做的事：过滤 JS 源（云端跑不了）→ 按 `bookSourceUrl` 去重 → 写回 `public/sources.json`
（已有的源保留原体检状态）→ 新源同时记进 `data/extra-sources.json`，以后重跑 `build-sources.mjs` 也不会丢。

### 批量测试书源

书源管理页筛选项下方有「测试全部 N 个」按钮：

* 并发 6 个源一起测，边测边刷列表，右上角实时显示 `已测 x/y · 可用 · 仅搜索 · 失效`；
* 测试用的是当前搜索词（没搜过就用「剑来」），只验证**搜索**这一环：能搜到 → 至少「仅搜索」，搜不到 → 「失效」；
* 失败的源自动重试一次，避免源站偶发超时被误判；
* 跑的过程中按钮变成「停止测试」，点一下会等当前几个测完再收尾；
* 结果按 URL 记在 `localStorage`（键 `shiyue.sources.status`），刷新、换页都保持，也参与排序和「清理失效」。

### 首页实时榜（不是演示数据）

首页「榜单 / 热门讨论 / 精选推荐」和「热点」「书单」两个 tab 全部由真实书源汇总，没有写死的书目：

* 每个分类（总榜/武侠/言情/悬疑/科幻/美食）带一组候选书名（6 本知名作品）；
* 打开首页时并发去书源检索这些候选（每个候选只查前 24 个源、同时跑 3 个），
  精确命中的书按「收录它的书源数量」排序，并带出真实封面、作者、简介；
* 点榜单里的任一本 = 打开真实在线书详情，直接看目录、读正文（走正常多源聚合流程）；
* 结果按分类缓存 2 小时（`localStorage` 键 `shiyue.hot.v1`），右上角「刷新」强制重算；
* 榜单只收「真的能搜到」的书：候选搜不到就不占位，同人长尾（如「从笑傲江湖开始横推武道」）不算这本书；
* 源站给「暂无封面」占位图的，会自动识别并换成本站的渐变书名封面。

实测（2026-11-22）：

| 分类 | 榜单 |
| --- | --- |
| 总榜 | 剑来 15 源 · 诡秘之主 13 源 · 斗破苍穹 12 源 · 庆余年 10 源 · 盗墓笔记 7 源 · 三体 2 源 |
| 武侠 | 倚天屠龙记 3 源 · 鹿鼎记 2 源 · 射雕英雄传 1 源 · 神雕侠侣 1 源 · 天龙八部 1 源 |

> 书架里没读过、没加过的演示书仍是本地示例数据，不在「实时」范围内。社区模块已移除（只保留看书、书架、阅读足迹）。

### 从详情页链接造源（不依赖第三方书源合集）

书源管理页有一行按钮：「导入书源 | **造源** | 导出」。

点「造源」，把小说**详情页**链接粘进去（一行一个，最多 3 个），例如：

```
http://www.ujxsw.org/book/2904/
http://m.biqusk.info/13_13555/
```

它会依次抓取详情页、目录页、首章和搜索页，推断出书源规则，弹出识别报告卡：

```
ujxsw.org · 剑来
目录 1313 章 · 正文约 2676 字 · 搜索命中 50 条
搜索地址: searchbooks.php?searchkey={{key}}
[导入并测试]
```

点「导入并测试」→ 写进本机书源列表（分组「自建」）→ 立刻跑一次搜索验证，结果直接显示。

**推断的流程**（`public/infer.js`，全部在浏览器里做，抓页走 Worker `/p`）：

1. 详情页：书名、作者、简介、封面；找「目录/章节」入口并记下选择器；
2. 目录页：按 href 形状（数字抹成 `#`）给章节锚点聚类，挑出最像"章节目录"的那个容器，
   并用「列表项签名」把 `div.shulist li.three` 这类精确项选出来（名称/链接取 `a.0@text` / `a.0@href`）；
3. 首章：定位正文容器（按中文字数打分）和「下一页」链接；
4. 搜索：优先读站内搜索表单的 action + 字段名，没有就试常见路径；
5. 产出标准 Legado 书源 JSON：`searchUrl`（POST 表单写成 `path,{"method":"POST","body":"..."}`）、
   `ruleSearch / ruleBookInfo / ruleToc / ruleContent`，`bookSourceUrl` 取详情页 origin；全流程不使用 `@js:`。

**实测**（两个真实站点，2026-11）：

| 站点 | 书名 | 目录 | 正文 | 搜索 |
| --- | --- | --- | --- | --- |
| 悠久小说网 `www.ujxsw.org`（GBK） | 剑来 | 1313 章 | 3079 字 | 8 条命中 |
| 必去书库 `m.biqusk.info` | 剑来 | 25 章 | 1760 字 | 8 条命中 |

**注意**：

* 只支持**普通 HTML 站点**；详情页/目录页靠 JS 渲染、或搜索必须带签名的站，识别会失败（报告卡里会写原因）；
* 生成的源只进你这台设备的书源列表，要全局生效按上一节的「导出 → merge-export」走；
* 想批量造源：把「最多 3 个」的上限改大即可（`index.html` 里 `make-run` 的 `slice(0,3)`）。

### 删掉没用的书源

书源管理页每个源右侧有垃圾桶图标（单条删除），状态筛选栏下方有「清理失效 N 个」按钮（一次删掉体检为 dead 的全部源）。

删除记录按 URL 存在浏览器 `localStorage`（键 `shiyue.sources.removed`），所以：

* 只影响你这台设备，别人打开还是完整列表；
* 刷新、关浏览器都保持删除状态；
* 重新导入同一个书源会自动把它从删除名单里恢复；
* 想全部还原：清掉站点数据，或 `localStorage.removeItem('shiyue.sources.removed')` 后刷新。

## 六、已知限制

| 项目 | 说明 |
| --- | --- |
| JS 书源 | Worker 禁 eval，这类源在构建期被过滤；浏览器版引擎支持 XPath/CSS/JSONPath/正则替换子集 |
| 搜索速度 | 全部启用源并发，首批结果约 1 秒出现、跑完约 9~10 秒；慢源可停用或删除 |
| 封面 | 部分源没有封面字段，卡片显示渐变占位 |
| 缓存 | 存在浏览器 IndexedDB，换设备/清站点数据就没了 |
| 删除书源 | 记录只在本机浏览器，不同步到其他设备，也不改仓库里的 `sources.json` |
| 测试状态 | 同样只存本机 `localStorage`；批量测试只验证搜索环节，所以「仅搜索」不等于正文可用 |
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
