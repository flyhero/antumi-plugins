import { z } from 'zod'
import { commentState, commentPage, SourceComment, type SourceCommentOptions, type SourceCommentPage } from '@antumi/plugin-sdk'
import { MAX_ISSUE_TITLE_LENGTH, MAX_SNAPSHOT_LENGTH, SourceError, type SourceIssue, type SourceIssueDetail, type SourceSettings } from '@antumi/plugin-sdk'
import type { SourceCommentResult, SourceStatusResult, SourceTransitionOption, SourceTransitions } from '@antumi/plugin-sdk'

const ENDPOINT = 'https://api.linear.app/graphql'
const Person = z.object({ name: z.string(), email: z.string().optional() })
const Row = z.object({
  identifier: z.string(), title: z.string(), url: z.string(), updatedAt: z.string(),
  priority: z.number(), priorityLabel: z.string(),
  state: z.object({ name: z.string(), type: z.string() }),
  labels: z.object({ nodes: z.array(z.object({ name: z.string() })) })
})
const Page = z.object({
  issues: z.object({ nodes: z.array(Row), pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }) })
})
const Viewer = z.object({ viewer: z.object({ id: z.string(), name: z.string(), email: z.string() }) })
const CommentRow = z.object({ id: z.string().optional(), body: z.string(), createdAt: z.string(), updatedAt: z.string().optional(), url: z.string().optional(), user: Person.nullable() })
const Detail = z.object({ issue: Row.extend({
  description: z.string().nullable(), creator: Person.nullable(), assignee: Person.nullable(),
  comments: z.object({ nodes: z.array(CommentRow) })
}).nullable() })
const Envelope = z.object({
  data: z.unknown().optional(),
  errors: z.array(z.object({ message: z.string().optional(), extensions: z.object({ code: z.string().optional(), type: z.string().optional() }).passthrough().optional() }).passthrough()).optional()
})
const State = z.object({ id: z.string(), name: z.string(), type: z.string() })
const Workflow = z.object({ issue: z.object({
  id: z.string(), identifier: z.string(), state: State,
  team: z.object({ states: z.object({ nodes: z.array(State.extend({ position: z.number() })) }) })
}).nullable() })
const Updated = z.object({ issueUpdate: z.object({ success: z.boolean(), issue: z.object({ state: State }).nullable() }) })
const Created = z.object({ commentCreate: z.object({ success: z.boolean(), comment: z.object({ id: z.string(), url: z.string().nullable().optional() }) }) })
const Existing = z.object({ comment: z.object({ id: z.string(), url: z.string().nullable().optional(), issue: z.object({ id: z.string() }).nullable() }).nullable(), issue: z.object({ id: z.string() }).nullable() })

const CATEGORIES: Record<string, SourceIssue['statusCategory']> = {
  triage: 'todo', backlog: 'todo', unstarted: 'todo', started: 'doing', completed: 'done', canceled: 'done', duplicate: 'done'
}
// Linear's own board order; a status's position only orders it within its type.
const TYPE_ORDER = ['triage', 'backlog', 'unstarted', 'started', 'completed', 'canceled']
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const WRITE_FORBIDDEN = 'Linear API Key 没有写权限，请用具有 Write 权限的 API Key 重新登录'
const WORKFLOW_QUERY = `query AntumiWorkflow($id: String!) {
  issue(id: $id) { id identifier state { id name type } team { states(first: 100) { nodes { id name type position } } } }
}`

export const ISSUE_FIELDS = 'identifier title url updatedAt priority priorityLabel state { name type } labels { nodes { name } }'
export const LIST_QUERY = `query AntumiIssues($filter: IssueFilter, $after: String) {
  issues(first: 50, after: $after, orderBy: updatedAt, filter: $filter) {
    nodes { ${ISSUE_FIELDS} }
    pageInfo { hasNextPage endCursor }
  }
}`
export const DETAIL_QUERY = `query AntumiIssue($id: String!) {
  issue(id: $id) {
    ${ISSUE_FIELDS}
    description creator { name } assignee { name }
    comments(first: 20, orderBy: createdAt) { nodes { id body createdAt updatedAt url user { name } } }
  }
}`

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) throw new SourceError('request-failed', 'Linear 返回了无法识别的数据')
  return result.data
}

function time(value: string): number | null {
  const result = Date.parse(value)
  return Number.isFinite(result) ? result : null
}

function category(type: string): SourceIssue['statusCategory'] {
  return CATEGORIES[type] ?? 'unknown'
}

function status(state: z.infer<typeof State>): SourceStatusResult {
  return { status: state.name.slice(0, 100), statusCategory: category(state.type) }
}

type QueryOptions = { write?: boolean }

function summarize(row: z.infer<typeof Row>): SourceIssue {
  return {
    key: row.identifier, title: row.title.slice(0, MAX_ISSUE_TITLE_LENGTH), url: row.url,
    status: row.state.name, statusCategory: category(row.state.type),
    type: row.labels.nodes.some((label) => /^(bug|defect|缺陷)$/i.test(label.name)) ? 'Bug' : 'Issue',
    priority: row.priority === 0 ? null : row.priorityLabel.slice(0, 100), updatedAt: time(row.updatedAt)
  }
}

export class LinearClient {
  constructor(private readonly token: string, private readonly fetchImpl: typeof fetch = fetch) {}

  async viewer(signal: AbortSignal) {
    return parse(Viewer, await this.query('query AntumiViewer { viewer { id name email } }', {}, signal)).viewer
  }

  async list(settings: SourceSettings, signal: AbortSignal): Promise<SourceIssue[]> {
    const filter: Record<string, unknown> = {}
    if (settings.team) filter.team = { key: { eq: settings.team } }
    if (settings.project) filter.project = { id: { eq: settings.project } }
    if (settings.assignee === '@me') filter.assignee = { id: { eq: (await this.viewer(signal)).id } }
    else if (settings.assignee) filter.assignee = { email: { eq: settings.assignee } }
    if (settings.state !== 'all') filter.state = { type: { nin: ['completed', 'canceled', 'duplicate'] } }
    const result = new Map<string, SourceIssue>()
    let after: string | null = null
    const cursors = new Set<string>()
    for (let page = 0; page < 4; page++) {
      const pageResult: z.infer<typeof Page> = parse(Page, await this.query(LIST_QUERY, { filter, after }, signal))
      const issues = pageResult.issues
      for (const row of issues.nodes) result.set(row.identifier, summarize(row))
      if (!issues.pageInfo.hasNextPage) break
      after = issues.pageInfo.endCursor
      if (!after || cursors.has(after)) throw new SourceError('request-failed', 'Linear 返回了无效的分页游标')
      cursors.add(after)
    }
    return [...result.values()].slice(0, 200)
  }

  async issue(key: string, signal: AbortSignal): Promise<SourceIssueDetail> {
    const { issue } = parse(Detail, await this.query(DETAIL_QUERY, { id: key }, signal))
    if (!issue) throw new SourceError('not-found', `Linear 中没有 ${key}`)
    if (issue.identifier.toUpperCase() !== key.toUpperCase()) throw new SourceError('request-failed', 'Linear 返回的事项编号不匹配')
    const metadata = [`# ${issue.identifier} ${issue.title}`, `状态：${issue.state.name}`, `创建人：${issue.creator?.name ?? ''}`, `指派给：${issue.assignee?.name ?? ''}`, `标签：${issue.labels.nodes.map((label) => label.name).join('、')}`]
    const comments = [...issue.comments.nodes].sort((a, b) => (time(a.createdAt) ?? 0) - (time(b.createdAt) ?? 0))
    const markdown = [...metadata, '', issue.description ?? '', '', '## 最近评论（最多 20 条）', ...comments.map((comment) => `### ${comment.user?.name ?? 'Unknown'} · ${comment.createdAt}\n\n${comment.body}`)].join('\n\n')
    const structured = issue.comments.nodes.map((comment) => SourceComment.safeParse(this.structuredComment(comment, issue.url)))
    let state = structured.every((value) => value.success) ? commentState(structured.flatMap((value) => value.data ? [value.data] : [])) : undefined
    if (state && issue.comments.nodes.length === 20 && issue.comments.nodes.every((comment) => time(comment.createdAt) === state?.checkpoint.createdAt)) {
      const complete = await this.commentChanges(key, signal, { checkpoint: { createdAt: state.checkpoint.createdAt, ids: [] }, continuation: null })
      state = { ...state, checkpoint: complete.checkpoint }
    }
    return { ...summarize(issue), markdown: markdown.slice(0, MAX_SNAPSHOT_LENGTH), ...(state ? { commentState: state } : {}) }
  }

  private structuredComment(comment: z.infer<typeof CommentRow>, url: string) {
    return { id: comment.id ?? '', author: comment.user?.name ?? '', createdAt: time(comment.createdAt), updatedAt: comment.updatedAt ? time(comment.updatedAt) : null,
      url: comment.url ?? url, markdown: comment.body.slice(0, 50_000), truncated: comment.body.length > 50_000 }
  }

  async commentChanges(key: string, signal: AbortSignal, options: SourceCommentOptions): Promise<SourceCommentPage> {
    const schema = z.object({ issue: z.object({ identifier: z.string(), url: z.string(), comments: z.object({ nodes: z.array(CommentRow), pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }) }) }).nullable() })
    const query = `query AntumiComments($id: String!, $after: String) { issue(id: $id) { identifier url comments(first: 100, after: $after, orderBy: createdAt) { nodes { id body createdAt updatedAt url user { name } } pageInfo { hasNextPage endCursor } } } }`
    const comments: SourceComment[] = []
    let after: string | null = null
    const seen = new Set<string>()
    for (;;) {
      const data: z.infer<typeof schema> = parse(schema, await this.query(query, { id: key, after }, signal))
      if (!data.issue || data.issue.identifier.toUpperCase() !== key.toUpperCase()) throw new SourceError('not-found', 'Linear issue not found')
      const page = data.issue.comments
      for (const comment of page.nodes) comments.push(SourceComment.parse(this.structuredComment(comment, data.issue.url)))
      if (!page.pageInfo.hasNextPage || page.nodes.some((comment) => (time(comment.createdAt) ?? Infinity) < options.checkpoint.createdAt)) break
      const next = page.pageInfo.endCursor
      if (!next || seen.has(next) || !page.nodes.length || seen.size >= 1000) throw new SourceError('request-failed', 'Invalid Linear comment pagination')
      seen.add(next)
      after = next
    }
    return commentPage(comments, options)
  }

  async transitions(key: string, signal: AbortSignal): Promise<SourceTransitions> {
    const issue = await this.workflow(key, signal)
    const order = (type: string) => { const index = TYPE_ORDER.indexOf(type); return index < 0 ? TYPE_ORDER.length : index }
    const options: SourceTransitionOption[] = issue.team.states.nodes
      // Moving into the duplicate status needs a duplicate relation, which a status change cannot make.
      .filter((state) => state.id !== issue.state.id && state.type !== 'duplicate' && state.name.trim())
      .sort((a, b) => order(a.type) - order(b.type) || a.position - b.position)
      .slice(0, 100)
      .map((state) => ({ id: state.id, name: state.name.slice(0, 100), category: category(state.type) }))
    return { ...status(issue.state), options }
  }

  async transition(key: string, id: string, signal: AbortSignal): Promise<SourceStatusResult> {
    const issue = await this.workflow(key, signal)
    // Someone else may have made the same move since the options were read.
    if (id === issue.state.id) return status(issue.state)
    const target = issue.team.states.nodes.find((state) => state.id === id && state.type !== 'duplicate')
    if (!target) throw new SourceError('request-failed', `${key} 不能改到这个状态，请刷新状态列表后重试`)
    const mutation = `mutation AntumiMove($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success issue { state { id name type } } } }`
    const { issueUpdate } = parse(Updated, await this.query(mutation, { id: issue.id, stateId: target.id }, signal, { write: true }))
    if (!issueUpdate.success) throw new SourceError('request-failed', 'Linear 没有修改事项状态')
    return status(issueUpdate.issue?.state ?? target)
  }

  async comment(key: string, markdown: string, writeId: string, signal: AbortSignal): Promise<SourceCommentResult> {
    // Linear takes the comment's id from us, so a retry with the same writeId is refused as a duplicate.
    const id = UUID_V4.test(writeId) ? writeId.toLowerCase() : undefined
    const mutation = `mutation AntumiComment($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id url } } }`
    let created: z.infer<typeof Created>
    try {
      created = parse(Created, await this.query(mutation, { input: { issueId: key, body: markdown, ...(id ? { id } : {}) } }, signal, { write: true }))
    } catch (failure) {
      if (!id || !(failure instanceof SourceError) || ['auth-failed', 'forbidden', 'response-too-large'].includes(failure.code)) throw this.writeFailure(failure, key)
      const existing = await this.existingComment(id, key, signal)
      if (!existing) throw this.writeFailure(failure, key)
      return existing
    }
    if (!created.commentCreate.success) throw new SourceError('request-failed', 'Linear 没有发出评论')
    return { id: created.commentCreate.comment.id, url: created.commentCreate.comment.url || null }
  }

  // The comment an earlier attempt with this id already posted on this issue, if any.
  private async existingComment(id: string, key: string, signal: AbortSignal): Promise<SourceCommentResult | null> {
    const query = `query AntumiExistingComment($comment: String!, $issue: String!) { comment(id: $comment) { id url issue { id } } issue(id: $issue) { id } }`
    try {
      const { comment, issue } = parse(Existing, await this.query(query, { comment: id, issue: key }, signal))
      if (!comment || !issue || comment.issue?.id !== issue.id) return null
      return { id: comment.id, url: comment.url || null }
    } catch { return null }
  }

  private async workflow(key: string, signal: AbortSignal) {
    let issue: z.infer<typeof Workflow>['issue']
    try { issue = parse(Workflow, await this.query(WORKFLOW_QUERY, { id: key }, signal)).issue }
    catch (failure) { throw this.writeFailure(failure, key) }
    if (!issue) throw new SourceError('not-found', `Linear 中没有 ${key}`)
    if (issue.identifier.toUpperCase() !== key.toUpperCase()) throw new SourceError('request-failed', 'Linear 返回的事项编号不匹配')
    return issue
  }

  private writeFailure(failure: unknown, key: string): unknown {
    return failure instanceof SourceError && failure.code === 'not-found' ? new SourceError('not-found', `Linear 中没有 ${key}`) : failure
  }

  private async query(query: string, variables: Record<string, unknown>, signal: AbortSignal, options: QueryOptions = {}): Promise<unknown> {
    let response: Response
    try {
      response = await this.fetchImpl(ENDPOINT, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: this.token },
        body: JSON.stringify({ query, variables }), redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)])
      })
    } catch { throw new SourceError('request-failed', '无法连接 Linear，请检查网络或重试') }
    // Linear answers some GraphQL errors (a missing entity, a read-only key) with HTTP 400 and the
    // errors in the body, so those are read like a 200.
    if (!response.ok && response.status !== 400) {
      await response.body?.cancel()
      const code = response.status === 401 ? 'auth-failed' : response.status === 403 ? 'forbidden' : response.status === 404 ? 'not-found' : 'request-failed'
      if (code === 'forbidden' && options.write) throw new SourceError(code, WRITE_FORBIDDEN)
      throw new SourceError(code, response.status === 429 ? 'Linear 请求频率超限，请稍后重试' : `Linear 请求失败（HTTP ${response.status}）`)
    }
    const max = 5 * 1024 * 1024
    if (Number(response.headers.get('content-length')) > max) {
      await response.body?.cancel()
      throw new SourceError('response-too-large', 'Linear 返回内容过大')
    }
    const chunks: Uint8Array[] = []
    let bytes = 0
    const reader = response.body?.getReader()
    if (!reader) throw new SourceError('request-failed', 'Linear 返回了空响应')
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        bytes += value.byteLength
        if (bytes > max) { await reader.cancel(); throw new SourceError('response-too-large', 'Linear 返回内容过大') }
        chunks.push(value)
      }
    } finally { reader.releaseLock() }
    const failed = new SourceError('request-failed', `Linear 请求失败（HTTP ${response.status}）`)
    let raw: unknown
    try { raw = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
    catch { throw response.ok ? new SourceError('request-failed', 'Linear 没有返回 JSON') : failed }
    const envelope = Envelope.safeParse(raw)
    if (!envelope.success) throw response.ok ? new SourceError('request-failed', 'Linear 返回了无法识别的数据') : failed
    const errors = envelope.data.errors ?? []
    if (!errors.length && !response.ok) throw failed
    if (errors.length) {
      const codes = errors.flatMap((error) => [error.extensions?.code, error.extensions?.type]).filter(Boolean).join(' ')
      // Messages only classify the error; they never reach the user or the log.
      const messages = errors.map((error) => error.message ?? '').join(' ')
      const code = /FORBIDDEN|permission/i.test(codes) || /invalid scope|scope .*required|permission/i.test(messages) ? 'forbidden'
        : /AUTHENTICATION|UNAUTHENTICATED|authentication/i.test(codes) ? 'auth-failed'
          : /NOT_FOUND|not.?found/i.test(codes) || /entity not found/i.test(messages) ? 'not-found'
            : /RATELIMITED/i.test(codes) ? 'rate-limited'
              : /BAD_USER_INPUT|GRAPHQL_VALIDATION/i.test(codes) ? 'bad-query' : 'request-failed'
      if (code === 'forbidden' && options.write) throw new SourceError(code, WRITE_FORBIDDEN)
      if (code === 'rate-limited') throw new SourceError('request-failed', 'Linear 请求频率超限，请稍后重试')
      throw new SourceError(code, 'Linear 未能完成查询，请检查账号权限和筛选条件')
    }
    return envelope.data.data
  }
}
