# Antumi Linear 插件

独立的 Antumi 任务来源插件，使用 Antumi Plugin SDK。支持个人 API Key 登录、团队 / 项目 / 指派人筛选、未完成事项同步、按 `ENG-123` 导入，以及描述和最多 20 条最近评论的 Markdown 快照。

## 在 Antumi 使用

在「设置 → 插件」安装 `dist/antumi-plugin-linear-0.1.0.zip`，或安装 `dist/plugin` 目录。在「设置 → 集成 → Linear」配置筛选条件并登录。

- 创建具有 **Read** 权限的个人 API Key，可以限制为特定团队。
- 团队填写短标识（例如 `ENG`），项目填写 UUID；都可以留空。
- 指派给默认为 `@me`；可以填邮箱或留空同步所有人。
- 默认同步未完成事项，每次最多 200 项；不包含已归档事项。
- 使用 `ENG-123` 格式导入或重新拉取。

也可通过 `ANTUMI_LINEAR_TOKEN` 配置凭据。Token 由 Antumi 单独保存，不写入筛选设置或原文快照。当前版本只读取 Linear，不修改远端事项；当前插件不下载附件。

## 独立开发

要求 Node >=22.13。仓库包含打包好的 SDK（`vendor/antumi-plugin-sdk-0.1.0.tgz`），无需克隆 Antumi，无需等待 SDK 的 npm 首次发布：

```sh
npm ci
npm run check
```

`check` 执行类型检查、带模拟 API 的单元测试和构建。生成：

```text
dist/plugin/manifest.json
dist/plugin/main.mjs
dist/antumi-plugin-linear-0.1.0.zip
```

ZIP 内已包含 SDK 和运行时依赖，安装时不需要 Node 或 npm。SDK 正式发布到 npm 后，可把 file 依赖改为发布版本并更新 package-lock.json；构建产物格式不变。

`manifest.json` 是设置字段的唯一来源；API 调用在 `src/linear-client.ts`，登录与设置校验在 `src/linear-source.ts`。日志只能写 stderr，不记录 Token。网络请求必须传递 AbortSignal。

## GitHub 分发

插件单独发布到本仓库的 GitHub Releases，Antumi 只保存推荐条目；点击安装时才下载最新正式 Release 的 ZIP。仓库中不提交 `dist/` 或 `node_modules/`。

普通提交和 PR 的 CI 只检查并上传构建产物。推送与 package.json、manifest.json 版本一致的 `vX.Y.Z` 标签后，Release 工作流先运行 `npm ci` 和完整检查，再创建 Release 并上传带版本号的 ZIP；带 `-` 的版本标为预发布，不会成为推荐安装使用的 Latest。已有 Release 不覆盖。

当前 Antumi 安装器读取公开 Release。仅创建仓库或提交源码还不能安装，Release 必须包含一个插件 ZIP。设置 → 插件可以检查更新、停用、卸载或切换到保留版本；凭据、筛选和导入任务由 Antumi 保留。

## API 依据

- [Linear GraphQL 与个人 API Key](https://linear.app/developers/graphql)
- [筛选](https://linear.app/developers/filtering)
- [分页](https://linear.app/developers/pagination)
- [官方 GraphQL Schema](https://github.com/linear/linear/blob/master/packages/sdk/src/schema.graphql)
