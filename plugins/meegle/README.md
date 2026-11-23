# Antumi 飞书项目 / Meegle 插件

独立的 Antumi 任务来源插件，使用 Antumi Plugin SDK。通过飞书项目（国内版）或 Meegle（Lark 国际版）的官方 MCP 服务，把一个空间里的工作项同步进收件箱，并拉取详情。只读，不修改工作项。设计说明见 [DESIGN.md](DESIGN.md)。

> 0.1.0 按公开资料和第三方的实测记录编写，还没有用真实空间联调，待确认的项见 DESIGN.md 第 9 节。

## 在 Antumi 使用

在「设置 → 插件」安装 ZIP 或 `dist/plugin` 目录，然后在「设置 → 集成 → 飞书项目 / Meegle」填写：

| 设置 | 内容 |
| --- | --- |
| 空间地址 | 在空间里打开任意页面，复制地址。按域名区分飞书项目（`project.feishu.cn`）和 Meegle（`project.larksuite.com`、`meegle.com`） |
| 工作项类型 | 类型 key，逗号分隔，默认 `story,issue`；填错时同步会列出空间里的类型 |
| 筛选条件（MQL） | 只写 WHERE 后面的条件，用字段 key 书写；默认是我参与的工作项 |

登录只需要一个 MCP Token：在空间所在站点的 `/b/mcp` 配置页，打开个人偏好里的 MCP 开关，数据权限只勾「允许查看数据信息」，复制 `m-` 开头的 Token。不需要在开发者后台建插件。Token 长期有效，在配置页重置即失效。也可以用 `ANTUMI_MEEGLE_TOKEN` 配置。

工作项编号就是工作项 ID；手动导入时可以填 ID、`#ID` 或详情页地址。每次最多导入 200 项，每个类型最多扫描 200 项。详情包含状态、优先级、当前节点、各角色成员、描述、其余字段和最近 20 条评论；图片保留为链接，不下载。

想让工作项在开发确认后自动进 Antumi：筛选条件写 ``array_contains(`current_status_operator`, current_login_user())``（当前负责人是我），再在 Antumi 里打开「新问题自动排查」。

## 独立开发

```sh
# 在仓库根目录
npm ci
npm run check --workspace antumi-plugin-meegle
```

请求只发往三个官方域名，不跟随重定向；Token 只发给登录时验证过的站点，不出现在错误和日志里。stdout 专供 SDK 使用。
