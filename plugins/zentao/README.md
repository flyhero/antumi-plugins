# Antumi 禅道插件

独立的 Antumi 任务来源插件，使用 Antumi Plugin SDK。当前对接 **禅道 RESTful API v1**，支持任务、Bug、需求的列表同步和原文拉取，也可以把状态写回禅道。可配置多个来源实例，分别连接不同站点、执行或产品。

## 在 Antumi 使用

在「设置 → 插件」安装 `dist/antumi-plugin-zentao-0.3.0.zip`，或安装 `dist/plugin` 目录。在「设置 → 集成 → 禅道」填写：

| 设置 | 内容 |
| --- | --- |
| REST API 地址 | 完整地址，例如 `https://example.com/zentao/api.php/v1`，保留部署子目录 |
| 事项类型 | 任务 / Bug / 需求 |
| 执行 / 产品 ID | 任务填执行 ID；Bug 和需求填产品 ID |
| 指派给 | 默认 `@me`，也可填禅道账号；留空表示所有人 |
| 状态范围 | 默认未完成，可改为全部 |

登录时填写该站点的 REST API Token，插件调用 `/user` 验证后才保存。Token 过期需要重新登录；修改 API 地址后会自动退出登录。也可用 `ANTUMI_ZENTAO_TOKEN` 配置凭据。

事项使用 `task-123`、`bug-123`、`story-123` 三种编号，避免不同类型的数字 ID 冲突；状态按禅道中文界面的名称显示（如「进行中」「已解决」）。原文中的 HTML 描述转换为 Markdown，保留需求验收标准；详情接口返回 actions 时提取其中最近 20 条评论，未返回时不额外抓取网页评论。

每次最多导入收件箱 200 项，分页最多扫描 2000 项；大范围且匹配过少时会报错提醒缩小范围。同步任务时，「指派给」为 @me 或自己的账号会让禅道只返回指派给自己的任务（含多人任务），状态范围为「未完成」时只返回未完成的任务，几万条任务的执行也能秒回；留空且选「全部」才需要逐页扫描。不支持 API v2、自动续期或附件下载。网页链接按禅道标准 GET 路由构造，使用定制路由的部署需验证跳转。

## 回写

需要支持来源回写的 Antumi。在任务的来源区块里可以**改状态**：禅道按动作流转，插件列出事项当前状态允许的动作，以目标状态命名，规则里写状态名或动作名都可以。

| 类型 | 可用动作 |
| --- | --- |
| 任务 | 开始、暂停、继续、完成、关闭、激活（父任务只能暂停、继续、关闭） |
| Bug | 解决（解决方案「已解决」，解决版本「主干」）、关闭、激活 |
| 需求 | 关闭（关闭原因「已完成」）、激活 |

「设置 → 集成 → 禅道 → 回写」只能从上表的动作里选：开始执行时开始或继续任务；提交验收时完成任务、解决 Bug；验收通过时还可以选关闭。一个规则写了几种事项的状态名，按事项类型取能用的那个。

**不能写评论**：RESTful API v1 没有发表评论的接口，所以插件只回写状态，Antumi 里不出现「写评论」，规则里的总结评论也会跳过。

写入以登录 Token 所属账号的身份进行，账号要在禅道权限分组里有对应动作的权限（如「任务 → 开始、完成」「Bug → 解决、关闭」）。只读账号的 Token 照常同步，写入时报「没有权限」并写明缺哪一项，开通后或换有权限的账号重新登录即可。

限制：不替你填工时。完成任务只报本次消耗 0，从没记过工时的任务会被禅道拒绝，需到禅道里完成；开始、继续、激活沿用任务的预计剩余（没有就用最初预计），两者都为 0 时不操作。取消任务没有 v1 接口，不提供。多人任务等禅道额外校验的情况以禅道的提示为准。

## 独立开发

要求 Node >=22.13。SDK 已放在 `../../vendor/antumi-plugin-sdk-0.5.0.tgz`，不依赖 Antumi 源码或私有 workspace 包：

```sh
# 在仓库根目录安装
npm ci
npm run check --workspace antumi-plugin-zentao
```

`check` 执行类型检查、带模拟 API 的单元测试和构建，得到 `dist/plugin/` 以及 `dist/antumi-plugin-zentao-0.3.0.zip`。ZIP 已打包全部运行时依赖。SDK 正式发布到 npm 后可替换 file 依赖并更新锁文件。

API 地址字段带 `bindsCredential: true`；禁止跟随 HTTP 重定向，防止 Token 被发到其他站点。stdout 专供 SDK 使用，日志写 stderr；不记录 Token 或完整敏感响应。

## GitHub 分发

在 [flyhero/antumi-plugins](https://github.com/flyhero/antumi-plugins) 中独立发布，标签格式为 `zentao-vX.Y.Z`。构建产物仍是 `dist/antumi-plugin-zentao-X.Y.Z.zip`，插件 ID、来源 ID、凭据和配置格式不变。

构建、发布与历史导入说明见 [仓库说明](../../README.md)。旧版 Antumi 可在安装时指定 Release 标签及 ZIP 文件；新版宿主支持按插件标签前缀检查更新。

## API 依据

- [我的个人信息](https://www.zentao.net/book/api/665.html)
- [执行任务列表](https://www.zentao.net/book/api/715.html)
- [任务详情](https://www.zentao.net/book/api/717.html)
- [产品 Bug 列表](https://www.zentao.net/book/api/720.html)
- [Bug 详情](https://www.zentao.net/book/api/722.html)
- [产品需求列表](https://www.zentao.net/book/api/691.html)
- [需求详情](https://www.zentao.net/book/api/695.html)
- [开始任务](https://www.zentao.net/book/api/967.html)、[暂停任务](https://www.zentao.net/book/api/968.html)、[继续任务](https://www.zentao.net/book/api/969.html)、[完成任务](https://www.zentao.net/book/api/970.html)、[关闭任务](https://www.zentao.net/book/api/1200.html)
- [解决 Bug](https://www.zentao.net/book/api/1181.html)、[关闭 Bug](https://www.zentao.net/book/api/1121.html)、[激活 Bug](https://www.zentao.net/book/api/1142.html)
- [关闭需求](https://www.zentao.net/book/api/1060.html)；激活任务（`/tasks/{id}/active`）和激活需求（`/stories/{id}/active`）文档未列出，路由见禅道源码 `config/apiv1.php`
