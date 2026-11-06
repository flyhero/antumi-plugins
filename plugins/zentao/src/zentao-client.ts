import { z } from 'zod'
import { commentState, commentPage, SourceComment, type SourceCommentOptions, type SourceCommentPage } from '@antumi/plugin-sdk'
import TurndownService from 'turndown'
import { MAX_ISSUE_TITLE_LENGTH, MAX_SNAPSHOT_LENGTH, SourceError, type SourceIssue, type SourceIssueDetail, type SourceSettings } from '@antumi/plugin-sdk'

export type ItemKind = 'task' | 'bug' | 'story'
const Account = z.union([z.string(), z.object({ account: z.string().optional(), realname: z.string().optional() })]).nullish()
const Id = z.union([z.number().int().positive(), z.string().regex(/^[1-9][0-9]*$/)]).transform(String)
const Row = z.object({
  id: Id, name: z.string().optional(), title: z.string().optional(), status: z.string(),
  pri: z.union([z.string(), z.number()]).nullish(), assignedTo: Account,
  lastEditedDate: z.string().nullish(), editedDate: z.string().nullish(), openedDate: z.string().nullish(),
  desc: z.string().nullish(), steps: z.string().nullish(), spec: z.string().nullish(), verify: z.string().nullish(),
  deleted: z.union([z.boolean(), z.number(), z.string()]).optional(),
  actions: z.union([
    z.array(z.object({ id: Id.optional(), comment: z.string().nullish(), actor: Account, date: z.string().nullish() })),
    z.record(z.string(), z.object({ id: Id.optional(), comment: z.string().nullish(), actor: Account, date: z.string().nullish() }))
  ]).optional()
})
const Page = z.object({
  page: z.coerce.number().int().positive(), total: z.coerce.number().int().nonnegative(), limit: z.coerce.number().int().positive(),
  tasks: z.array(Row).optional(), bugs: z.array(Row).optional(), stories: z.array(Row).optional()
})
const Profile = z.object({ profile: z.object({ account: z.string().min(1), realname: z.string().optional() }) })
const plural: Record<ItemKind, 'tasks' | 'bugs' | 'stories'> = { task: 'tasks', bug: 'bugs', story: 'stories' }
const titles: Record<ItemKind, string> = { task: '任务', bug: 'Bug', story: '需求' }
const markdown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' })
markdown.remove(['script', 'style', 'iframe'])

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) throw new SourceError('request-failed', '禅道返回了无法识别的数据，请确认使用 RESTful API v1')
  return result.data
}

export function account(value: z.infer<typeof Account>): string {
  return typeof value === 'string' ? value : value?.account ?? ''
}

function time(value: string | null | undefined): number | null {
  const result = value && !value.startsWith('0000-') ? Date.parse(value) : NaN
  return Number.isFinite(result) ? result : null
}

function category(kind: ItemKind, state: string): SourceIssue['statusCategory'] {
  if (['closed', 'cancel', 'canceled', 'done'].includes(state) || (kind === 'bug' && state === 'resolved')) return 'done'
  if (['doing', 'pause', 'changing', 'developing', 'testing'].includes(state)) return 'doing'
  if (['wait', 'active', 'draft', 'reviewing', 'changed'].includes(state)) return 'todo'
  return 'unknown'
}

function summary(kind: ItemKind, row: z.infer<typeof Row>, base: string): SourceIssue {
  const web = new URL(base)
  web.pathname = web.pathname.replace(/api\.php\/v1\/?$/, 'index.php')
  web.search = new URLSearchParams({ m: kind, f: 'view', [`${kind}ID`]: row.id }).toString()
  return {
    key: `${kind}-${row.id}`, title: (row.name ?? row.title ?? `${titles[kind]} ${row.id}`).slice(0, MAX_ISSUE_TITLE_LENGTH),
    url: web.href, status: row.status.slice(0, 100), statusCategory: category(kind, row.status),
    type: titles[kind], priority: row.pri == null || String(row.pri) === '0' ? null : `P${row.pri}`.slice(0, 100),
    updatedAt: time(row.lastEditedDate ?? row.editedDate ?? row.openedDate)
  }
}

export class ZentaoClient {
  constructor(private readonly base: string, private readonly token: string, private readonly fetchImpl: typeof fetch = fetch) {}

  async profile(signal: AbortSignal) {
    return parse(Profile, await this.get('/user', signal)).profile
  }

  async list(kind: ItemKind, settings: SourceSettings, signal: AbortSignal): Promise<SourceIssue[]> {
    const owner = settings.assignee === '@me' ? (await this.profile(signal)).account : settings.assignee
    const collection = plural[kind]
    const path = kind === 'task' ? `/executions/${settings.scopeId}/tasks` : `/products/${settings.scopeId}/${collection}`
    const found = new Map<string, SourceIssue>()
    const seen = new Set<string>()
    for (let page = 1; page <= 20; page++) {
      const params = new URLSearchParams({ page: String(page), limit: '100', orderBy: 'id_desc' })
      const data = parse(Page, await this.get(`${path}?${params}`, signal))
      const rows = data[collection]
      if (data.page !== page || !Array.isArray(rows)) throw new SourceError('request-failed', '禅道返回了无效的分页信息')
      const items = parse(z.array(Row), rows)
      for (const row of items) {
        if (seen.has(row.id)) continue
        seen.add(row.id)
        if (row.deleted === true || row.deleted === 1 || row.deleted === '1') continue
        if (owner && account(row.assignedTo) !== owner) continue
        const issue = summary(kind, row, this.base)
        if (settings.state !== 'all' && issue.statusCategory === 'done') continue
        found.set(issue.key, issue)
      }
      if (found.size >= 200 || page * data.limit >= data.total) break
      if (!items.length || (page === 20)) throw new SourceError('bad-query', '同步范围过大或分页异常，请缩小执行 / 产品范围')
    }
    return [...found.values()].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)).slice(0, 200)
  }

  async issue(kind: ItemKind, id: string, signal: AbortSignal): Promise<SourceIssueDetail> {
    const row = parse(Row, await this.get(`/${plural[kind]}/${id}`, signal))
    if (row.id !== id) throw new SourceError('request-failed', '禅道返回的事项编号不匹配')
    const issue = summary(kind, row, this.base)
    const body = kind === 'bug' ? row.steps : kind === 'story' ? row.spec ?? row.desc : row.desc
    const actions = row.actions ? (Array.isArray(row.actions) ? row.actions : Object.values(row.actions)) : []
    const comments = actions.filter((action) => action.comment?.trim()).sort((a, b) => (time(a.date) ?? 0) - (time(b.date) ?? 0)).slice(-20)
    const text = [
      `# ${issue.key} ${issue.title}`, `状态：${issue.status}`, `指派给：${account(row.assignedTo)}`,
      markdown.turndown(body ?? ''),
      ...(row.verify ? ['## 验收标准', markdown.turndown(row.verify)] : []),
      ...(comments.length ? ['## 最近评论', ...comments.map((action) => `### ${account(action.actor)} · ${action.date ?? ''}\n\n${markdown.turndown(action.comment ?? '')}`)] : [])
    ].join('\n\n')
    const structured = this.commentsOf(row, issue.url)
    return { ...issue, markdown: text.slice(0, MAX_SNAPSHOT_LENGTH), ...(structured ? { commentState: commentState(structured) } : {}) }
  }

  private commentsOf(row: z.infer<typeof Row>, url: string): SourceComment[] | null {
    const actions = Array.isArray(row.actions) ? row.actions.map((action) => [action.id, action] as const) : Object.entries(row.actions ?? {})
    const comments: SourceComment[] = []
    for (const [identity, action] of actions) {
      if (!action.comment?.trim()) continue
      const body = markdown.turndown(action.comment)
      const parsed = SourceComment.safeParse({ id: action.id ?? identity ?? '', author: account(action.actor), createdAt: time(action.date), updatedAt: null,
        url, markdown: body.slice(0, 50_000), truncated: body.length > 50_000 })
      if (!parsed.success) return null
      comments.push(parsed.data)
    }
    return comments
  }

  async commentChanges(kind: ItemKind, id: string, signal: AbortSignal, options: SourceCommentOptions): Promise<SourceCommentPage> {
    const row = parse(Row, await this.get(`/${plural[kind]}/${id}`, signal))
    if (row.id !== id) throw new SourceError('request-failed', '禅道返回的事项编号不匹配')
    const comments = this.commentsOf(row, summary(kind, row, this.base).url)
    if (!comments) throw new SourceError('request-failed', '禅道没有返回稳定的评论标识，只能更新原文快照')
    return commentPage(comments, options)
  }

  private async get(path: string, signal: AbortSignal): Promise<unknown> {
    let response: Response
    try {
      response = await this.fetchImpl(`${this.base}${path}`, {
        headers: { Token: this.token, Accept: 'application/json' }, redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)])
      })
    } catch { throw new SourceError('request-failed', '无法连接禅道，请检查 API 地址和网络') }
    if (!response.ok) {
      await response.body?.cancel()
      const code = response.status === 401 ? 'auth-failed' : response.status === 403 ? 'forbidden' : response.status === 404 ? 'not-found' : 'request-failed'
      throw new SourceError(code, `禅道请求失败（HTTP ${response.status}）`)
    }
    const max = 5 * 1024 * 1024
    if (Number(response.headers.get('content-length')) > max) {
      await response.body?.cancel()
      throw new SourceError('response-too-large', '禅道返回内容过大')
    }
    const reader = response.body?.getReader()
    if (!reader) throw new SourceError('request-failed', '禅道返回了空响应')
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > max) { await reader.cancel(); throw new SourceError('response-too-large', '禅道返回内容过大') }
        chunks.push(value)
      }
    } finally { reader.releaseLock() }
    let data: unknown
    try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
    catch { throw new SourceError('request-failed', '禅道没有返回 JSON，请确认 RESTful API v1 地址') }
    const failure = z.object({ error: z.unknown().optional(), status: z.string().optional() }).passthrough().safeParse(data)
    if (failure.success && (failure.data.error || failure.data.status === 'fail')) throw new SourceError('request-failed', '禅道未能完成请求，请检查账号权限和 API 地址')
    return data
  }
}
