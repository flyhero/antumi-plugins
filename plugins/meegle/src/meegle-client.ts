import { z } from 'zod'
import { MAX_ISSUE_TITLE_LENGTH, MAX_SNAPSHOT_LENGTH, SourceError, type SourceCommentResult, type SourceIssue, type SourceIssueDetail, type SourceStatusResult, type SourceTransitionOption, type SourceTransitions } from '@antumi/plugin-sdk'
import { UnknownField, type McpSession } from './mcp-session.js'
import { buildMql, day, MqlPage, OPTIONAL_COLUMNS, rows, type MqlItem } from './meegle-mql.js'
import { itemUrl, type Space } from './meegle-url.js'
import { commentId, commentMarkdown, currentNodes, sameText, stateMoves } from './meegle-writeback.js'

export type ListOptions = { types: readonly string[], filter: string }

const PAGE_SIZE = 50
const MAX_ITEMS = 200
const MAX_DETAIL_PAGES = 10

const User = z.object({ user_key: z.string().optional(), name_cn: z.string().optional(), name_en: z.string().optional(), email: z.string().optional() }).passthrough()
const Types = z.object({ list: z.array(z.object({ type_key: z.string(), name: z.string().optional(), api_name: z.string().optional() }).passthrough()).nullish() }).passthrough()
const Named = z.object({ key: z.string().optional(), name: z.string().optional() }).passthrough()
const Brief = z.object({
  work_item_attribute: z.object({
    work_item_name: z.string().optional(),
    work_item_type: Named.extend({ api_name: z.string().optional() }).nullish(),
    owned_project: Named.extend({ simple_name: z.string().optional() }).nullish(),
    work_item_status: Named.nullish(),
    // `Node` or `State` where the server says; otherwise a flow is told by its current nodes.
    pattern: z.string().nullish(),
    create_time: z.string().nullish(),
    update_time: z.string().nullish(),
    is_aborted: z.boolean().nullish(),
    role_members: z.array(Named.extend({ members: z.array(z.unknown()).nullish() })).nullish()
  }).passthrough(),
  work_item_current_node: z.array(z.object({ name: z.string().optional(), owners: z.array(z.unknown()).nullish() }).passthrough()).nullish(),
  work_item_fields: z.array(z.object({ key: z.string(), name: z.string().optional(), value: z.unknown() }).passthrough()).nullish(),
  pagination: z.object({ has_more: z.boolean().optional(), next_page_token: z.string().nullish() }).passthrough().nullish()
}).passthrough()
type Brief = z.infer<typeof Brief>
const Comment = z.object({ id: z.union([z.string(), z.number()]).optional(), content: z.string().optional(), creator: z.unknown().optional(), created_at: z.union([z.string(), z.number()]).optional() }).passthrough()
const Comments = z.object({ comments: z.array(Comment).nullish(), list: z.array(Comment).nullish(), items: z.array(Comment).nullish() }).passthrough()

// Fields shown in their own lines, or whose values only make sense to Meegle's own pages.
const SHOWN = new Set(['name', 'description', 'priority', 'current_status_operator', 'work_item_status', 'owner', 'created_at', 'updated_at', 'template', 'work_item_type_key'])

function parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value)
  if (!result.success) throw new SourceError('request-failed', `飞书项目返回的${what}格式无法识别`)
  return result.data
}

// Renders a field value without knowing its type: users by name, options by label, lists joined.
export function plain(value: unknown, depth = 0): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (depth > 2) return ''
  if (Array.isArray(value)) return value.map((item) => plain(item, depth + 1)).filter(Boolean).join('、')
  if (typeof value === 'object') {
    const record = new Map(Object.entries(value))
    for (const key of ['label', 'name_cn', 'name', 'name_en', 'email', 'value', 'key', 'user_key']) {
      const text = plain(record.get(key), depth + 1)
      if (text) return text
    }
  }
  return ''
}

// A move this issue can make now, and the write tool that makes it.
type Move = { option: SourceTransitionOption, tool: string, args: Record<string, unknown> }

const WRITE_FORBIDDEN = '没有权限写入飞书项目：请在 MCP 配置页把数据权限改为同时勾选「允许创建或修改数据信息」，重新复制 Token 后重新登录；你在飞书项目里也要有修改这个工作项的权限'
const MAX_OPTIONS = 100

const clean = (markdown: string) => markdown.replace(/<!--[\s\S]*?-->/g, '').trim()
const time = (value: string | null | undefined) => { const parsed = value ? Date.parse(value) : NaN; return Number.isFinite(parsed) ? parsed : null }

// The status as list and fetch show it; Meegle's statuses carry no category, an aborted item is done.
function statusOf(brief: Brief): SourceStatusResult {
  const attribute = brief.work_item_attribute
  const status = attribute.work_item_status?.name || attribute.work_item_status?.key || '未知'
  return { status: status.slice(0, 100), statusCategory: attribute.is_aborted ? 'done' : 'unknown' }
}

// Write tools get the space's real key; the address's simple name is what reads were checked with.
const projectKey = (attribute: Brief['work_item_attribute'], space: Space) => attribute.owned_project?.key || space.simpleName

export class MeegleClient {
  constructor(private readonly mcp: McpSession) {}

  async user(signal: AbortSignal): Promise<string> {
    const user = await this.me(signal)
    return user.name_cn || user.name_en || user.email || user.user_key || '飞书项目用户'
  }

  private async me(signal: AbortSignal): Promise<z.infer<typeof User>> {
    const users = parse(z.array(User), await this.mcp.call('search_user_info', { user_keys: ['current_login_user()'] }, signal), '用户信息')
    const user = users[0]
    if (!user) throw new SourceError('auth-failed', '飞书项目没有返回当前用户')
    return user
  }

  async transitions(space: Space, id: string, signal: AbortSignal): Promise<SourceTransitions> {
    const { status, moves } = await this.moves(space, id, signal)
    return { ...status, options: moves.map((move) => move.option) }
  }

  // The id is checked against what the issue can do now, so a stale or foreign one moves nothing.
  async transition(space: Space, id: string, option: string, signal: AbortSignal): Promise<SourceStatusResult> {
    const { moves } = await this.moves(space, id, signal)
    const move = moves.find((candidate) => candidate.option.id === option)
    if (!move) throw new SourceError('request-failed', '这个工作项现在不能流转到所选的状态，请刷新后重新选择')
    await this.write(move.tool, move.args, signal)
    return statusOf(await this.brief(space, id, signal, false))
  }

  // Meegle has no client-side comment IDs, so writeId names the comment only when Meegle does not.
  async comment(space: Space, id: string, markdown: string, writeId: string, signal: AbortSignal): Promise<SourceCommentResult> {
    const content = commentMarkdown(markdown)
    if (!content) throw new SourceError('request-failed', '评论内容为空')
    const brief = await this.brief(space, id, signal, false)
    const attribute = brief.work_item_attribute
    const project = projectKey(attribute, space)
    const reply = await this.write('add_comment', { project_key: project, work_item_id: id, content }, signal)
    const found = commentId(reply) ?? await this.posted(project, id, content, signal)
    const type = attribute.work_item_type
    const url = itemUrl({ host: space.host, simpleName: attribute.owned_project?.simple_name || space.simpleName }, type?.api_name || type?.key || 'story', id)
    return { id: found ?? `antumi-${writeId}`, url }
  }

  private async write(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    try {
      return await this.mcp.call(name, args, signal, { write: true })
    } catch (failure) {
      if (failure instanceof SourceError && failure.code === 'forbidden') throw new SourceError('forbidden', `${WRITE_FORBIDDEN}。${failure.message}`)
      throw failure
    }
  }

  // State flows list their next states; node flows move by completing the nodes in progress.
  private async moves(space: Space, id: string, signal: AbortSignal): Promise<{ status: SourceStatusResult, moves: Move[] }> {
    const brief = await this.brief(space, id, signal, false)
    const attribute = brief.work_item_attribute
    const project = projectKey(attribute, space)
    const nodes = (brief.work_item_current_node ?? []).map((node) => node.name ?? '').filter(Boolean)
    const nodeFlow = attribute.pattern ? /node/i.test(attribute.pattern) : nodes.length > 0
    const moves = nodeFlow ? await this.nodeMoves(project, id, nodes, signal) : await this.stateMoves(project, id, attribute, signal)
    return { status: statusOf(brief), moves: moves.slice(0, MAX_OPTIONS) }
  }

  private async stateMoves(project: string, id: string, attribute: Brief['work_item_attribute'], signal: AbortSignal): Promise<Move[]> {
    const type = attribute.work_item_type?.key
    if (!type) throw new SourceError('request-failed', '飞书项目没有返回工作项类型')
    const user = (await this.me(signal)).user_key
    if (!user) throw new SourceError('request-failed', '飞书项目没有返回当前用户的 user_key')
    const reply = await this.mcp.call('get_transitable_states', { project_key: project, work_item_id: id, work_item_type: type, user_key: user }, signal)
    const current = attribute.work_item_status
    const seen = new Set<string>()
    return stateMoves(reply).filter((move) => !(current?.key && move.key === current.key) && move.name !== current?.name).flatMap((move) => {
      const option = `state:${move.transition}`
      if (seen.has(option) || option.length > 500) return []
      seen.add(option)
      return [{ option: { id: option, name: move.name.slice(0, 100), category: 'unknown' as const }, tool: 'transition_state', args: { project_key: project, work_item_id: id, transition_id: move.transition } }]
    })
  }

  private async nodeMoves(project: string, id: string, names: readonly string[], signal: AbortSignal): Promise<Move[]> {
    const reply = await this.mcp.call('get_node_detail', { project_key: project, work_item_id: id, node_id_list: [...names], need_sub_task: false, page_num: 1 }, signal)
    const seen = new Set<string>()
    return currentNodes(reply, names).flatMap((node) => {
      const option = `node:${node.node}`
      if (seen.has(option) || option.length > 500) return []
      seen.add(option)
      const name = node.name.slice(0, 90)
      return [{ option: { id: option, name: `「${name}」已完成`, action: `完成节点「${name}」`, category: 'unknown' as const }, tool: 'transition_node', args: { project_key: project, work_item_id: id, node_id: node.node, action: 'confirm' } }]
    })
  }

  // The comment just posted, found by its text among the latest when add_comment did not name it.
  private async posted(project: string, id: string, content: string, signal: AbortSignal): Promise<string | null> {
    try {
      const reply = parse(Comments, await this.mcp.call('list_workitem_comments', { project_key: project, work_item_id: id, page_num: 1 }, signal), '评论')
      const comments = reply.comments ?? reply.list ?? reply.items ?? []
      const matches = comments.filter((comment) => comment.id !== undefined && sameText(comment.content ?? '', content))
      const latest = matches.sort((a, b) => Number(b.created_at ?? 0) - Number(a.created_at ?? 0) || String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')))[0]
      return latest?.id === undefined ? null : String(latest.id)
    } catch (failure) {
      if (signal.aborted) throw failure
      return null
    }
  }

  async list(space: Space, options: ListOptions, signal: AbortSignal): Promise<SourceIssue[]> {
    const known = await this.types(space, signal)
    const found: SourceIssue[] = []
    for (const type of options.types) {
      const info = known.get(type)
      if (!info) throw new SourceError('invalid-settings', `空间里没有工作项类型「${type}」，可用的有：${[...known.keys()].join('、')}`)
      for (const item of await this.search(space, type, options.filter, signal)) {
        found.push({
          key: item.id, title: item.name.slice(0, MAX_ISSUE_TITLE_LENGTH), url: itemUrl(space, info.route, item.id),
          status: (item.status ?? '未知').slice(0, 100), statusCategory: 'unknown',
          type: info.name.slice(0, 100), priority: item.priority?.slice(0, 100) ?? null, updatedAt: day(item.updatedOn)
        })
      }
    }
    return found.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)).slice(0, MAX_ITEMS)
  }

  async issue(space: Space, id: string, signal: AbortSignal): Promise<SourceIssueDetail> {
    const brief = await this.brief(space, id, signal)
    const attribute = brief.work_item_attribute
    const fields = new Map((brief.work_item_fields ?? []).map((field) => [field.key, field]))
    const type = attribute.work_item_type
    const title = attribute.work_item_name || plain(fields.get('name')?.value) || `#${id}`
    const { status, statusCategory } = statusOf(brief)
    const priority = plain(fields.get('priority')?.value) || null
    const project = { host: space.host, simpleName: attribute.owned_project?.simple_name || space.simpleName }
    const issue: SourceIssue = {
      key: id, title: title.slice(0, MAX_ISSUE_TITLE_LENGTH), url: itemUrl(project, type?.api_name || type?.key || 'story', id),
      status, statusCategory,
      type: (type?.name || type?.key || '工作项').slice(0, 100), priority: priority?.slice(0, 100) ?? null,
      updatedAt: time(attribute.update_time)
    }
    const people = [
      ['当前负责人', plain(fields.get('current_status_operator')?.value)],
      ...(attribute.role_members ?? []).map((role) => [role.name || role.key || '角色', plain(role.members)])
    ].filter(([, names]) => names)
    const nodes = (brief.work_item_current_node ?? []).map((node) => node.name).filter(Boolean)
    const others = [...fields.values()].filter((field) => !SHOWN.has(field.key)).map((field) => [field.name || field.key, plain(field.value).slice(0, 500)]).filter(([, value]) => value)
    const description = clean(plain(fields.get('description')?.value))
    const text = [
      `# ${title}`,
      [`状态：${status}`, `类型：${issue.type}`, ...(priority ? [`优先级：${priority}`] : []), ...(nodes.length ? [`当前节点：${nodes.join('、')}`] : []),
        ...people.map(([role, names]) => `${role}：${names}`),
        ...(attribute.create_time ? [`创建时间：${attribute.create_time}`] : []), ...(attribute.update_time ? [`更新时间：${attribute.update_time}`] : [])].join('\n'),
      '## 描述', description || '（无）',
      ...(others.length ? ['## 字段', others.map(([name, value]) => `- ${name}：${value}`).join('\n')] : []),
      await this.comments(project, id, signal)
    ].join('\n\n')
    return { ...issue, markdown: text.slice(0, MAX_SNAPSHOT_LENGTH) }
  }

  private async types(space: Space, signal: AbortSignal): Promise<Map<string, { name: string, route: string }>> {
    const types = parse(Types, await this.mcp.call('list_workitem_types', { project_key: space.simpleName }, signal), '工作项类型')
    return new Map((types.list ?? []).map((type) => [type.type_key, { name: type.name || type.type_key, route: type.api_name || type.type_key }]))
  }

  // A space may lack an optional column; it is dropped and the query run again without it.
  private async search(space: Space, type: string, filter: string, signal: AbortSignal): Promise<MqlItem[]> {
    let optional = OPTIONAL_COLUMNS
    for (;;) {
      try {
        return await this.query(space, buildMql(space.simpleName, type, filter, optional), signal)
      } catch (failure) {
        const missing = failure instanceof UnknownField ? failure.field : undefined
        if (!missing || !optional.includes(missing)) throw failure
        optional = optional.filter((column) => column !== missing)
      }
    }
  }

  private async query(space: Space, mql: string, signal: AbortSignal): Promise<MqlItem[]> {
    const first = parse(MqlPage, await this.mcp.call('search_by_mql', { project_key: space.simpleName, mql }, signal), '查询结果')
    const items = rows(first)
    const group = first.list?.[0]
    const count = group?.count ?? items.length
    const pages = Math.min(Math.ceil(count / PAGE_SIZE), MAX_ITEMS / PAGE_SIZE)
    for (let page = 2; page <= pages && first.session_id; page++) {
      const next = rows(parse(MqlPage, await this.mcp.call('search_by_mql', {
        project_key: space.simpleName, session_id: first.session_id,
        group_pagination_list: [{ group_id: group?.group_infos?.[0]?.group_id ?? '1', page_num: page }]
      }, signal), '查询结果'))
      if (!next.length) break
      items.push(...next)
    }
    return items
  }

  // all false: the first page, enough for the attributes a write needs.
  private async brief(space: Space, id: string, signal: AbortSignal, all = true): Promise<Brief> {
    let merged: Brief | undefined
    let token: string | undefined
    const seen = new Set<string>()
    for (let page = 0; page < MAX_DETAIL_PAGES; page++) {
      const args = { project_key: space.simpleName, work_item_id: id, fields: ['_all'], page_size: 200, ...(token ? { page_token: token } : {}) }
      const brief = parse(Brief, await this.mcp.call('get_workitem_brief', args, signal), '工作项详情')
      merged = merged ? { ...merged, work_item_fields: [...(merged.work_item_fields ?? []), ...(brief.work_item_fields ?? [])] } : brief
      token = brief.pagination?.next_page_token ?? undefined
      if (!all || !brief.pagination?.has_more || !token) return merged
      if (seen.has(token)) throw new SourceError('request-failed', '飞书项目的详情分页重复')
      seen.add(token)
    }
    if (!merged) throw new SourceError('request-failed', '飞书项目没有返回工作项详情')
    return merged
  }

  // Comments add to the snapshot but never decide it: a failure leaves a note instead.
  private async comments(space: Space, id: string, signal: AbortSignal): Promise<string> {
    try {
      const reply = parse(Comments, await this.mcp.call('list_workitem_comments', { project_key: space.simpleName, work_item_id: id, page_num: 1 }, signal), '评论')
      const comments = reply.comments ?? reply.list ?? reply.items ?? []
      if (!comments.length) return ''
      return ['## 最近评论', ...comments.slice(0, 20).map((comment) => `### ${plain(comment.creator) || '未知用户'} · ${comment.created_at ?? ''}\n\n${clean(comment.content ?? '')}`)].join('\n\n')
    } catch (failure) {
      if (signal.aborted) throw failure
      return '## 最近评论\n\n（评论未能获取）'
    }
  }
}
