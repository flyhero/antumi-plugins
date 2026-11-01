# Antumi 禅道插件

独立的 Antumi 任务来源插件，使用 Antumi Plugin SDK。当前对接 **禅道 RESTful API v1**，支持任务、Bug、需求的列表同步和原文拉取。可配置多个来源实例，分别连接不同站点、执行或产品。

## 在 Antumi 使用

在「设置 → 插件」安装 `dist/antumi-plugin-zentao-0.1.0.zip`，或安装 `dist/plugin` 目录。在「设置 → 集成 → 禅道」填写：

| 设置 | 内容 |
| --- | --- |
| REST API 地址 | 完整地址，例如 `https://example.com/zentao/api.php/v1`，保留部署子目录 |
| 事项类型 | 任务 / Bug / 需求 |
| 执行 / 产品 ID | 任务填执行 ID；Bug 和需求填产品 ID |
| 指派给 | 默认 `@me`，也可填禅道账号；留空表示所有人 |
| 状态范围 | 默认未完成，可改为全部 |

登录时填写该站点的 REST API Token，插件调用 `/user` 验证后才保存。Token 过期需要重新登录；修改 API 地址后会自动退出登录。也可用 `ANTUMI_ZENTAO_TOKEN` 配置凭据。

事项使用 `task-123`、`bug-123`、`story-123` 三种编号，避免不同类型的数字 ID 冲突。原文中的 HTML 描述转换为 Markdown，保留需求验收标准；详情接口返回 actions 时提取其中最近 20 条评论，未返回时不额外抓取网页评论。

每次最多导入收件箱 200 项，分页最多扫描 2000 项；大范围且匹配过少时会报错提醒缩小范围。当前只读，不修改禅道事项；不支持 API v2、自动续期或附件下载。网页链接按禅道标准 GET 路由构造，使用定制路由的部署需验证跳转。

## 独立开发

要求 Node >=22.13。SDK 已放在 `vendor/antumi-plugin-sdk-0.1.0.tgz`，不依赖 Antumi 源码或私有 workspace 包：

```sh
npm ci
npm run check
```

`check` 执行类型检查、带模拟 API 的单元测试和构建，得到 `dist/plugin/` 以及 `dist/antumi-plugin-zentao-0.1.0.zip`。ZIP 已打包全部运行时依赖。SDK 正式发布到 npm 后可替换 file 依赖并更新锁文件。

API 地址字段带 `bindsCredential: true`；禁止跟随 HTTP 重定向，防止 Token 被发到其他站点。stdout 专供 SDK 使用，日志写 stderr；不记录 Token 或完整敏感响应。

## GitHub 分发

插件单独发布到本仓库的 GitHub Releases，Antumi 只保存推荐条目；点击安装时才下载最新正式 Release 的 ZIP。仓库中不提交 `dist/` 或 `node_modules/`。

普通提交和 PR 的 CI 只检查并上传构建产物。推送与 package.json、manifest.json 版本一致的 `vX.Y.Z` 标签后，Release 工作流先运行 `npm ci` 和完整检查，再创建 Release 并上传带版本号的 ZIP；带 `-` 的版本标为预发布，不会成为推荐安装使用的 Latest。已有 Release 不覆盖。

当前 Antumi 安装器读取公开 Release。仅创建仓库或提交源码还不能安装，Release 必须包含一个插件 ZIP。设置 → 插件可以检查更新、停用、卸载或切换到保留版本；凭据、筛选和导入任务由 Antumi 保留。

## API 依据

- [我的个人信息](https://www.zentao.net/book/api/665.html)
- [执行任务列表](https://www.zentao.net/book/api/715.html)
- [任务详情](https://www.zentao.net/book/api/717.html)
- [产品 Bug 列表](https://www.zentao.net/book/api/720.html)
- [Bug 详情](https://www.zentao.net/book/api/722.html)
- [产品需求列表](https://www.zentao.net/book/api/691.html)
- [需求详情](https://www.zentao.net/book/api/695.html)
