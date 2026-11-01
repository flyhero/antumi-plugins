# Antumi Jira 插件

独立维护的 Antumi 任务来源插件，插件 ID `antumi.jira`，来源 ID `jira`。

支持 Jira Cloud 邮箱 + API token 登录、JQL 同步、工作项正文、最近评论、ADF 富文本转换及图片附件。带权限范围的 token 会使用 Atlassian API 网关；附件始终从用户配置的站点下载，不跟随重定向。单图最多 10 MiB，最多 20 张、合计 50 MiB。

## 开发与安装

需要 Node 22.13+（测试工具使用 Node 22、24 或 26）。

```sh
# 在仓库根目录安装
npm ci
npm run check --workspace antumi-plugin-jira
```

生成 `dist/plugin/` 和 `dist/antumi-plugin-jira-1.0.0.zip`。在支持推荐插件和来源图片的新版 Antumi 中，进入「设置 → 插件」选择 ZIP 安装，或直接安装推荐列表里的 Jira。旧版 Jira 的站点、JQL、登录凭据和已导入任务会保留；用户主动安装插件后继续使用，不会在启动时自动下载或安装。

登录和筛选条件在「设置 → 集成 → Jira」设置。环境变量 `ANTUMI_JIRA_EMAIL` / `ANTUMI_JIRA_TOKEN` 仅用于默认实例；保存的凭据仍由 Antumi 管理。卸载插件会保留这些数据。

旧版宿主仍内置 Jira，不能直接安装同来源插件；`engines.antumi` 只是版本范围，图片与推荐能力须使用包含此次迁移的宿主构建。

## SDK 与发布

`../../vendor/antumi-plugin-sdk-0.1.1.tgz` 是可独立安装的 SDK，包含图片传输支持；无需 Antumi 源码或其他本地仓库。设置字段只在 `manifest.json` 定义。更新 SDK 时同时更新依赖和锁文件。

## GitHub 分发

在 [flyhero/antumi-plugins](https://github.com/flyhero/antumi-plugins) 中独立发布，标签格式为 `jira-vX.Y.Z`。构建产物仍是 `dist/antumi-plugin-jira-X.Y.Z.zip`，插件 ID、来源 ID、凭据和配置格式不变。

构建、发布与历史导入说明见 [仓库说明](../../README.md)。旧版 Antumi 可在安装时指定 Release 标签及 ZIP 文件；新版宿主支持按插件标签前缀检查更新。
