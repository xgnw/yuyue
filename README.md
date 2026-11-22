# 愉阅 · 云部署两版

同一套前端，两种后端方案，各自独立成一个 GitHub 分支：

| 分支 | 方案 | 规则引擎 | 抓取 | 目录 |
| --- | --- | --- | --- | --- |
| `cloudflare` | 浏览器跑规则 + Worker 代理 | `engine.js` | Worker `/p` | `cloudflare/` |
| `vercel` | Python 函数跑规则 | `srlib.py` | 函数内 requests | `vercel/` |

两版都实测通过：搜索「剑来」→ 打开《剑来》目录（1300+ 章）→ 读正文（首段「二月二，龙抬头。」）→ 整本缓存到 IndexedDB（20/20 章、断网可读）。

## 一、开两个分支

每个分支的**根目录**就是对应版本的代码（不是子目录），所以最省事的做法是：两个临时目录各推一次。

```bash
# 0) 先在 GitHub 网页 New repository 建一个空仓库（别勾 README），记下地址
#    例：https://github.com/<你的账号>/shiye.git

# 1) cloudflare 分支
mkdir C:\tmp\shiye-cf && cd C:\tmp\shiye-cf
git init -b cloudflare
xcopy /E /I C:\Users\Administrator\Doubao\chats\2026-11-21\new-chat\deploy\cloudflare\* .
git add . && git commit -m "feat: Cloudflare 版（Worker 代理 + 浏览器规则引擎）"
git remote add origin https://github.com/<你的账号>/shiye.git
git push -u origin cloudflare

# 2) vercel 分支
mkdir C:\tmp\shiye-vc && cd C:\tmp\shiye-vc
git init -b vercel
xcopy /E /I C:\Users\Administrator\Doubao\chats\2026-11-21\new-chat\deploy\vercel\* .
git add . && git commit -m "feat: Vercel 版（Flask + Python 规则引擎）"
git remote add origin https://github.com/<你的账号>/shiye.git
git push -u origin vercel
```

推完在仓库 Settings → Branches 里把默认分支改成 `cloudflare` 或 `vercel`（不影响部署平台按分支选）。
不想用命令行的话，GitHub Desktop 也能做：Add local repository 选这两个临时目录，Publish 时指定分支名即可。

> 本机当前没装 git；winget 下载被网络拦了，需要先手动装 https://git-scm.com/download/win
> （或者直接用 GitHub 网页的 “uploading an existing file” 拖整个目录上传，再在 Branches 里改名）。

## 二、部署

* **Cloudflare**：`wrangler login` → `wrangler deploy`（在 `cloudflare/` 目录执行，读 `wrangler.toml`）。也可 Dashboard 连 Git，选 `cloudflare` 分支，Deploy command 填 `npx wrangler deploy`。
* **Vercel**：`vercel --prod`（在 `vercel/` 目录），或 Dashboard Import 选 `vercel` 分支，Framework 选 Other，Build 留空。

详细说明见各目录的 `README.md`。

## 三、本地先跑

```bash
# Cloudflare：不装 wrangler 也能跑
cd deploy\cloudflare && node tools\dev-server.js        # http://127.0.0.1:5199

# Vercel：需要 Python + flask/lxml/requests
cd deploy\vercel && pip install -r requirements.txt
python api\index.py                                     # http://127.0.0.1:5200
```

## 四、两版都卡在哪

| 限制 | 影响 |
| --- | --- |
| Worker 禁 eval | `@js:` / `<js>` 书源跑不了，构建期已过滤（601 → 244） |
| 免费版子请求上限 50/次 | 一次搜索十几个源，够用；整本下载逐章请求不受限 |
| Vercel 无常驻盘 | 整本缓存改存浏览器 IndexedDB；书源开关只在函数实例内存生效 |
| 函数响应体 ~4.5MB | 单章正文远小于此，整本下载逐章拉取不会撞限 |
| 公共书源质量 | 有源会 502 或抓不到正文；书源管理里能看到每个源的体检状态和耗时 |
