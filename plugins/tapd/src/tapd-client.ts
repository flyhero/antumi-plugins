import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import TurndownService from 'turndown'
import {
  commentPage, commentState, MAX_ISSUE_TITLE_LENGTH, MAX_SNAPSHOT_LENGTH, SourceComment, SourceError,
  type SourceCommentOptions, type SourceCommentPage, type SourceCommentResult, type SourceIssue, type SourceIssueDetail, type SourceSettings,
  type SourceStatusResult, type SourceTransitions
} from '@antumi/plugin-sdk'
import { markdownToHtml } from './tapd-html.js'
import { category, priorityName, TASK_LAST_STEPS, TASK_STATUSES, typeName } from './tapd-status.js'
import { API, itemKey, itemUrl, WEB, type ItemKind } from './tapd-url.js'

const Text = z.union([z.string(), z.number()]).nullish().transform((value) => value == null ? '' : String(value))
// IDs are 19 digits, past what a JSON number keeps exact, so only strings are trusted.
const Id = z.string().regex(/^[1-9][0-9]{0,18}$/)
const Envelope = z.object({ status: z.coerce.number(), info: z.string().nullish(), data: z.unknown() })
const Meta = z.object({ meta: z.object({ request_id: z.string().regex(/^[A-Za-z0-9-]{1,64}$/) }) })
const Item = z.object({
  id: Id, name: Text, title: Text, status: Text, owner: Text, current_owner: Text, creator: Text, reporter: Text,
  priority: Text, priority_label: Text, created: Text, modified: Text, description: z.string().nullish(), workitem_type_id: Text
})
const Comment = z.object({ id: Id, description: Text, author: Text, created: Text, modified: Text })
const Attachment = z.object({ id: Id, filename: Text })
const User = z.object({ nick: z.string().min(1), name: Text })
const Workspace = z.object({ Workspace: z.object({ id: Text, name: Text, category: Text }) })
// PHP sends an empty map as [].
const Names = z.union([z.record(z.string(), z.string()), z.array(z.never()).transform(() => ({}))])
// A workflow's rule for one move between status keys; parallel workflows add steps this ignores.
const Step = z.object({ StepPrevious: Text, StepNext: Text })
// Documented bare; rows elsewhere come wrapped in their model's name, so either is read.
function step(row: unknown): z.infer<typeof Step> | null {
  const bare = Step.safeParse(row)
  if (bare.success && bare.data.StepNext) return bare.data
  const wrapped = z.record(z.string(), Step).safeParse(row)
  return wrapped.success ? Object.values(wrapped.data)[0] ?? null : null
}
const Posted = z.union([z.object({ Comment: z.object({ id: Id }) }).transform((value) => value.Comment.id), z.object({ id: Id }).transform((value) => value.id)])
const wrapper: Record<ItemKind, string> = { story: 'Story', bug: 'Bug', task: 'Task' }
const commentTypes: Record<ItemKind, readonly string[]> = { story: ['stories'], bug: ['bug', 'bug_remark'], task: ['tasks'] }
const paths: Record<ItemKind, string> = { story: '/stories', bug: '/bugs', task: '/tasks' }
const writeScope: Record<ItemKind, string> = { story: '编辑需求', bug: '编辑缺陷', task: '编辑任务' }
const RETRY = new Set([429, 500, 502, 503])
const DELAYS = [1000, 3000]
const MAX_BYTES = 5 * 1024 * 1024
const PAGE = 200

type Item = z.infer<typeof Item>
type Wait = (ms: number, signal: AbortSignal) => Promise<void>
type Space = { id: string, name: string, lightweight: boolean }
type Statuses = { names: Readonly<Record<string, string>>, lastSteps: ReadonlySet<string> | null }
type Moves = SourceTransitions & { statuses: Statuses }

const markdown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' })
markdown.remove(['script', 'style', 'iframe'])

// Pasted images and links in descriptions point at TAPD by path.
function toMarkdown(html: string): string {
  return markdown.turndown(html.replace(/(<(?:img|a)\b[^>]*?\b(?:src|href)=)(["'])\/(?!\/)/gi, `$1$2${WEB}/`)).trim()
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) throw new SourceError('request-failed', 'TAPD 返回了无法识别的数据')
  return result.data
}

// TAPD writes Beijing time without a zone.
export function time(value: string): number | null {
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})$/.exec(value.trim())
  const result = match && !match[1]?.startsWith('0000') ? Date.parse(`${match[1]}T${match[2]}+08:00`) : NaN
  return Number.isFinite(result) ? result : null
}

export function people(value: string): string[] {
  return value.split(/[;,]/).map((name) => name.trim()).filter(Boolean)
}

const owners = (kind: ItemKind, item: Item) => kind === 'bug' ? item.current_owner : item.owner

export class TapdClient {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly wait: Wait = async (ms, signal) => { await delay(ms, undefined, { signal }) }
  ) {}

  async user(signal: AbortSignal) {
    return parse(User, await this.get('/users/info', {}, signal))
  }

  async workspace(id: string, signal: AbortSignal): Promise<Space> {
    const data = parse(Workspace, await this.get('/workspaces/get_workspace_info', { workspace_id: id }, signal)).Workspace
    if (data.id !== id) throw new SourceError('not-found', '找不到这个 TAPD 项目，请检查项目 ID')
    return { id, name: data.name, lightweight: data.category === 'mini_project' }
  }

  async list(settings: SourceSettings, signal: AbortSignal): Promise<SourceIssue[]> {
    const kind = settings.kind === 'bug' || settings.kind === 'task' ? settings.kind : 'story'
    const owner = settings.assignee === '@me' ? (await this.user(signal)).nick : settings.assignee ?? ''
    const space = await this.workspace(settings.workspace ?? '', signal)
    const statuses = await this.statuses(space.id, kind, signal)
    const found = new Map<string, SourceIssue>()
    for (let page = 1; page <= 5 && found.size < 200; page++) {
      // The server matches people loosely, so the exact match happens here.
      const filter = owner ? { [kind === 'bug' ? 'current_owner' : 'owner']: owner } : {}
      const items = await this.items(kind, { workspace_id: space.id, limit: String(PAGE), page: String(page), order: 'modified desc', ...filter }, signal)
      for (const item of items) {
        if (owner && !people(owners(kind, item)).includes(owner)) continue
        const issue = this.summary(kind, item, space, statuses)
        if (settings.state !== 'all' && issue.statusCategory === 'done') continue
        found.set(issue.key, issue)
      }
      if (items.length < PAGE) break
    }
    return [...found.values()].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)).slice(0, 200)
  }

  async issue(workspace: string, kind: ItemKind, id: string, signal: AbortSignal): Promise<SourceIssueDetail> {
    const item = await this.item(workspace, kind, id, signal)
    const description = item.description ?? (await this.items(kind, { workspace_id: workspace, id, fields: 'id,description' }, signal))[0]?.description ?? ''
    const space = await this.workspace(workspace, signal)
    const issue = this.summary(kind, item, space, await this.statuses(workspace, kind, signal))
    // Comments and attachments are extras; the item itself is what was asked for.
    const comments = await this.comments(workspace, kind, id, issue.url, signal).catch((failure: unknown) => { if (signal.aborted) throw failure; return null })
    const files = await this.attachments(workspace, kind, id, signal).catch((failure: unknown) => { if (signal.aborted) throw failure; return null })
    const creator = kind === 'bug' ? item.reporter : item.creator
    const text = [
      `# ${issue.key} ${issue.title}`,
      [
        `类型：${issue.type}`, `状态：${issue.status}`, ...(issue.priority ? [`优先级：${issue.priority}`] : []),
        `处理人：${people(owners(kind, item)).join('、') || '无'}`, ...(creator ? [`创建人：${creator}`] : []),
        ...(item.created ? [`创建时间：${item.created}`] : []), ...(item.modified ? [`更新时间：${item.modified}`] : []),
        `项目：${space.name || space.id}`
      ].join('\n'),
      toMarkdown(description),
      ...(files === null ? ['## 附件', '附件未能获取。'] : files.length ? ['## 附件', files.map((file) => `- ${file}`).join('\n'), `在 TAPD 查看附件：${issue.url}`] : []),
      ...(comments === null ? ['## 评论', '评论未能获取。'] : comments.length ? ['## 最近评论', ...comments.slice(-20).map((comment) => `### ${comment.author} · ${new Date(comment.createdAt).toISOString()}\n\n${comment.markdown}`)] : [])
    ].filter(Boolean).join('\n\n')
    return { ...issue, markdown: text.slice(0, MAX_SNAPSHOT_LENGTH), ...(comments ? { commentState: commentState(comments) } : {}) }
  }

  async commentChanges(workspace: string, kind: ItemKind, id: string, signal: AbortSignal, options: SourceCommentOptions): Promise<SourceCommentPage> {
    const space = await this.workspace(workspace, signal)
    return commentPage(await this.comments(workspace, kind, id, itemUrl(workspace, kind, id, space.lightweight), signal), options)
  }

  async transitions(workspace: string, kind: ItemKind, id: string, signal: AbortSignal): Promise<SourceTransitions> {
    const { status, statusCategory, options } = await this.moves(workspace, kind, id, signal)
    return { status, statusCategory, options }
  }

  // The option's id is the target status key; it is checked against the workflow read just now.
  async transition(workspace: string, kind: ItemKind, id: string, target: string, signal: AbortSignal): Promise<SourceStatusResult> {
    const moves = await this.moves(workspace, kind, id, signal)
    if (!moves.options.some((option) => option.id === target)) throw new SourceError('request-failed', `这个${typeName[kind]}现在不能流转到所选状态，请刷新后重新选择`)
    const user = await this.user(signal)
    const data = await this.post(paths[kind], { workspace_id: workspace, id, status: target, current_user: user.nick }, writeScope[kind], signal)
    const row = Item.safeParse(z.record(z.string(), z.unknown()).safeParse(data).data?.[wrapper[kind]])
    const after = row.success && row.data.id === id && row.data.status ? row.data : await this.item(workspace, kind, id, signal)
    return this.status(after.status, moves.statuses)
  }

  // TAPD takes no client-supplied id, so writeId has nowhere to go and a resent comment would be a second one.
  async comment(workspace: string, kind: ItemKind, id: string, text: string, signal: AbortSignal): Promise<SourceCommentResult> {
    const description = markdownToHtml(text)
    if (!description) throw new SourceError('request-failed', '评论内容不能为空')
    await this.item(workspace, kind, id, signal)
    const space = await this.workspace(workspace, signal)
    const user = await this.user(signal)
    const data = await this.post('/comments', {
      workspace_id: workspace, entry_type: commentTypes[kind][0] ?? '', entry_id: id, author: user.nick, description
    }, '添加评论', signal)
    // The same id comment sync reads back, so Antumi knows the comment as its own.
    const posted = Posted.safeParse(data)
    if (!posted.success) throw new SourceError('request-failed', 'TAPD 没有返回新评论的编号，评论可能已经发出，请在 TAPD 上查看')
    return { id: posted.data, url: itemUrl(workspace, kind, id, space.lightweight) }
  }

  private async moves(workspace: string, kind: ItemKind, id: string, signal: AbortSignal): Promise<Moves> {
    const item = await this.item(workspace, kind, id, signal)
    const statuses = await this.statuses(workspace, kind, signal, item.workitem_type_id)
    let targets: string[] = Object.keys(TASK_STATUSES)
    if (kind !== 'task') {
      const query = { workspace_id: workspace, system: kind, ...(kind === 'story' && item.workitem_type_id ? { workitem_type_id: item.workitem_type_id } : {}) }
      const steps = parse(z.array(z.unknown()), await this.get('/workflows/all_transitions', query, signal)).map(step)
      targets = steps.filter((rule) => rule?.StepPrevious === item.status).map((rule) => rule?.StepNext ?? '')
    }
    const options = [...new Set(targets)]
      .filter((key) => key && key !== item.status && key.length <= 500)
      .slice(0, 100)
      .map((key) => {
        const { status, statusCategory } = this.status(key, statuses)
        return { id: key, name: status, category: statusCategory }
      })
    return { ...this.status(item.status, statuses), options, statuses }
  }

  private status(key: string, statuses: Statuses): SourceStatusResult {
    return { status: (statuses.names[key] || key || '未知').slice(0, 100), statusCategory: category(key, statuses.lastSteps) }
  }

  private summary(kind: ItemKind, item: Item, space: Space, statuses: Statuses): SourceIssue {
    const title = item.name || item.title || `${typeName[kind]} ${item.id}`
    return {
      key: itemKey({ kind, id: item.id }), title: title.slice(0, MAX_ISSUE_TITLE_LENGTH),
      url: itemUrl(space.id, kind, item.id, space.lightweight),
      ...this.status(item.status, statuses),
      type: typeName[kind], priority: priorityName(item.priority_label, item.priority), updatedAt: time(item.modified || item.created)
    }
  }

  private async item(workspace: string, kind: ItemKind, id: string, signal: AbortSignal): Promise<Item> {
    const item = (await this.items(kind, { workspace_id: workspace, id }, signal))[0]
    if (!item) throw new SourceError('not-found', `这个项目里找不到${typeName[kind]} ${id}`)
    if (item.id !== id) throw new SourceError('request-failed', 'TAPD 返回的事项编号不匹配')
    return item
  }

  private async items(kind: ItemKind, params: Record<string, string>, signal: AbortSignal): Promise<Item[]> {
    return parse(z.array(z.record(z.string(), z.unknown())), await this.get(paths[kind], params, signal)).map((row) => parse(Item, row[wrapper[kind]]))
  }

  // A story category can have its own workflow; without one, the project's statuses all together.
  private async statuses(workspace: string, kind: ItemKind, signal: AbortSignal, type = ''): Promise<Statuses> {
    if (kind === 'task') return { names: TASK_STATUSES, lastSteps: TASK_LAST_STEPS }
    const query = { workspace_id: workspace, system: kind, ...(kind === 'story' && type ? { workitem_type_id: type } : {}) }
    const names = parse(Names, await this.get('/workflows/status_map', query, signal))
    let lastSteps: Set<string> | null = null
    try {
      const data = await this.get('/workflows/last_steps', query, signal)
      const map = Names.safeParse(data)
      const list = z.array(z.string()).safeParse(data)
      lastSteps = map.success && Object.keys(map.data).length ? new Set(Object.keys(map.data)) : list.success && list.data.length ? new Set(list.data) : null
    } catch (failure) {
      // Without the project's final statuses, the built-in keys decide.
      if (signal.aborted) throw failure
    }
    return { names, lastSteps }
  }

  private async comments(workspace: string, kind: ItemKind, id: string, url: string, signal: AbortSignal): Promise<SourceComment[]> {
    const found = new Map<string, SourceComment>()
    for (const entryType of commentTypes[kind]) {
      for (let page = 1; page <= 5; page++) {
        const rows = parse(z.array(z.object({ Comment })), await this.get('/comments', {
          workspace_id: workspace, entry_type: entryType, entry_id: id, limit: String(PAGE), page: String(page), order: 'created asc'
        }, signal))
        for (const { Comment: row } of rows) {
          const createdAt = time(row.created)
          if (createdAt === null) continue
          const updatedAt = row.modified && row.modified !== row.created ? time(row.modified) : null
          const body = toMarkdown(row.description)
          const comment = SourceComment.safeParse({ id: row.id, author: row.author.slice(0, 500), createdAt, updatedAt, url, markdown: body.slice(0, 50_000), truncated: body.length > 50_000 })
          if (comment.success) found.set(row.id, comment.data)
        }
        if (rows.length < PAGE) break
      }
    }
    return [...found.values()].sort((a, b) => a.createdAt - b.createdAt)
  }

  private async attachments(workspace: string, kind: ItemKind, id: string, signal: AbortSignal): Promise<string[]> {
    const rows = parse(z.array(z.object({ Attachment })), await this.get('/attachments', { workspace_id: workspace, type: kind, entry_id: id, limit: String(PAGE) }, signal))
    return rows.map(({ Attachment: row }) => row.filename || row.id)
  }

  private get(path: string, params: Record<string, string>, signal: AbortSignal): Promise<unknown> {
    return this.request(path, params, null, signal)
  }

  // write names the project permission a refusal means the account lacks.
  private post(path: string, form: Record<string, string>, write: string, signal: AbortSignal): Promise<unknown> {
    return this.request(path, form, write, signal)
  }

  private async request(path: string, params: Record<string, string>, write: string | null, signal: AbortSignal): Promise<unknown> {
    const query = write === null && Object.keys(params).length ? `?${new URLSearchParams(params)}` : ''
    const url = `${API}${path}${query}`
    for (let attempt = 0; ; attempt++) {
      let response: Response
      try {
        response = await this.fetchImpl(url, {
          ...(write === null ? {} : { method: 'POST', body: new URLSearchParams(params) }),
          headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/json' }, redirect: 'error',
          signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)])
        })
      } catch { throw new SourceError('request-failed', '无法连接 TAPD，请检查网络') }
      // A write that met a server error may have landed, so only a rate limit is safe to send again.
      const retry = write === null ? RETRY.has(response.status) : response.status === 429
      if (retry && attempt < DELAYS.length) {
        await response.body?.cancel()
        await this.wait(DELAYS[attempt] ?? 0, signal)
        continue
      }
      // Failures come in the same envelope, its status repeating the HTTP one.
      const body = await this.json(response).catch((failure: unknown) => { if (response.ok) throw failure; return null })
      const envelope = response.ok ? parse(Envelope, body) : Envelope.safeParse(body).data
      if (response.ok && envelope?.status === 1) return envelope.data
      const info = (envelope?.info ?? '').split(this.token).join('***').slice(0, 200)
      const request = Meta.safeParse(body).data?.meta.request_id
      const detail = [info, request && `request_id ${request}`].filter(Boolean).join('，')
      const suffix = detail ? `（${detail}）` : ''
      // A bearer token TAPD does not accept is a 422, not a 401.
      if (response.status === 401 || (response.status === 422 && /access token/i.test(info))) throw new SourceError('auth-failed', 'TAPD 令牌无效或已失效，请重新登录')
      if (response.status === 403 || envelope?.status === 403) {
        throw new SourceError('forbidden', write === null
          ? `这个令牌没有权限访问该项目或接口${suffix}`
          : `这个令牌没有写入权限${suffix}。请确认账号在这个 TAPD 项目里有「${write}」权限，再用有写权限的个人访问令牌重新登录`)
      }
      if (response.status === 404) throw new SourceError('not-found', `TAPD 接口不存在${suffix}`)
      if (response.status === 429) throw new SourceError('request-failed', 'TAPD 接口限流（每分钟 60 次），请稍后再试')
      const failed = [response.ok ? '' : `HTTP ${response.status}`, detail].filter(Boolean).join('，')
      throw new SourceError('request-failed', `TAPD 未能完成请求${failed ? `（${failed}）` : ''}`)
    }
  }

  private async json(response: Response): Promise<unknown> {
    if (Number(response.headers.get('content-length')) > MAX_BYTES) {
      await response.body?.cancel()
      throw new SourceError('response-too-large', 'TAPD 返回内容过大')
    }
    const reader = response.body?.getReader()
    if (!reader) throw new SourceError('request-failed', 'TAPD 返回了空响应')
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > MAX_BYTES) { await reader.cancel(); throw new SourceError('response-too-large', 'TAPD 返回内容过大') }
        chunks.push(value)
      }
    } finally { reader.releaseLock() }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
    catch { throw new SourceError('request-failed', 'TAPD 没有返回 JSON') }
  }
}
