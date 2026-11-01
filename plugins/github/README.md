# Antumi GitHub 插件

独立的 Antumi 任务来源插件，使用 Antumi Plugin SDK。源码、测试、构建和 CI 均在这个仓库，不依赖 Antumi 源码或兄弟仓库。

## 使用

在 Antumi「设置 → 插件」安装 `dist/antumi-plugin-github-1.0.1.zip` 或 `dist/plugin` 目录，在「设置 → 集成 → GitHub」填写筛选条件并登录。

- 使用 Personal access token 登录，或通过 `ANTUMI_GITHUB_TOKEN` 配置凭据。
- 默认筛选 `assignee:@me is:open`，同步分配给自己的开放 Issues 和 Pull Requests，最多 200 项。
- 可以使用 `org:acme`、`label:bug`、`is:issue`、`is:pr`、`review-requested:@me` 等 GitHub 搜索条件。
- 按 `owner/repository#123` 导入，原文快照包含正文、标签和最近 20 条评论，支持重新拉取。

Token 需要读取账号及目标仓库 Issues / Pull Requests 的权限。具体可见范围由 GitHub 的 Token 类型、仓库访问和组织授权共同决定。插件只读，不修改远端事项；当前插件不下载图片附件。

## 兼容原有安装

插件 ID 保持 `antumi.github`，来源 ID 保持 `github`，凭据仍为 `token` 类型，环境变量仍为 `ANTUMI_GITHUB_TOKEN`。原有登录、筛选、导入任务、原文快照和忽略记录继续归属原来源，不需要迁移或重新导入。

Antumi 只保存本仓库的推荐信息，用户点击安装时从 GitHub Release 下载；已有安装继续工作，更新后原版本保留以便回退。

## 独立开发

要求 Node >=22.13。仓库带有 SDK 包 `vendor/antumi-plugin-sdk-0.1.0.tgz`，无需等待 SDK 首次发布到 npm：

```sh
npm ci
npm run check
```

`check` 执行类型检查、带模拟 API 的测试和构建。产物为：

```text
dist/plugin/manifest.json
dist/plugin/main.mjs
dist/antumi-plugin-github-1.0.1.zip
```

ZIP 打包了 SDK 和全部运行时依赖，用户安装时不需要运行 npm 或自行安装 Node。SDK 正式发布后可将 file 依赖改为 npm 版本，并更新 package-lock.json。

ZIP 使用固定时间戳；相同源码与依赖重复构建时校验值保持一致，便于校验独立发布的产物。

设置字段只在 manifest.json 声明。网络请求必须接收 AbortSignal；stdout 专供 SDK 通信，日志写 stderr，不记录凭据。

## GitHub 分发

插件单独发布到本仓库的 GitHub Releases，Antumi 只保存推荐条目；点击安装时才下载最新正式 Release 的 ZIP。仓库中不提交 `dist/` 或 `node_modules/`。

普通提交和 PR 的 CI 只检查并上传构建产物。推送与 package.json、manifest.json 版本一致的 `vX.Y.Z` 标签后，Release 工作流先运行 `npm ci` 和完整检查，再创建 Release 并上传带版本号的 ZIP；带 `-` 的版本标为预发布，不会成为推荐安装使用的 Latest。已有 Release 不覆盖。

当前 Antumi 安装器读取公开 Release。仅创建仓库或提交源码还不能安装，Release 必须包含一个插件 ZIP。设置 → 插件可以检查更新、停用、卸载或切换到保留版本；凭据、筛选和导入任务由 Antumi 保留。
