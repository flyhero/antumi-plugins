# Antumi Jira 插件

独立维护的 Antumi 任务来源插件，插件 ID `antumi.jira`，来源 ID `jira`。

支持 Jira Cloud 邮箱 + API token 登录、JQL 同步、工作项正文、最近评论、ADF 富文本转换及图片附件。带权限范围的 token 会使用 Atlassian API 网关；附件始终从用户配置的站点下载，不跟随重定向。单图最多 10 MiB，最多 20 张、合计 50 MiB。

## 开发与安装

需要 Node 22.13+（测试工具使用 Node 22、24 或 26）。

```sh
npm ci
npm run check
```

生成 `dist/plugin/` 和 `dist/antumi-plugin-jira-1.0.0.zip`。在支持推荐插件和来源图片的新版 Antumi 中，进入「设置 → 插件」选择 ZIP 安装，或直接安装推荐列表里的 Jira。旧版 Jira 的站点、JQL、登录凭据和已导入任务会保留；用户主动安装插件后继续使用，不会在启动时自动下载或安装。

登录和筛选条件在「设置 → 集成 → Jira」设置。环境变量 `ANTUMI_JIRA_EMAIL` / `ANTUMI_JIRA_TOKEN` 仅用于默认实例；保存的凭据仍由 Antumi 管理。卸载插件会保留这些数据。

旧版宿主仍内置 Jira，不能直接安装同来源插件；`engines.antumi` 只是版本范围，图片与推荐能力须使用包含此次迁移的宿主构建。

## SDK 与发布

`vendor/antumi-plugin-sdk-0.1.1.tgz` 是可独立安装的 SDK，包含图片传输支持；无需 Antumi 源码或其他本地仓库。设置字段只在 `manifest.json` 定义。更新 SDK 时同时更新依赖和锁文件。

## GitHub 分发

插件单独发布到本仓库的 GitHub Releases，Antumi 只保存推荐条目；点击安装时才下载最新正式 Release 的 ZIP。仓库中不提交 `dist/` 或 `node_modules/`。

普通提交和 PR 的 CI 只检查并上传构建产物。推送与 package.json、manifest.json 版本一致的 `vX.Y.Z` 标签后，Release 工作流先运行 `npm ci` 和完整检查，再创建 Release 并上传带版本号的 ZIP；带 `-` 的版本标为预发布，不会成为推荐安装使用的 Latest。已有 Release 不覆盖。

当前 Antumi 安装器读取公开 Release。仅创建仓库或提交源码还不能安装，Release 必须包含一个插件 ZIP。设置 → 插件可以检查更新、停用、卸载或切换到保留版本；凭据、筛选和导入任务由 Antumi 保留。
