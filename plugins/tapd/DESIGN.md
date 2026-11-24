# 腾讯 TAPD 任务来源插件：开发设计

来源：[flyhero/antumi#13](https://github.com/flyhero/antumi/issues/13)。提问人用 tapd.cn 云端，能在「我的设置 → 个人访问令牌」创建令牌，并已用它连通官方 TAPD MCP（2026-11-24 在 issue 里确认）。他希望把需求、缺陷和任务同步进 Antumi，让 Agent 读取上下文排查或开发。

## 1. 目标与范围

**做**：把一个 TAPD 项目里的需求、缺陷或任务同步进收件箱，导入成任务，拉取详情（标题、状态、优先级、处理人、描述、评论、附件清单），保留原始链接。评论增量同步（`commentSync: 1`）。配合 Antumi 已有的「新问题自动排查」，事项一指派给自己就自动开排查会话。

**不做（v1）**：
- 写回 TAPD：0.1.0 不做。0.2.0 起按 SDK 0.5.0 的来源回写协议支持流转状态（`GET /workflows/all_transitions` 取当前状态的下一步，`POST /stories|bugs|tasks` 写 `status`）和发评论（`POST /comments`，Markdown 转 HTML），见 README「回写」。
- 公司 API 账号（Basic）和开放平台应用 OAuth：前者要公司管理员在企业版里开通，后者 token 2 小时过期，而 `list`、`fetch` 交不回新凭据。
- 私有部署和腾讯内网版（`tapd.woa.com`、`apiv2.tapd.tencent.com`）：只接受 `api.tapd.cn`，Token 不会被发到任意地址。有人提出再加。
- 下载附件和图片：v1 在快照里列出附件名和返回 TAPD 查看的链接，图片随第二期的 `image` 一起做（见第 9 节）。

主仓库不用改。插件放在 `flyhero/antumi-plugins` 的 `plugins/tapd`。发版后，主仓库在 `plugins-recommended.json` 加一条推荐，`CHANGELOG.md` 和 `docs/PLUGINS.md` 各加一行。

## 2. 方案选择

| 方式 | 结论 |
|---|---|
| 公司 API 账号（`api_user:api_password`，HTTP Basic） | 不用。管理员在「公司管理 → 开放集成 → API 账号管理」申请，属企业版商业化模块，普通成员拿不到 |
| 开放平台应用 OAuth（`/tokens/request_token`） | 不用。要注册应用，token 7200 秒过期，要刷新 |
| **个人访问令牌**（`Authorization: Bearer`） | **采用**。任何成员在「我的设置 → 个人访问令牌」自建，只显示一次。官方 `mcp-server-tapd` 和 `go-tapd/tapd` 都用它调 `api.tapd.cn`；提问人已实测可用 |

## 3. 已确认的事实

依据有四类：
- **实测**：2026-11-24 从本机发的请求，只有无效令牌和不带令牌两种。
- **官方文档**：open.tapd.cn 的 API 文档（下称 OD）。
- **官方实现**：PyPI 上的 `mcp-server-tapd` 8.0.84（`mcp_server_tapd/tapd.py`、`server.py`，下称 MCP）。
- **第三方 SDK**：`github.com/go-tapd/tapd`（下称 SDK），含真实响应的测试数据。

尚未用真实账号调过，见第 9 节。

### 3.1 地址与鉴权

- 接口 `https://api.tapd.cn`，网页 `https://www.tapd.cn`（OD；MCP 的 `TAPD_API_BASE_URL` / `TAPD_BASE_URL`）。
- 请求头 `Authorization: Bearer <个人访问令牌>`（MCP `tapd.py`；SDK `client.go` 的 `authTypePAT`）。
- 令牌的有效期和权限范围官方没写。
- 鉴权失败（实测）：
  - Bearer 令牌无效：**HTTP 422**，`{"status":422,"data":"","info":"The access token provided is invalid","meta":{"request_id":"…"}}`。不是 401，按 401 处理的话登录时输错令牌不会让人重输。
  - 不带令牌，或 Basic 账号不对：HTTP 401，`info` 是 `401 Unauthorized`。
  - 不存在的接口：HTTP 404。
- 限流：默认每分钟 60 次，429 的文案是 `max request rates is 6000req/10min`；并发过高或响应过大时可能返回 500、502（OD `API错误码`）。

### 3.2 响应格式

- 统一信封：`{status: 1, info: "success", data}`，`status` 不为 1 即失败（OD `使用必读`）。失败时 `status` 等于 HTTP 状态码，另有 `meta.request_id`（实测）。
- 列表的每一项再包一层：`[{"Story":{…}}]`、`{"Bug":…}`、`{"Task":…}`、`{"Comment":…}`、`{"Attachment":…}`。

### 3.3 接口

| 接口 | 用途 | 参数 | 说明 |
|---|---|---|---|
| `GET /users/info` | 登录校验，取当前用户的 `nick` | 无 | 返回 `{id, nick, name, …}`。OD 说只认用户态 OAuth token，MCP 实际拿个人令牌调用 |
| `GET /workspaces/get_workspace_info` | 校验项目、取项目名，判断是否轻量项目 | `workspace_id` | `data.Workspace`，`category: "mini_project"` 是轻量项目 |
| `GET /stories`、`/bugs`、`/tasks` | 同步和拉取详情 | `workspace_id`（必填）、`fields`、`limit`（最大 200）、`page`、`order`；`id` 取单条 | 不点名 `description` 就不返回它 |
| `GET /workflows/status_map` | 状态 key 转中文名 | `workspace_id`、`system=story\|bug` | `data: {"planning": "规划中", …}` |
| `GET /workflows/last_steps` | 工作流的结束状态，用于判断「已完成」 | `workspace_id`、`system` | **待确认**是否存在、返回格式 |
| `GET /comments` | 评论 | `workspace_id`、`entry_type=stories\|bug\|tasks`、`entry_id`、`limit`、`page`、`order` | `{"Comment": {id, description, author, created, modified}}` |
| `GET /attachments` | 附件清单 | `workspace_id`、`type`、`entry_id` | `{"Attachment": {id, filename, …}}` |

查询写法（OD `使用必读`）：
- 时间用 `<`、`>`、`~`，如 `modified=>2026-01-01 00:00:00`。
- 多个 ID 逗号分隔；`status` 支持枚举 `a|b` 和不等于 `<>`。
- 人员字段是模糊匹配。
- `page × limit` 最多 20000。

### 3.4 字段

- `id`：19 位数字字符串，例如 `1010104801124922063`。它由前缀、`workspace_id` 和补零到 9 位的短编号拼成；界面上看到的是去掉前导 0 的短编号。前缀规则有分歧（MCP 在 `api.tapd.cn` 上用 `11`，OD 示例是 `10`），所以**只用接口返回的长 ID，不自己拼**。
- 标题：需求和任务是 `name`，缺陷是 `title`。
- `description`：HTML。
- `status`：工作流 key，如 `planning`、`developing`、`new`、`resolved`，自定义工作流里可能是 `status_1` 之类。任务只有 `open`、`progressing`、`done`。
- 处理人：需求和任务用 `owner`，格式是分号结尾的昵称串，如 `张三;李四;`；缺陷用 `current_owner`。
- 优先级：优先用 `priority_label`（High、Middle、Low、Nice To Have），没有时用 `priority`，缺陷的 `priority` 是 `high`、`medium` 等。
- 时间：`modified`、`created` 是 `YYYY-MM-DD HH:MM:SS`，按北京时间解析。

### 3.5 网页链接（MCP `server.py`）

- 需求：`https://www.tapd.cn/{ws}/prong/stories/view/{id}`；轻量项目是 `https://www.tapd.cn/tapd_fe/t/index/{ws}?workitemId={id}`
- 任务：`https://www.tapd.cn/{ws}/prong/tasks/view/{id}`
- 缺陷：`https://www.tapd.cn/{ws}/bugtrace/bugs/view/{id}`

## 4. 设置

照禅道插件的写法，同一个来源实例只同步一种事项，要多种就建多个实例：

| key | 类型 | 说明 |
|---|---|---|
| `workspace` | text | 项目 ID。也接受项目里任意页面的地址，取出路径里的项目 ID；保存时归一成纯数字 |
| `kind` | select | `story` 需求（默认）、`bug` 缺陷、`task` 任务 |
| `assignee` | text | 默认 `@me`（处理人是我）；留空表示所有人；也可填 TAPD 昵称 |
| `state` | select | `active` 未完成（默认）、`all` 全部 |

## 5. 登录

- 只问一次令牌，提示写清路径：「我的设置 → 个人访问令牌」，令牌只显示一次。
- 调 `/users/info` 校验，账号显示为 `name (nick)`。401 或 `status` 不为 1 时提示「令牌无效或已失效」，最多重输 3 次，同禅道。
- 环境变量 `ANTUMI_TAPD_TOKEN`。
- 项目权限在第一次同步时由 `get_workspace_info` 校验，403 提示「这个令牌看不到该项目」。

## 6. 同步（`list`）

1. `@me` 时先调 `/users/info` 取 `nick`。
2. 按 `modified desc` 拉列表，每页 200 条，最多 5 页。不传 `fields`：三种事项的字段名不同，点名一个不存在的字段会怎样没有记录；不点名时 `description` 本来就不返回，响应不会太大。
3. 处理人过滤：服务端先按 `owner`/`current_owner` 粗筛（模糊匹配），客户端再把字段按 `;` 拆开，精确比对昵称。
4. 状态：
   - 显示名：需求和缺陷用 `status_map`，任务用固定的「未开始 / 进行中 / 已完成」；同一次同步内缓存。
   - `statusCategory`：在 `last_steps` 里的是 `done`；没有这个接口时，按常见 key 归类（`closed`、`done`、`resolved`、`rejected`、`suspended` 等归 `done`，`developing`、`progressing`、`in_progress`、`testing` 等归 `doing`，`planning`、`new`、`open`、`reopened` 等归 `todo`），其余是 `unknown`。
   - `state=active` 时去掉 `done`。
5. 结果按 `updatedAt` 倒序，最多 200 条。

返回的 `SourceIssue`：

| 字段 | 取值 |
|---|---|
| `key` | `story-<长ID>`、`bug-<长ID>`、`task-<长ID>` |
| `title` | `name` 或 `title` |
| `status` | 中文状态名，没有映射时用 key |
| `type` | 需求 / 缺陷 / 任务 |
| `priority` | `priority_label`，没有时用 `priority`，空则 `null` |
| `updatedAt` | `modified` 的毫秒数 |
| `url` | 按 3.5 节的格式拼 |

想让事项指派给自己后自动进 Antumi：处理人保持 `@me`，在 Antumi 里打开「新问题自动排查」。事项流转到开发、处理人变成自己后，下一轮同步就会进入结果。

一次同步大约需要 3 + 页数次请求（用户、项目、状态映射、列表），在 60 次/分钟的限流内。

## 7. 拉取（`fetch`）和评论

- `normalizeKey` 接受：`story-<长ID>` 这种编号；需求、缺陷、任务详情页的地址（含轻量项目的 `workitemId`），从中取出类型和 ID。
- 拉取：列表接口加 `id=<长ID>`；没带回 `description` 时，再用 `fields=id,description` 取一次。再调 `/comments`（按 `created asc`，每页 200 条，最多 5 页）和 `/attachments`。评论或附件失败不影响正文，在快照里注明。
- 缺陷的评论在 `entry_type=bug` 还是 `bug_remark` 下没有定论，两种都查，按评论 ID 合并。
- 快照（Markdown，最多 50,000 字符）：
  - 标题行
  - 状态、类型、优先级、处理人、创建人、迭代、创建和更新时间
  - 描述（HTML 转 Markdown，图片保留成链接）
  - 附件清单：文件名，加一句「在 TAPD 查看」的原始链接
  - 最近评论（作者、时间、正文）
- 评论同步：评论 `id` 稳定，`fetch` 返回 `commentState` 作为基线，`comments` 用 SDK 的 `commentPage` 分页补拉。评论的 `url` 用事项链接。

## 8. 客户端细节与安全

- 只请求 `https://api.tapd.cn`，不跟随重定向。每次请求超时 15 秒，响应最多 5 MiB，同禅道。
- 所有请求串行发送。遇到 429、500、502、503 时退避重试，最多 2 次（1 秒、3 秒）；重试后仍是 429，提示「TAPD 接口限流，请稍后再试」。
- 错误映射：401，以及 `info` 提到 access token 的 422，都是 `auth-failed`；403 是 `forbidden`；404 是 `not-found`；其余是 `request-failed`。
- 错误信息带上信封里的 `info`（其中的令牌替换成 `***`，最多 200 字符）和 `request_id`，方便向 TAPD 报障；不带完整的响应正文。
- 文件划分：
  - `tapd-client.ts`：请求、信封、各个接口
  - `tapd-status.ts`：状态映射和归类
  - `tapd-url.ts`：项目地址解析、事项地址解析、链接拼接
  - `tapd-source.ts`：插件接口

## 9. 还需要真实账号确认的

确认方法：在一次性的 `ANTUMI_HOME` 里装上插件，用真实令牌同步和拉取一次（参照 Jira 插件的做法）。

| 项 | 现在的假设 | 确认不了时的退路 |
|---|---|---|
| 个人令牌调 `/users/info` | 能用（MCP 这么用，提问人用 MCP 正常） | `@me` 改成让用户填昵称 |
| `/workflows/last_steps` | 存在，返回结束状态的 key | 只按常见 key 归类 |
| 自定义工作流的状态 key | `status_N` 这种形式，`status_map` 能覆盖 | 显示原始 key，归为 `unknown`，`state=active` 时保留 |
| `owner` 服务端过滤 | 模糊匹配，客户端再精确比对 | 不传给服务端，全部在客户端过滤（页数会变多） |
| 缺陷评论的 `entry_type` | `bug`、`bug_remark` 都查 | 只留有数据的那个，省一次请求 |
| 拉列表不传 `fields` 时 `description` 是否返回 | 不返回，详情时单独取 | 已兼容两种情况 |
| 个人令牌的有效期 | 长期有效，或到期时间由用户自选 | 过期时提示重新登录（无效令牌返回 422 已实测） |
| 附件下载 `/attachments/down` 和 `/files/get_image` | 返回 300 秒有效的下载地址，地址在 TAPD 自己的域名 | 第二期再定；v1 只列清单 |
| 轻量项目的列表和链接 | 接口相同，链接用 `tapd_fe` 格式 | 仍用 `prong` 链接 |

**我们自己需要一个 TAPD 账号**来联调，免费版即可。

## 10. 测试与交付

- 单元测试用模拟的 `fetch`：
  - 信封解析，`status` 不为 1、401、403、429 重试
  - 三种事项的字段差异（`name`/`title`、`owner`/`current_owner`）
  - 处理人精确比对，状态映射和归类
  - 地址解析和链接拼接，含轻量项目
  - 评论分页和 `commentState`
  - 令牌不出现在任何错误里
- 示例数据按 SDK 测试数据的结构编写，联调后换成脱敏的真实响应。
- 交付顺序：
  1. 插件 0.1.0（这份设计的范围）
  2. 真实账号联调，修正第 9 节的各项
  3. 打 `tapd-v0.1.0` 标签发布
  4. 主仓库加推荐条目、CHANGELOG 和 PLUGINS.md
  5. 第二期：附件图片（`image`）；回写评论和流转状态要先扩 SDK
