# 愉阅 · 云部署两版

同一套前端，两种后端方案，各自独立成一个 GitHub 分支：

| 分支 | 方案 | 规则引擎 | 抓取 | 目录 |
| --- | --- | --- | --- | --- |
| `main` | 单文件离线版 + 部署说明 | 内置演示数据 | 无（纯前端） | 根目录 `愉阅.html` |
| `cloudflare` | 浏览器跑规则 + Worker 代理 | `engine.js` | Worker `/p` | `cloudflare/` |
| `vercel` | Python 函数跑规则 | `srlib.py` | 函数内 requests | `vercel/` |

两版云端方案都实测通过：搜索「剑来」→ 打开《剑来》目录（1300+ 章）→ 读正文（首段「二月二，龙抬头。」）→ 整本缓存到 IndexedDB（20/20 章、断网可读）。

两版还带**造源**：书源管理页点「造源」，粘贴小说详情页链接，自动推断目录/正文/搜索规则，
生成标准 Legado 书源并当场测试（Cloudflare 走 Worker `/p` 抓页，Vercel 走 `/api/page`）。
单文件版是纯前端、不能跨域抓页，所以这一版没有造源入口——要造源请用 `cloudflare` / `vercel` 分支。

## 单文件版（`main` 根目录的 `愉阅.html`）

最早那一版，CSS/JS/演示数据全部内联在一个 130KB 的文件里，双击就能看，不需要任何服务。

* 内置 6 本原创短篇当演示书库，搜索、阅读器、书架、社区都是本地演示数据
* 阅读页头部有 ‹ › 上下章按钮，目录打开时自动滚到「在读」那一章，点目录任意章节直接跳到该章开头（三版行为一致）
* 纯前端，浏览器不能跨域抓第三方站点，所以**没有在线书源**；要搜全网请用 `cloudflare` / `vercel` 分支
* 想让它变成网页：丢到任意静态托管即可（GitHub Pages、对象存储都行）；想用根路径访问就把文件名改成 `index.html`
* 阅读进度、书架存在本机 `localStorage`（键名 `yuyue.reader.v1`），不上传服务器

## 一、开两个分支

每个分支的**根目录**就是对应版本的代码（不是子目录），所以最省事的做法是：两个临时目录各推一次。

```bash
# 0) 先在 GitHub 网页 New repository 建一个空仓库（别勾 README），记下地址
#    例：https://github.com/<你的账号>/yuyue.git

# 1) cloudflare 分支
mkdir C:\tmp\shiye-cf && cd C:\tmp\shiye-cf
git init -b cloudflare
xcopy /E /I C:\Users\Administrator\Doubao\chats\2026-11-21\new-chat\deploy\cloudflare\* .
git add . && git commit -m "feat: Cloudflare 版（Worker 代理 + 浏览器规则引擎）"
git remote add origin https://github.com/<你的账号>/yuyue.git
git push -u origin cloudflare

# 2) vercel 分支
mkdir C:\tmp\shiye-vc && cd C:\tmp\shiye-vc
git init -b vercel
xcopy /E /I C:\Users\Administrator\Doubao\chats\2026-11-21\new-chat\deploy\vercel\* .
git add . && git commit -m "feat: Vercel 版（Flask + Python 规则引擎）"
git remote add origin https://github.com/<你的账号>/yuyue.git
git push -u origin vercel
```

推完在仓库 Settings → Branches 里把默认分支改成 `cloudflare` 或 `vercel`（不影响部署平台按分支选）。
不想用命令行的话，GitHub Desktop 也能做：Add local repository 选这两个临时目录，Publish 时指定分支名即可。

> 推完在仓库 Settings → Branches 里把默认分支设成 `main`（文档 + 单文件版）。
> 部署平台按分支选：Cloudflare 选 `cloudflare`，Vercel 选 `vercel`，与默认分支无关。

## 二、部署

* **Cloudflare**：`wrangler login` → `wrangler deploy`（在 `cloudflare/` 目录执行，读 `wrangler.toml`）。也可 Dashboard 连 Git，选 `cloudflare` 分支，Deploy command 填 `npx wrangler deploy`。
* **Vercel**：`vercel --prod`（在 `vercel/` 目录），或 Dashboard Import 选 `vercel` 分支，Framework 选 Other，Build 留空。

详细说明见各目录的 `README.md`。

## 三、本地先跑

```bash
# 单文件版：直接双击根目录的 愉阅.html，或起个静态服务
python -m http.server 5300        # 然后打开 http://127.0.0.1:5300/愉阅.html

# Cloudflare：不装 wrangler 也能跑
cd deploy\cloudflare && node tools\dev-server.js        # http://127.0.0.1:5199

# Vercel：需要 Python + flask/lxml/requests
cd deploy\vercel && pip install -r requirements.txt
python api\index.py                                     # http://127.0.0.1:5200
```

## 四、两版都卡在哪

| 限制 | 影响 |
| --- | --- |
| 单文件版没有后端 | 只能读内置演示书库，不能搜全网 |
| Worker 禁 eval | `@js:` / `<js>` 书源跑不了，构建期已过滤（601 → 244） |
| 免费版子请求上限 50/次 | 一次搜索十几个源，够用；整本下载逐章请求不受限 |
| Vercel 无常驻盘 | 整本缓存改存浏览器 IndexedDB；书源开关只在函数实例内存生效 |
| 函数响应体 ~4.5MB | 单章正文远小于此，整本下载逐章拉取不会撞限 |
| 公共书源质量 | 有源会 502 或抓不到正文；书源管理里能看到每个源的体检状态和耗时 |
