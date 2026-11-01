import { z } from 'zod'
import { MAX_ISSUE_TITLE_LENGTH, MAX_SNAPSHOT_LENGTH, SourceError, type SourceIssue, type SourceIssueDetail, type SourceSettings } from '@antumi/plugin-sdk'

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
const Detail = z.object({ issue: Row.extend({
  description: z.string().nullable(), creator: Person.nullable(), assignee: Person.nullable(),
  comments: z.object({ nodes: z.array(z.object({ body: z.string(), createdAt: z.string(), user: Person.nullable() })) })
}).nullable() })
const Envelope = z.object({
  data: z.unknown().optional(),
  errors: z.array(z.object({ extensions: z.object({ code: z.string().optional(), type: z.string().optional() }).passthrough().optional() }).passthrough()).optional()
})

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
    comments(first: 20, orderBy: createdAt) { nodes { body createdAt user { name } } }
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

function summarize(row: z.infer<typeof Row>): SourceIssue {
  const categories: Record<string, SourceIssue['statusCategory']> = {
    triage: 'todo', backlog: 'todo', unstarted: 'todo', started: 'doing', completed: 'done', canceled: 'done', duplicate: 'done'
  }
  return {
    key: row.identifier, title: row.title.slice(0, MAX_ISSUE_TITLE_LENGTH), url: row.url,
    status: row.state.name, statusCategory: categories[row.state.type] ?? 'unknown',
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
    return { ...summarize(issue), markdown: markdown.slice(0, MAX_SNAPSHOT_LENGTH) }
  }

  private async query(query: string, variables: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    let response: Response
    try {
      response = await this.fetchImpl(ENDPOINT, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: this.token },
        body: JSON.stringify({ query, variables }), redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)])
      })
    } catch { throw new SourceError('request-failed', '无法连接 Linear，请检查网络或重试') }
    if (!response.ok) {
      await response.body?.cancel()
      const code = response.status === 401 ? 'auth-failed' : response.status === 403 ? 'forbidden' : response.status === 404 ? 'not-found' : 'request-failed'
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
    let raw: unknown
    try { raw = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
    catch { throw new SourceError('request-failed', 'Linear 没有返回 JSON') }
    const envelope = parse(Envelope, raw)
    if (envelope.errors?.length) {
      const codes = envelope.errors.flatMap((error) => [error.extensions?.code, error.extensions?.type]).filter(Boolean).join(' ')
      const code = /AUTHENTICATION|UNAUTHENTICATED|authentication/i.test(codes) ? 'auth-failed'
        : /FORBIDDEN|permission/i.test(codes) ? 'forbidden' : /NOT_FOUND|not.?found/i.test(codes) ? 'not-found'
          : /BAD_USER_INPUT|GRAPHQL_VALIDATION/i.test(codes) ? 'bad-query' : 'request-failed'
      throw new SourceError(code, 'Linear 未能完成查询，请检查账号权限和筛选条件')
    }
    return envelope.data
  }
}
