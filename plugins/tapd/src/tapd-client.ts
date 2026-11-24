import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import TurndownService from 'turndown'
import {
  commentPage, commentState, MAX_ISSUE_TITLE_LENGTH, MAX_SNAPSHOT_LENGTH, SourceComment, SourceError,
  type SourceCommentOptions, type SourceCommentPage, type SourceIssue, type SourceIssueDetail, type SourceSettings
} from '@antumi/plugin-sdk'
import { category, priorityName, TASK_LAST_STEPS, TASK_STATUSES, typeName } from './tapd-status.js'
import { API, itemKey, itemUrl, parseWorkspaces, WEB, type ItemKind } from './tapd-url.js'

const Text = z.union([z.string(), z.number()]).nullish().transform((value) => value == null ? '' : String(value))
// IDs are 19 digits, past what a JSON number keeps exact, so only strings are trusted.
const Id = z.string().regex(/^[1-9][0-9]{0,18}$/)
const Envelope = z.object({ status: z.coerce.number(), info: z.string().nullish(), data: z.unknown() })
const Meta = z.object({ meta: z.object({ request_id: z.string().regex(/^[A-Za-z0-9-]{1,64}$/) }) })
const Item = z.object({
  id: Id, name: Text, title: Text, status: Text, owner: Text, current_owner: Text, creator: Text, reporter: Text,
  priority: Text, priority_label: Text, created: Text, modified: Text, description: z.string().nullish()
})
const Comment = z.object({ id: Id, description: Text, author: Text, created: Text, modified: Text })
const Attachment = z.object({ id: Id, filename: Text })
const User = z.object({ nick: z.string().min(1), name: Text })
const Workspace = z.object({ Workspace: z.object({ id: Text, name: Text, category: Text }) })
// PHP sends an empty map as [].
const Names = z.union([z.record(z.string(), z.string()), z.array(z.never()).transform(() => ({}))])
const wrapper: Record<ItemKind, string> = { story: 'Story', bug: 'Bug', task: 'Task' }
const commentTypes: Record<ItemKind, readonly string[]> = { story: ['stories'], bug: ['bug', 'bug_remark'], task: ['tasks'] }
const RETRY = new Set([429, 500, 502, 503])
const DELAYS = [1000, 3000]
const MAX_BYTES = 5 * 1024 * 1024
const PAGE = 200

type Item = z.infer<typeof Item>
type Wait = (ms: number, signal: AbortSignal) => Promise<void>
type Space = { id: string, name: string, lightweight: boolean }

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
    const workspaces = parseWorkspaces(settings.workspace ?? '')
    const owner = settings.assignee === '@me' ? (await this.user(signal)).nick : settings.assignee ?? ''
    const found = new Map<string, SourceIssue>()
    for (const workspace of workspaces) {
      for (const issue of await this.inProject(workspace, () => this.listProject(workspace, kind, owner, settings.state === 'all', workspaces.length > 1, signal))) found.set(issue.key, issue)
    }
    return [...found.values()].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)).slice(0, 200)
  }

  private async listProject(workspace: string, kind: ItemKind, owner: string, all: boolean, labelProject: boolean, signal: AbortSignal): Promise<SourceIssue[]> {
    const space = await this.workspace(workspace, signal)
    const statuses = await this.statuses(space.id, kind, signal)
    const found: SourceIssue[] = []
    for (let page = 1; page <= 5 && found.length < 200; page++) {
      // The server matches people loosely, so the exact match happens here.
      const filter = owner ? { [kind === 'bug' ? 'current_owner' : 'owner']: owner } : {}
      const items = await this.items(kind, { workspace_id: space.id, limit: String(PAGE), page: String(page), order: 'modified desc', ...filter }, signal)
      for (const item of items) {
        if (owner && !people(owners(kind, item)).includes(owner)) continue
        const issue = this.summary(kind, item, space, statuses, labelProject)
        if (!all && issue.statusCategory === 'done') continue
        found.push(issue)
      }
      if (items.length < PAGE) break
    }
    return found
  }

  // With several projects, a failure says which one; a bad token is the same for all.
  private async inProject<T>(workspace: string, run: () => Promise<T>): Promise<T> {
    try { return await run() } catch (failure) {
      if (!(failure instanceof SourceError) || failure.code === 'auth-failed') throw failure
      throw new SourceError(failure.code, `项目 ${workspace}：${failure.message}`)
    }
  }

  // Candidates come from workspaceCandidates: an item is looked for in each until one has it.
  async issue(candidates: readonly string[], kind: ItemKind, id: string, signal: AbortSignal, labelProject = false): Promise<SourceIssueDetail> {
    let found: { workspace: string, item: Item } | undefined
    let missing: unknown = new SourceError('not-found', `找不到${typeName[kind]} ${id}`)
    for (const workspace of candidates) {
      try { found = { workspace, item: await this.item(workspace, kind, id, signal) }; break } catch (failure) {
        if (!(failure instanceof SourceError) || (failure.code !== 'not-found' && failure.code !== 'forbidden')) throw failure
        missing = failure
      }
    }
    if (!found) throw missing
    const { workspace, item } = found
    const description = item.description ?? (await this.items(kind, { workspace_id: workspace, id, fields: 'id,description' }, signal))[0]?.description ?? ''
    const space = await this.workspace(workspace, signal)
    const issue = this.summary(kind, item, space, await this.statuses(workspace, kind, signal), labelProject)
    // Comments and attachments are extras; the item itself is what was asked for.
    const comments = await this.comments(workspace, kind, id, issue.url, signal).catch((failure: unknown) => { if (signal.aborted) throw failure; return null })
    const files = await this.attachments(workspace, kind, id, signal).catch((failure: unknown) => { if (signal.aborted) throw failure; return null })
    const creator = kind === 'bug' ? item.reporter : item.creator
    const text = [
      `# ${issue.key} ${issue.title}`,
      [
        `类型：${typeName[kind]}`, `状态：${issue.status}`, ...(issue.priority ? [`优先级：${issue.priority}`] : []),
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

  private summary(kind: ItemKind, item: Item, space: Space, statuses: { names: Readonly<Record<string, string>>, lastSteps: ReadonlySet<string> | null }, labelProject: boolean): SourceIssue {
    const title = item.name || item.title || `${typeName[kind]} ${item.id}`
    return {
      key: itemKey({ kind, id: item.id }), title: title.slice(0, MAX_ISSUE_TITLE_LENGTH),
      url: itemUrl(space.id, kind, item.id, space.lightweight),
      status: (statuses.names[item.status] || item.status || '未知').slice(0, 100), statusCategory: category(item.status, statuses.lastSteps),
      type: (labelProject ? `${typeName[kind]} · ${space.name || space.id}` : typeName[kind]).slice(0, 100), priority: priorityName(item.priority_label, item.priority), updatedAt: time(item.modified || item.created)
    }
  }

  private async item(workspace: string, kind: ItemKind, id: string, signal: AbortSignal): Promise<Item> {
    const item = (await this.items(kind, { workspace_id: workspace, id }, signal))[0]
    if (!item) throw new SourceError('not-found', `这个项目里找不到${typeName[kind]} ${id}`)
    if (item.id !== id) throw new SourceError('request-failed', 'TAPD 返回的事项编号不匹配')
    return item
  }

  private async items(kind: ItemKind, params: Record<string, string>, signal: AbortSignal): Promise<Item[]> {
    const path = kind === 'story' ? '/stories' : kind === 'bug' ? '/bugs' : '/tasks'
    return parse(z.array(z.record(z.string(), z.unknown())), await this.get(path, params, signal)).map((row) => parse(Item, row[wrapper[kind]]))
  }

  private async statuses(workspace: string, kind: ItemKind, signal: AbortSignal) {
    if (kind === 'task') return { names: TASK_STATUSES, lastSteps: TASK_LAST_STEPS }
    const names = parse(Names, await this.get('/workflows/status_map', { workspace_id: workspace, system: kind }, signal))
    let lastSteps: Set<string> | null = null
    try {
      const data = await this.get('/workflows/last_steps', { workspace_id: workspace, system: kind }, signal)
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

  private async get(path: string, params: Record<string, string>, signal: AbortSignal): Promise<unknown> {
    const url = `${API}${path}${Object.keys(params).length ? `?${new URLSearchParams(params)}` : ''}`
    for (let attempt = 0; ; attempt++) {
      let response: Response
      try {
        response = await this.fetchImpl(url, {
          headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/json' }, redirect: 'error',
          signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)])
        })
      } catch { throw new SourceError('request-failed', '无法连接 TAPD，请检查网络') }
      if (RETRY.has(response.status) && attempt < DELAYS.length) {
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
      if (response.status === 403) throw new SourceError('forbidden', `这个令牌没有权限访问该项目或接口${suffix}`)
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
