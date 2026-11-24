# Antumi GitHub 插件

独立的 Antumi 任务来源插件，使用 Antumi Plugin SDK。源码和测试在本目录，构建与 CI 由 antumi-plugins 仓库统一维护，不依赖 Antumi 源码。

## 使用

在 Antumi「设置 → 插件」安装 `dist/antumi-plugin-github-1.2.0.zip` 或 `dist/plugin` 目录，在「设置 → 集成 → GitHub」填写筛选条件并登录。要求 Antumi >=0.20.0-beta.2。

- 使用 Personal access token 登录，或通过 `ANTUMI_GITHUB_TOKEN` 配置凭据。
- 默认筛选 `assignee:@me is:open`，同步分配给自己的开放 Issues 和 Pull Requests，最多 200 项。
- 可以使用 `org:acme`、`label:bug`、`is:issue`、`is:pr`、`review-requested:@me` 等 GitHub 搜索条件。
- 按 `owner/repository#123` 导入，原文快照包含正文、标签和最近 20 条评论，支持重新拉取。
- 导入和排查时下载正文、最近评论里的图片；新增评论的图片在交给 Agent 时下载。图片较慢时先读取文字，下载后补发。

Token 需要读取账号及目标仓库 Issues / Pull Requests 的权限。具体可见范围由 GitHub 的 Token 类型、仓库访问和组织授权共同决定。只有回写会修改远端事项，见下文。

## 回写

- 在 Antumi 里修改事项状态、发评论。Issue 可以「Close as completed」「Close as not planned」，已关闭的可以 Reopen；Pull Request 只能关闭或重新打开，不能合并，已合并的不能再打开。
- 评论按 Markdown 原样发出，评论同步读回时认作 Antumi 自己发的，不算新评论。
- 写入需要写权限：Fine-grained Token 需要 Issues 读写（回写 Pull Request 状态还需要 Pull requests 读写）；Classic Token 需要 `repo`，只用公开仓库时 `public_repo` 即可。
- 只读 Token 照常同步，写入时报「没有权限」；换一个有写权限的 Token 重新登录即可。已锁定的事项只有协作者能评论。

## 图片

- 识别 Markdown 行内图片、引用式图片和 HTML `<img>`，优先使用 GitHub 返回的渲染地址（包括 GitHub 图片代理和签名地址），相同图片只下载一次。
- 支持 PNG、JPEG、GIF、WebP；每次最多 20 张、单张不超过 10 MB、合计不超过 50 MB。超限、无权限或下载失败不会阻断正文导入，快照会注明未下载数量，原链接保留。
- 只访问 HTTPS 的 GitHub 附件地址和已知图片 CDN，不直接访问任意外部图片站点。GitHub Token 只发送到 GitHub 附件端点，每次跳转都重新检查地址，CDN 请求不带 Token。
- 新评论保存稳定的图片标识；交给 Agent 时重新读取该评论，获取当前的图片地址，避免使用早已过期的签名链接。
- GitHub API 的原文与渲染 HTML 使用 [full 媒体类型](https://docs.github.com/en/rest/issues/issues#get-an-issue)读取。私有附件仍受仓库权限约束；无法取得有效图片地址时会作为下载失败处理。

## 兼容原有安装

插件 ID 保持 `antumi.github`，来源 ID 保持 `github`，凭据仍为 `token` 类型，环境变量仍为 `ANTUMI_GITHUB_TOKEN`。原有登录、筛选、导入任务、原文快照和忽略记录继续归属原来源，不需要迁移或重新导入。

Antumi 只保存本仓库的推荐信息，用户点击安装时从 GitHub Release 下载；已有安装继续工作，更新后原版本保留以便回退。

## 独立开发

要求 Node >=22.13。仓库带有 SDK 包 `../../vendor/antumi-plugin-sdk-0.1.4.tgz`，无需等待 SDK 首次发布到 npm：

```sh
# 在仓库根目录安装
npm ci
npm run check --workspace antumi-plugin-github
```

`check` 执行类型检查、带模拟 API 的测试和构建。产物为：

```text
dist/plugin/manifest.json
dist/plugin/main.mjs
dist/antumi-plugin-github-1.2.0.zip
```

ZIP 打包了 SDK 和全部运行时依赖，用户安装时不需要运行 npm 或自行安装 Node。SDK 正式发布后可将 file 依赖改为 npm 版本，并更新 package-lock.json。

ZIP 使用固定时间戳；相同源码与依赖重复构建时校验值保持一致，便于校验独立发布的产物。

设置字段只在 manifest.json 声明。网络请求必须接收 AbortSignal；stdout 专供 SDK 通信，日志写 stderr，不记录凭据。

## GitHub 分发

在 [flyhero/antumi-plugins](https://github.com/flyhero/antumi-plugins) 中独立发布，标签格式为 `github-vX.Y.Z`。构建产物仍是 `dist/antumi-plugin-github-X.Y.Z.zip`，插件 ID、来源 ID、凭据和配置格式不变。

构建、发布与历史导入说明见 [仓库说明](../../README.md)。旧版 Antumi 可在安装时指定 Release 标签及 ZIP 文件；新版宿主支持按插件标签前缀检查更新。
