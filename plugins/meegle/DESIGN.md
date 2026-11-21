# 飞书项目（Meegle）任务来源插件：开发设计

来源：[flyhero/antumi#11](https://github.com/flyhero/antumi/issues/11)。提问人用 Lark 国际版（`project.larksuite.com`），只有工作空间，不能在开发者后台建插件。他希望的流程是：需求在 Meegle 里提出和流转，开发确认后自动进 Antumi。

## 1. 目标与范围

**做**：把一个 Meegle 空间里的工作项同步进 Antumi 的收件箱，导入成任务，拉取详情（标题、状态、优先级、负责人、描述、最近评论）。配合 Antumi 已有的「新问题自动排查」，工作项一进入查询结果，就自动开排查会话。

**不做（v1）**：
- 写回 Meegle：不流转节点，不改字段，不发评论。
- 评论增量同步（`commentSync`）和图片下载：等真实空间确认返回格式后再做（见第 9 节）。
- 私有部署的自定义域名：只接受三个官方域名，Token 不会被发到任意地址。
- Lark 文档、知识库、多维表格：它们走 Lark 开放平台，和 Meegle 是两套体系。他自己用的智能体可以配 Lark 官方的 `@larksuiteoapi/lark-mcp`；群里 @ 的机器人要读这些内容，得在 core 加工具并设计好按提问人的权限限制，另开 issue 讨论。

主仓库不用改。插件放在 `flyhero/antumi-plugins` 的 `plugins/meegle`。发版后，主仓库在 `plugins-recommended.json` 加一条推荐，`CHANGELOG.md` 加一行。

## 2. 方案选择

| 方式 | 结论 |
|---|---|
| OpenAPI 加插件凭证（`plugin_token` + `X-USER-KEY`） | 不用。要在开发者后台建插件，并由空间管理员安装，提问人做不到 |
| OAuth 设备码（动态注册客户端，meegle-cli 的做法） | 不用。token 会过期，要刷新，可能还会轮换 refresh_token；而插件的 `list`、`fetch` 交不回新凭据，要改协议 |
| **个人 MCP Token**（`X-Mcp-Token`） | **采用**。用户在 MCP 配置页自己复制，页面写明「长期有效」，可以重置。另外两个第三方项目（yinian、workbench）都用它连过真实空间 |

数据走 Meegle 官方的 MCP 服务 `https://<站点>/mcp_server/v1`（JSON-RPC），不走 `/open_api`，因为 MCP Token 只能用在这里。

## 3. 已确认的事实

依据有三类：
- **实测**：2026-11-21 我从本机发的请求。
- **他人实测**：第三方仓库里记录的真实调用，主要是 `lihuabeass-art/feishu-project-mcp-workbench`（下称 WB）和 `jonahcui/orca-meegle-plugin`（下称 ORCA）。
- **官方文档**：`larksuite/meegle-cli` 的 `skills/meegle/references/*.md`。

### 3.1 站点与鉴权

- **三个站点的 MCP 都在用**（实测）：`project.feishu.cn`、`project.larksuite.com`、`meegle.com` 的 `/mcp_server/v1`，用无效 Token 调 `initialize` 都返回 401。
  - `meegle.com` 的 OAuth issuer 就是 `project.larksuite.com`，所以这两个是同一套服务。
  - 飞书和 Meegle 的账号体系是分开的，Token 不能混用（yinian）。
- **请求头**：`X-Mcp-Token: m-…`。不能用 `Authorization: Bearer`，否则会被当成 OAuth 会话（yinian、WB）。
- **MCP 配置页**：`/b/mcp`。
  - 页面上可以选数据范围（「允许查看数据信息」「允许创建或修改数据信息」），可以复制 Token、重置 Token（WB 实测页面文案）。
  - 个人偏好里有个 MCP 总开关，关着的时候 Token 是对的也会被拒，报 `MCPPersonalPreferenceDisabled`（yinian）。
  - Lark 版没登录时访问 `project.larksuite.com/b/mcp`，会跳到 meegle.com 官网（实测），登录后的页面地址还要确认。
- **有效期**：页面写「长期有效」，没有具体时长。重置 Token 是唯一的撤销方式。

### 3.2 MCP 会话

- 握手（WB 实测）：
  1. 发 `initialize`，服务端在响应头里给 `Mcp-Session-Id`，协议版本回 `2025-03-26`，服务名 `Meego MCP Server`，共 48 个工具。
  2. 发 `notifications/initialized`。
  3. 之后每个请求都带上 `Mcp-Session-Id`。
- `Accept` 要写 `application/json, text/event-stream`。回复可能是普通 JSON，也可能是 SSE，取最后一个 `data:` 行。
- **工具结果**：`result.content[0].text` 是 JSON 字符串；另有一段文本是 `log_id: …`（旧版是 `logid:`），可能是单独一段，也可能接在前一段后面。没有 `structuredContent`。
- **工具失败**：`result.isError: true`，文本格式是 `error=<Code>,message=<…>,retriable=<bool>`。message 里可能有逗号，所以 `retriable` 要取最后一个。
- **会话过期**：带着 session id 的请求返回 404，就重新握手一次（WB）。
- **限流**：没有公开的 QPS。观察到的情况有：服务过载时返回 `error_code=1606 … retriable=true`；评论接口大约 5 QPS；`get_workitem_brief` 4 路并发没问题。

### 3.3 工具

| 工具 | 用途 | 参数 | 返回 |
|---|---|---|---|
| `search_user_info` | 登录时校验 Token | `{user_keys:["current_login_user()"]}` | `[{user_key, name_cn, name_en, email, …}]`（实测） |
| `list_workitem_types` | 类型 key 对应的名称和链接路径段 | `{project_key}` | `{list:[{type_key, name, api_name, …}]}`（实测） |
| `search_by_mql` | 同步列表 | 第一页 `{project_key, mql}`，后续页 `{project_key, session_id, group_pagination_list:[{group_id, page_num}]}`，后续页不带 `mql` | 见下（实测） |
| `get_workitem_brief` | 拉取详情 | `{project_key, work_item_id, fields:["_all"], page_size:200}`，翻页加 `page_token`；`page_size` 必须是数字 | 见下（实测结构） |
| `list_workitem_comments` | 最近评论 | `{project_key, work_item_id, page_num}`，每页 20 条 | 字段名未确认（见第 9 节） |

**MQL**（官方文档；WB、ORCA 实测）：
- 写法：``SELECT `f1`,`f2` FROM `<空间>`.`<类型 key>` [WHERE …] [ORDER BY `updated_at` DESC] [LIMIT n]``。
- 优先用 key，名称是用户自定义的，语言不固定。官方明确说「必须优先 key」。用 key 的查询在 meegle.com（ORCA）和 project.feishu.cn（WB）上都实测过。
- 每页最多 50 条，`LIMIT` 只截断不翻页。总数只在第一页的 `list[0].count` 里；分组查询不分组时只有一组，`group_id` 是 `"1"`。
- 结果为空时返回 `{list:null, data:{}}`。
- 每行是 `data["1"][i].moql_field_list[]`，每个字段形如 `{key, value_type, value:{<value_type>: …}}`，`value_type` 有：
  - `long_value`：`work_item_id`
  - `string_value`：`name`、日期
  - `key_label_value`：`priority` → `{key, label}`
  - `key_label_value_list`：`work_item_status` → `[{key, label}]`
  - `user_value_list`：人员字段
- `updated_at` 只返回 `YYYY-MM-DD`，精确到天。
- 字符串里的单引号写成两个 `''`，不能用 `\'`。
- 已终止的工作项默认不返回，要加 `features:{FindAborted:"true"}` 才有。
- 验证过的人员条件：
  - `array_contains(all_participate_persons(), current_login_user())`：我参与的。
  - ``array_contains(`current_status_operator`, current_login_user())``：当前负责人是我。
  - `` `owner` = current_login_user() ``：我创建的（`owner` 是创建者，不是负责人）。

**`get_workitem_brief` 返回**：`{work_item_attribute, work_item_current_node, work_item_fields:[{key, name, value}], pagination:{has_more, next_page_token}}`。
- 每一页都会重复 `work_item_attribute`，`work_item_fields` 要逐页拼起来。
- `work_item_attribute` 里有：
  - `work_item_name`
  - `work_item_type{key, name, api_name}`
  - `owned_project{key, name, simple_name}`
  - `work_item_status{key, name}`
  - `create_time`、`update_time`：ISO 时间，带时区
  - `role_members`
- `description` 是 Markdown，图片写成 `![名称](url)<!--file_token-->`。
- 不返回评论。

### 3.4 空间与链接

- `simple_name` 是网址里紧跟域名的那一段，和 `project_key` 不是一回事。
- 工具的 `project_key` 参数和 MQL 的 `FROM` 都接受 simple_name（yinian 在 feishu 上实测）。详情会在 `owned_project` 里返回真正的 `key` 和 `simple_name`。
- **工作项链接**：`https://<站点>/<simple_name>/<api_name>/detail/<work_item_id>`。`story` 和 `issue` 的 `api_name` 就是它们的 key，自定义类型要用 `list_workitem_types` 查到的 `api_name`。
- **空间地址的格式**：`/<simple_name>/overview`，或 `/<simple_name>` 后面跟视图、详情等路径。第一段如果是 `b`、`workbench`、`setting`、`meego` 之类的保留词，就不是空间。

## 4. 设置

| 键 | 类型 | 说明 |
|---|---|---|
| `space` | url | 粘贴空间里任意页面的地址。域名决定站点：飞书项目是 `project.feishu.cn`，Meegle 是 `project.larksuite.com` 或 `meegle.com`；其他域名直接拒绝。保存为 `https://<域名>/<simple_name>`，带 `bindsCredential`，改了要重新登录 |
| `types` | text | 类型 key，用逗号分隔，默认 `story,issue`，最多 10 个 |
| `filter` | textarea | 筛选条件（MQL），只写 `WHERE` 后面的部分，和 Jira 插件的 JQL 一样由用户决定范围。默认 ``array_contains(all_participate_persons(), current_login_user()) AND `archiving_status` = false``（我参与的、未归档）。说明文字给出「当前负责人是我」「我创建的」的写法。不能包含 `SELECT`、`FROM`、`ORDER BY`、`LIMIT` 和分号：MQL 一次只能查一种类型，列和排序要由插件固定，收件箱条目才能生成 |

飞书项目和 Meegle 是同一个产品的国内版和国际版，接口相同，账号和服务器分开，所以不另设「站点」选项，从空间地址的域名判断。`www.meegle.com` 视同 `meegle.com`；路径开头的 `/meego` 前缀会被去掉。

`normalizeSettings` 只做格式校验和地址解析，不联网。空间或类型填错，同步时才会报 `invalid-settings`，错误信息会说明是哪一项。

## 5. 登录

1. 只问一个问题：MCP Token（`secret`）。
   - 提示里写：先打开个人偏好里的 MCP 开关，数据范围只勾「允许查看数据信息」，然后复制 Token。
   - `link` 指向空间所在站点的 `/b/mcp`。
2. 调 `search_user_info`，校验通过后保存凭据 `{kind:'token', payload:{token, host}}`，账号名显示 `name_cn || name_en || email`。`host` 记下 Token 是在哪个站点验证的；之后的请求发现空间的域名和它不一致就拒绝，要求重新登录。
3. 出错时：
   - 401：Token 无效或已被重置，让用户重新输入，最多 3 次。
   - `MCPPersonalPreferenceDisabled`：说明要去打开 MCP 开关，并给出配置页地址。
4. 支持环境变量 `ANTUMI_MEEGLE_TOKEN`。环境变量给的 Token 不带 `host`，发往空间所在的站点。

## 6. 同步（`list`）

1. 握手，然后调 `list_workitem_types` 拿到 `type_key → {name, api_name}`。设置里有不认识的类型就报 `invalid-settings`。
2. 每个类型发一条 MQL：

   ```
   SELECT `work_item_id`,`name`,`work_item_status`,`priority`,`updated_at`,`archiving_status`
   FROM `<simple_name>`.`<type_key>`
   WHERE <筛选条件>
   ORDER BY `updated_at` DESC
   ```

   每个类型最多翻 4 页（200 条），所有类型合并后按更新时间排序，取前 200 条。超出时在错误信息里提示收窄范围。
3. 每条映射成 `SourceIssue`：

   | 字段 | 取值 |
   |---|---|
   | `key` | `work_item_id`（全局唯一，详情只需要它） |
   | `title` | `name` |
   | `status` | `work_item_status` 的 label |
   | `statusCategory` | 已归档或已终止为 `done`，其余为 `unknown`（状态是空间自定义的，没有通用的「进行中」标记；这个字段只影响颜色） |
   | `type` | 类型的显示名 |
   | `priority` | label |
   | `updatedAt` | 那一天 0 点的毫秒数（精确到天） |
   | `url` | 按 3.4 节的格式拼 |

4. 「开发确认后自动进 Antumi」的做法：筛选条件写 ``array_contains(`current_status_operator`, current_login_user())``（当前负责人是我）。工作项在 Meegle 里流转到开发节点、负责人变成他之后，下一轮同步就会出现在结果里，「新问题自动排查」会给它开会话。这一步不需要在插件里写状态名。

`archiving_status` 有分歧：官方文档写的是 `archiving_date IS NULL`，WB 实测用的是布尔值 `archiving_status = false`。实现时先用后者，联调时两种都试（见第 9 节）。

## 7. 拉取（`fetch`）

- `normalizeKey` 接受三种输入：纯数字 ID、工作项详情页链接（从中取出 ID）、`#123`。
- 调 `get_workitem_brief` 翻完所有字段页，再调 `list_workitem_comments` 取第一页（最近 20 条）。评论失败不影响正文，在快照末尾注明「评论未能获取」。
- 快照（Markdown，最多 50,000 字符）：
  - 标题行
  - 状态、类型、优先级、当前节点、负责人（`current_status_operator` 和各角色成员）
  - 创建和更新时间
  - 描述原文（去掉 `<!--file_token-->`，图片保留成链接）
  - 其余非空字段列成「字段名：值」，每项最多 500 字符
  - 最近评论（去掉 mention 注释，只留 `@名字`）
- `updatedAt` 用 `update_time`，精确到秒。

## 8. 客户端细节与安全

- 请求只发往三个官方域名，禁止跟随重定向；Token 只发给它验证过的那个站点。
- 每次请求超时 15 秒，响应最多 5 MiB。只读工具遇到 `retriable=true`、429 或 1606 时退避重试，最多 2 次（1 秒、3 秒）。
- 所有请求串行发送。同步一次大约要 1（握手）+ 1（类型）+ 类型数 × 页数 次调用，远低于观察到的限流。
- 错误信息带上 `log_id`，方便向飞书报障。错误信息和日志里不出现 Token（出现时替换成 `***`），也不带完整的响应正文。
- 文件划分：
  - `mcp-session.ts`：握手、请求帧、SSE 解析、错误解析
  - `meegle-mql.ts`：拼 MQL、转义、解析返回的行
  - `meegle-client.ts`：各个工具
  - `meegle-source.ts`：插件接口
  - `meegle-url.ts`：空间地址解析、站点白名单和链接拼接

## 9. 还需要真实账号确认的

这些问题在现有资料里要么没有记录，要么有分歧，只能真实调用才能确认。确认方法是：在一次性的 `ANTUMI_HOME` 里装上插件，用真实 Token 同步和拉取一次（参照 Jira 插件的做法）。

| 项 | 现在的假设 | 确认不了时的退路 |
|---|---|---|
| Lark 版登录后的 MCP 配置页地址 | 空间域名加 `/b/mcp` | 提示里改成「在 Meegle 里打开 设置 → MCP」 |
| 在 `project.larksuite.com` 上用 `X-Mcp-Token` 调 MQL | 和 feishu 一样 | 无，这是发版的前提 |
| MQL 的 `FROM` 用 simple_name | 能用（feishu 实测过） | 先调 `search_project_info` 换成 `project_key` |
| 判断未归档 | `archiving_status = false` | `archiving_date IS NULL` |
| `priority` 在详情里的格式 | `{label}`，也兼容 `{name}` 和字符串 | 原样转成文本 |
| `list_workitem_comments` 返回的字段名 | `comments` 或 `list`，每条有 `content`、`creator`、`created_at` | 解析失败就跳过评论 |
| 英文界面下的 `work_item_status` 和 `priority` | 返回英文 label，查询里只用 key，不受影响 | 无需退路 |

**我们自己需要一个能登录飞书项目或 Meegle 的账号**来做联调。提问人不参与测试。

## 10. 测试与交付

- 单元测试用模拟的 MCP 服务：
  - 握手和 session、SSE 和普通 JSON 两种回复、`isError` 的解析
  - 401 和 MCP 开关未开两种错误
  - MQL 翻页和转义、类型映射、空间地址解析、链接拼接
  - 详情翻页和快照内容、Token 不出现在任何错误里
- 示例数据按 3.3 节的结构编写，联调后换成脱敏的真实响应。
- 交付顺序：
  1. 插件 0.1.0（这份设计的范围）
  2. 真实账号联调，修正第 9 节的各项
  3. 打 `meegle-v0.1.0` 标签发布
  4. 主仓库加推荐条目和 CHANGELOG
  5. 第二期：评论同步和图片
