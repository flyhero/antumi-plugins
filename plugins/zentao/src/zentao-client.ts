import { z } from 'zod'
import { commentState, commentPage, SourceComment, type SourceCommentOptions, type SourceCommentPage } from '@antumi/plugin-sdk'
import TurndownService from 'turndown'
import { MAX_ISSUE_TITLE_LENGTH, MAX_SNAPSHOT_LENGTH, SourceError, type SourceIssue, type SourceIssueDetail, type SourceSettings, type SourceUser } from '@antumi/plugin-sdk'

export type ItemKind = 'task' | 'bug' | 'story'
const Account = z.union([z.string(), z.object({ account: z.string().optional(), realname: z.string().optional() })]).nullish()
const Id = z.union([z.number().int().positive(), z.string().regex(/^[1-9][0-9]*$/)]).transform(String)
const Hours = z.union([z.number(), z.string()]).nullish().transform((value) => { const hours = Number(value ?? 0); return Number.isFinite(hours) ? hours : 0 })
const Row = z.object({
  id: Id, name: z.string().optional(), title: z.string().optional(), status: z.string(),
  pri: z.union([z.string(), z.number()]).nullish(), assignedTo: Account,
  lastEditedDate: z.string().nullish(), editedDate: z.string().nullish(), openedDate: z.string().nullish(),
  desc: z.string().nullish(), steps: z.string().nullish(), spec: z.string().nullish(), verify: z.string().nullish(),
  deleted: z.union([z.boolean(), z.number(), z.string()]).optional(),
  // Task fields the status moves need: hours to report, and whether it is a parent task.
  left: Hours, estimate: Hours, consumed: Hours, realStarted: z.string().nullish(),
  isParent: z.union([z.boolean(), z.number(), z.string()]).optional(), parent: z.union([z.number(), z.string()]).nullish(),
  // Whose the item is and where it sits. Antumi can do without them, so a shape this does not know
  // reads as not given rather than failing the sync.
  openedBy: Account.catch(undefined), mode: z.string().nullish().catch(undefined), team: z.unknown().optional(),
  execution: Id.optional().catch(undefined), executionName: z.string().nullish().catch(undefined),
  product: Id.optional().catch(undefined), productName: z.string().nullish().catch(undefined),
  actions: z.union([
    z.array(z.object({ id: Id.optional(), comment: z.string().nullish(), actor: Account, date: z.string().nullish() })),
    z.record(z.string(), z.object({ id: Id.optional(), comment: z.string().nullish(), actor: Account, date: z.string().nullish() }))
  ]).optional()
})
export type ZentaoRow = z.infer<typeof Row>
const Page = z.object({
  page: z.coerce.number().int().positive(), total: z.coerce.number().int().nonnegative(), limit: z.coerce.number().int().positive(),
  tasks: z.array(Row).optional(), bugs: z.array(Row).optional(), stories: z.array(Row).optional()
})
const Profile = z.object({ profile: z.object({ account: z.string().min(1), realname: z.string().optional() }) })
export const plural: Record<ItemKind, 'tasks' | 'bugs' | 'stories'> = { task: 'tasks', bug: 'bugs', story: 'stories' }
export const titles: Record<ItemKind, string> = { task: '任务', bug: 'Bug', story: '需求' }
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

// The same account everywhere a person is named, so the signed-in user can be matched to an assignee.
export function person(value: z.infer<typeof Account>): SourceUser | null {
  const id = account(value)
  if (!id || id.length > 500) return null
  const name = typeof value === 'string' ? '' : value?.realname ?? ''
  return { id, name: (name || id).slice(0, 200) }
}

// A task sits in an execution, a bug or a story in a product. A list row carries the ID only.
export function scope(kind: ItemKind, row: ZentaoRow): SourceIssue['scope'] {
  const id = kind === 'task' ? row.execution : row.product
  const name = kind === 'task' ? row.executionName : row.productName
  return id ? { id, name: (name || id).slice(0, 200) } : undefined
}

function time(value: string | null | undefined): number | null {
  const result = value && !value.startsWith('0000-') ? Date.parse(value) : NaN
  return Number.isFinite(result) ? result : null
}

// The names ZenTao's zh-cn interface shows, so rules can name a status as users see it.
const statusNames: Record<ItemKind, Record<string, string>> = {
  task: { wait: '未开始', doing: '进行中', done: '已完成', pause: '已暂停', cancel: '已取消', closed: '已关闭' },
  bug: { active: '激活', resolved: '已解决', closed: '已关闭' },
  story: { draft: '草稿', reviewing: '评审中', active: '激活', changing: '变更中', closed: '已关闭' }
}

export function statusName(kind: ItemKind, state: string): string {
  return (statusNames[kind][state] ?? state).slice(0, 100)
}

export function category(kind: ItemKind, state: string): SourceIssue['statusCategory'] {
  if (['closed', 'cancel', 'canceled', 'done'].includes(state) || (kind === 'bug' && state === 'resolved')) return 'done'
  if (['doing', 'pause', 'changing', 'developing', 'testing'].includes(state)) return 'doing'
  if (['wait', 'active', 'draft', 'reviewing', 'changed'].includes(state)) return 'todo'
  return 'unknown'
}

function tooLarge(kind: ItemKind): string {
  return kind === 'task' ? '执行下任务过多，请把「指派给」设为 @me，或把状态范围设为「未完成」' : '同步范围过大或分页异常，请缩小产品范围'
}

function summary(kind: ItemKind, row: z.infer<typeof Row>, base: string): SourceIssue {
  const web = new URL(base)
  web.pathname = web.pathname.replace(/api\.php\/v1\/?$/, 'index.php')
  web.search = new URLSearchParams({ m: kind, f: 'view', [`${kind}ID`]: row.id }).toString()
  const within = scope(kind, row)
  return {
    key: `${kind}-${row.id}`, title: (row.name ?? row.title ?? `${titles[kind]} ${row.id}`).slice(0, MAX_ISSUE_TITLE_LENGTH),
    url: web.href, status: statusName(kind, row.status), statusCategory: category(kind, row.status),
    type: titles[kind], priority: row.pri == null || String(row.pri) === '0' ? null : `P${row.pri}`.slice(0, 100),
    updatedAt: time(row.lastEditedDate ?? row.editedDate ?? row.openedDate),
    typeId: kind, ...(within ? { scope: within } : {})
  }
}

// Antumi gives a list 20 seconds; past this, say the scope is too large rather than time out.
const LIST_BUDGET_MS = 15_000
const NO_ACCESS = '禅道账号没有访问该数据的权限，请在禅道为账号开通对应执行 / 产品的查看权限'

export class ZentaoClient {
  constructor(private readonly base: string, private readonly token: string, private readonly fetchImpl: typeof fetch = fetch) {}

  async profile(signal: AbortSignal) {
    return parse(Profile, await this.get('/user', signal)).profile
  }

  async list(kind: ItemKind, settings: SourceSettings, signal: AbortSignal): Promise<SourceIssue[]> {
    const owner = settings.assignee === '@me' ? (await this.profile(signal)).account : settings.assignee
    // An execution can hold tens of thousands of tasks, so let ZenTao filter them. assignedtome also
    // covers multi-person tasks, whose assignedTo ZenTao blanks, so those skip the local owner check.
    const mine = kind === 'task' && !!owner && (settings.assignee === '@me' || owner === (await this.profile(signal)).account)
    const status = kind !== 'task' ? null : mine ? 'assignedtome' : settings.state !== 'all' ? 'undone' : null
    const collection = plural[kind]
    const path = kind === 'task' ? `/executions/${settings.scopeId}/tasks` : `/products/${settings.scopeId}/${collection}`
    const found = new Map<string, SourceIssue>()
    const seen = new Set<string>()
    const deadline = Date.now() + LIST_BUDGET_MS
    for (let page = 1; page <= 20; page++) {
      if (page > 1 && Date.now() > deadline) throw new SourceError('bad-query', tooLarge(kind))
      const params = new URLSearchParams({ page: String(page), limit: '100', order: 'id_desc', ...(status ? { status } : {}) })
      const data = parse(Page, await this.get(`${path}?${params}`, signal))
      const rows = data[collection]
      if (data.page !== page || !Array.isArray(rows)) throw new SourceError('request-failed', '禅道返回了无效的分页信息')
      const items = parse(z.array(Row), rows)
      for (const row of items) {
        if (seen.has(row.id)) continue
        seen.add(row.id)
        if (row.deleted === true || row.deleted === 1 || row.deleted === '1') continue
        if (owner && !mine && account(row.assignedTo) !== owner) continue
        const issue = summary(kind, row, this.base)
        if (settings.state !== 'all' && issue.statusCategory === 'done') continue
        found.set(issue.key, issue)
      }
      if (found.size >= 200 || page * data.limit >= data.total) break
      if (!items.length || (page === 20)) throw new SourceError('bad-query', tooLarge(kind))
    }
    return [...found.values()].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)).slice(0, 200)
  }

  async row(kind: ItemKind, id: string, signal: AbortSignal): Promise<ZentaoRow> {
    const row = parse(Row, await this.get(`/${plural[kind]}/${id}`, signal))
    if (row.id !== id) throw new SourceError('request-failed', '禅道返回的事项编号不匹配')
    return row
  }

  // Runs one of the item's actions (start, resolve, ...) and returns its status afterwards.
  // forbidden names the privilege ZenTao refused, so the user knows what to ask for.
  async act(kind: ItemKind, id: string, path: string, body: Record<string, unknown>, forbidden: string, signal: AbortSignal): Promise<string> {
    const reply = z.object({ id: Id, status: z.string().min(1) }).safeParse(await this.request(`/${plural[kind]}/${id}/${path}`, signal, { body, forbidden }))
    // Some actions answer with the raw record; read it back when the status is not plainly there.
    return reply.success && reply.data.id === id ? reply.data.status : (await this.row(kind, id, signal)).status
  }

  async issue(kind: ItemKind, id: string, signal: AbortSignal): Promise<SourceIssueDetail> {
    const row = await this.row(kind, id, signal)
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
    const row = await this.row(kind, id, signal)
    const comments = this.commentsOf(row, summary(kind, row, this.base).url)
    if (!comments) throw new SourceError('request-failed', '禅道没有返回稳定的评论标识，只能更新原文快照')
    return commentPage(comments, options)
  }

  private get(path: string, signal: AbortSignal): Promise<unknown> {
    return this.request(path, signal)
  }

  // A write is a POST with a JSON body; its 400 and 403 answers carry ZenTao's reason.
  private async request(path: string, signal: AbortSignal, write?: { body: Record<string, unknown>; forbidden: string }): Promise<unknown> {
    let response: Response
    try {
      response = await this.fetchImpl(`${this.base}${path}`, {
        ...(write ? { method: 'POST', body: JSON.stringify(write.body) } : {}),
        headers: { Token: this.token, Accept: 'application/json', ...(write ? { 'Content-Type': 'application/json' } : {}) }, redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)])
      })
    } catch { throw new SourceError('request-failed', '无法连接禅道，请检查 API 地址和网络') }
    if (write && response.status === 403) {
      await response.body?.cancel()
      throw new SourceError('forbidden', `禅道账号没有「${write.forbidden}」权限，请在禅道为账号开通，或换用有该权限的账号获取 Token 后重新登录`)
    }
    if (write && response.status === 400) {
      const reason = await readJson(response, 64 * 1024).then(reasonText, () => '')
      throw new SourceError('request-failed', `禅道拒绝了这次操作${reason}`)
    }
    if (!response.ok) {
      await response.body?.cancel()
      const code = response.status === 401 ? 'auth-failed' : response.status === 403 ? 'forbidden' : response.status === 404 ? 'not-found' : 'request-failed'
      throw new SourceError(code, code === 'forbidden' ? NO_ACCESS : `禅道请求失败（HTTP ${response.status}）`)
    }
    const data = await readJson(response, 5 * 1024 * 1024)
    const failure = z.object({ error: z.unknown().optional(), status: z.string().optional() }).passthrough().safeParse(data)
    if (failure.success && (failure.data.error || failure.data.status === 'fail')) {
      if (!write && failure.data.error === 'Access not allowed') throw new SourceError('forbidden', NO_ACCESS)
      throw new SourceError('request-failed', write ? `禅道拒绝了这次操作${reasonText(data)}` : '禅道未能完成请求，请检查账号权限和 API 地址')
    }
    return data
  }
}

async function readJson(response: Response, max: number): Promise<unknown> {
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
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { throw new SourceError('request-failed', '禅道没有返回 JSON，请确认 RESTful API v1 地址') }
}

// ZenTao's own words for a refused action (「总计消耗为0时不能完成任务」), short and without markup;
// never the whole body.
function reasonText(data: unknown): string {
  const texts: string[] = []
  const collect = (value: unknown, depth: number) => {
    if (typeof value === 'string') texts.push(value)
    else if (depth < 3 && value && typeof value === 'object') for (const item of Object.values(value)) collect(item, depth + 1)
  }
  const reply = z.object({ error: z.unknown().optional(), message: z.unknown().optional() }).safeParse(data)
  if (reply.success) collect(reply.data.error ?? reply.data.message, 0)
  const text = texts.join('；').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()
  return text && text !== 'error' ? `：${text.slice(0, 200)}` : ''
}
