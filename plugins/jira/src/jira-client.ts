import { z } from 'zod'
import { commentState, commentPage, SourceComment, type SourceCommentState, type SourceCommentOptions, type SourceCommentPage } from '@antumi/plugin-sdk'
import { adfToMarkdown, escapeLinkText } from './jira-adf.js'
import { isImageAttachment } from './jira-snapshot.js'
import { ISSUE_STATUS_CATEGORIES, MAX_TASK_IMAGES, type SourceCommentResult, type SourceIssue, type SourceStatusResult, type SourceTransitions } from '@antumi/plugin-sdk'
import type { AdfDocument } from './markdown-adf.js'
import { SourceError } from '@antumi/plugin-sdk'

export type JiraCredentials = { site: string; email: string; token: string }

export type JiraComment = { author: string; created: number | null; body: unknown }
export type JiraAttachment = { id: string; filename: string; mimeType: string; size: number }
export type JiraIssue = SourceIssue & {
  commentState?: SourceCommentState
  description: unknown
  // The latest comments, oldest first; `commentTotal` says how many the issue has in all.
  comments: JiraComment[]
  commentTotal: number
  attachments: JiraAttachment[]
}

export type JiraApi = {
  commentChanges?(key: string, signal: AbortSignal, options: SourceCommentOptions): Promise<SourceCommentPage>
  myself(signal: AbortSignal): Promise<{ displayName: string }>
  search(jql: string, signal: AbortSignal): Promise<SourceIssue[]>
  issue(key: string, signal: AbortSignal): Promise<JiraIssue>
  // An attachment's bytes, at most `limit` of them; what they are is for the caller to check.
  download(attachmentId: string, limit: number, signal: AbortSignal): Promise<Uint8Array>
  // Writing back: the issue's status and the transitions open to it now, a move by transition id,
  // and a comment.
  transitions?(key: string, signal: AbortSignal): Promise<SourceTransitions>
  transition?(key: string, id: string, signal: AbortSignal): Promise<SourceStatusResult>
  addComment?(key: string, body: AdfDocument, signal: AbortSignal): Promise<SourceCommentResult>
}

// Jira's own key format; anything else in a reply is dropped before it can reach a URL.
export const JIRA_KEY_PATTERN = /^[A-Z][A-Z0-9_]*-[1-9][0-9]*$/

const TIMEOUT_MS = 15_000
// A hostile or broken server must not make core buffer or parse without bound.
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024
const MAX_ERROR_BYTES = 64 * 1024
// An inbox is for reading, not for paging through a whole project.
const SEARCH_LIMIT = 200
const PAGE_SIZE = 100
const COMMENT_LIMIT = 20
const SUMMARY_FIELDS = 'summary,status,priority,issuetype,updated'
const ISSUE_FIELDS = `${SUMMARY_FIELDS},description,attachment`

// Origin only; plain http is refused except on loopback, since the token rides in every request.
export function normalizeSite(input: string): string {
  const text = input.trim()
  let url: URL
  try {
    url = new URL(/^[a-z]+:\/\//i.test(text) ? text : `https://${text}`)
  } catch {
    throw new SourceError('invalid-settings', `not a site address: ${input}`)
  }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new SourceError('invalid-settings', 'the Jira site must use https')
  }
  return url.origin
}

const Named = z.object({ name: z.string() })
const SummaryFields = z.object({
  summary: z.string().nullish(),
  status: Named.extend({ statusCategory: z.object({ key: z.string() }).nullish() }).nullish(),
  priority: Named.nullish(),
  issuetype: Named.nullish(),
  updated: z.string().nullish()
})
const IssueRow = z.object({ key: z.string(), fields: SummaryFields })
const SearchPage = z.object({
  issues: z.array(IssueRow),
  nextPageToken: z.string().nullish(),
  isLast: z.boolean().nullish()
})
const Attachments = z
  .array(
    z.object({
      id: z.union([z.string(), z.number()]).transform(String),
      filename: z.string(),
      mimeType: z.string().catch(''),
      size: z.number().catch(0)
    })
  )
  .nullish()
const IssueDetail = IssueRow.extend({
  fields: SummaryFields.extend({
    description: z.unknown(),
    attachment: Attachments
  })
})
const AttachmentFields = z.object({ fields: z.object({ attachment: Attachments }) })
const CommentPage = z.object({
  comments: z.array(
    z.object({
      id: z.string().optional(), updated: z.string().nullish(), self: z.string().optional(),
      author: z.object({ displayName: z.string() }).nullish(),
      created: z.string().nullish(),
      body: z.unknown()
    })
  ),
  total: z.number().nullish()
})
const TenantInfo = z.object({ cloudId: z.string() })
const ErrorBody = z.object({ errorMessages: z.array(z.string()).optional() })
const StatusRow = Named.extend({ id: z.union([z.string(), z.number()]).transform(String).nullish(), statusCategory: z.object({ key: z.string() }).nullish() })
const IssueStatus = z.object({ key: z.string(), fields: z.object({ status: StatusRow.nullish() }) })
const TransitionList = z.object({
  transitions: z.array(
    z.object({
      id: z.union([z.string(), z.number()]).transform(String),
      name: z.string().catch(''),
      isAvailable: z.boolean().nullish(),
      to: StatusRow.nullish(),
      // With expand=transitions.fields: the transition screen's fields, by field id.
      fields: z.record(z.string(), z.object({ required: z.boolean().catch(false), hasDefaultValue: z.boolean().catch(false) }).catch({ required: false, hasDefaultValue: false })).nullish()
    })
  )
})
const CreatedComment = z.object({ id: z.union([z.string(), z.number()]).transform(String) })
// What Jira says when a write is refused; the fields map holds a message per field it wanted.
const WriteErrorBody = z.object({
  errorMessages: z.array(z.string()).catch([]),
  errors: z.record(z.string(), z.string()).catch({}),
  message: z.string().catch('')
})
const MAX_OPTIONS = 100
const WRITE_TOKEN_HINT = '请用有写权限的 API token 重新登录（带权限范围的 token 需要 write:jira-work）'

// A reply of the wrong shape means the address is not a Jira REST API.
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    throw new SourceError('request-failed', 'unexpected reply from Jira')
  }
  return parsed.data
}

// Counted as they arrive: a Content-Length that lies does not get past the limit either.
async function readBytes(response: Response, limit: number): Promise<Uint8Array> {
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel()
    throw new SourceError('response-too-large', `Jira answered with more than ${limit} bytes`)
  }
  const reader = response.body?.getReader()
  if (!reader) {
    return new Uint8Array()
  }
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }
    size += value.byteLength
    if (size > limit) {
      await reader.cancel()
      throw new SourceError('response-too-large', `Jira answered with more than ${limit} bytes`)
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}

async function readText(response: Response, limit: number): Promise<string> {
  return Buffer.from(await readBytes(response, limit)).toString('utf8')
}

// A sign-in page instead of JSON is the usual sign of a wrong site address.
async function readJson(response: Response): Promise<unknown> {
  const text = await readText(response, MAX_RESPONSE_BYTES)
  try {
    return JSON.parse(text)
  } catch {
    throw new SourceError('request-failed', 'Jira did not answer with JSON')
  }
}

function time(value: string | null | undefined): number | null {
  const ms = value ? Date.parse(value) : Number.NaN
  return Number.isFinite(ms) ? ms : null
}

const CATEGORY: Record<string, (typeof ISSUE_STATUS_CATEGORIES)[number]> = {
  new: 'todo',
  indeterminate: 'doing',
  done: 'done'
}

function statusOf(status: z.infer<typeof StatusRow> | null | undefined): SourceStatusResult {
  return { status: (status?.name ?? '').slice(0, 100), statusCategory: CATEGORY[status?.statusCategory?.key ?? ''] ?? 'unknown' }
}

// Jira's own words go along, shortened: they say which permission or field it wanted.
function brief(parts: readonly string[]): string {
  const text = parts.map((part) => part.trim()).filter(Boolean).join('；').replace(/\s+/g, ' ')
  return text.length > 200 ? `${text.slice(0, 200)}…` : text
}

function summarize(site: string, row: z.infer<typeof IssueRow>): SourceIssue | null {
  if (!JIRA_KEY_PATTERN.test(row.key)) {
    return null
  }
  const { fields } = row
  return {
    key: row.key,
    title: fields.summary ?? '',
    url: `${site}/browse/${row.key}`,
    status: fields.status?.name ?? '',
    statusCategory: CATEGORY[fields.status?.statusCategory?.key ?? ''] ?? 'unknown',
    type: fields.issuetype?.name ?? '',
    priority: fields.priority?.name ?? null,
    updatedAt: time(fields.updated)
  }
}

async function failure(response: Response): Promise<SourceError> {
  let detail = ''
  try {
    detail = ErrorBody.parse(JSON.parse(await readText(response, MAX_ERROR_BYTES))).errorMessages?.join('; ') ?? ''
  } catch {
    // An error page that is not Jira's JSON: the status code alone has to do.
    detail = ''
  }
  const message = detail || `Jira answered ${response.status}`
  switch (response.status) {
    case 400:
      return new SourceError('bad-query', message)
    case 401:
      return new SourceError('auth-failed', message)
    case 403:
      return new SourceError('forbidden', message)
    case 404:
      return new SourceError('not-found', message)
    default:
      return new SourceError('request-failed', message)
  }
}

type WriteKind = 'transition' | 'comment'
type Write = { method: 'POST'; body: unknown }

// A refused write, in words that say what to do. A scoped token without write:jira-work is turned
// down by the gateway with 401 "scope does not match"; a missing project permission is 403, or 400
// on a transition.
async function writeFailure(response: Response, kind: WriteKind, key: string): Promise<SourceError> {
  let body: z.infer<typeof WriteErrorBody> = { errorMessages: [], errors: {}, message: '' }
  try {
    body = WriteErrorBody.parse(JSON.parse(await readText(response, MAX_ERROR_BYTES)))
  } catch {
    // Not Jira's JSON: the status code alone has to do.
  }
  const said = brief([...body.errorMessages, body.message])
  const fields = brief(Object.values(body.errors))
  const suffix = (text: string) => (text ? `（Jira：${text}）` : '')
  const action = kind === 'transition' ? '修改这个事项的状态' : '在这个事项下发评论'
  const forbidden = new SourceError('forbidden', `没有权限${action}：${WRITE_TOKEN_HINT}，并确认你在 Jira 项目里有 ${kind === 'transition' ? 'Transition Issues' : 'Add Comments'} 权限。${suffix(said)}`)
  switch (response.status) {
    case 401:
      return /scope/i.test(said) ? forbidden : new SourceError('auth-failed', `Jira 不接受当前的 API token，请重新登录。${suffix(said)}`)
    case 403:
      return forbidden
    case 404:
      return new SourceError('not-found', `在 Jira 里找不到 ${key}，或者当前账号看不到它。`)
    case 400:
      if (/permission/i.test(said)) return forbidden
      if (kind === 'transition' && fields) return new SourceError('request-failed', `流转到这个状态需要先填写字段，请到 Jira 里操作。${suffix(fields)}`)
      return new SourceError('request-failed', `Jira 拒绝了这次${kind === 'transition' ? '状态修改' : '评论'}。${suffix(said || fields)}`)
    case 409:
      return new SourceError('request-failed', `${key} 刚被别人修改过，请稍后重试。`)
    case 413:
      return new SourceError('request-failed', `评论太长，或者 ${key} 的评论数已达到 Jira 的上限。`)
    default:
      return new SourceError('request-failed', `Jira 回复 ${response.status}，没有${action}。`)
  }
}

// Jira Cloud's REST API with an email + API token. A scoped token only works through the
// api.atlassian.com gateway, so a 401 on the site itself is retried there once.
export class JiraClient implements JiraApi {
  private base: string

  constructor(
    private readonly credentials: JiraCredentials,
    private readonly fetchImpl: typeof fetch = fetch
  ) {
    this.base = credentials.site
  }

  async myself(signal: AbortSignal): Promise<{ displayName: string }> {
    return parse(z.object({ displayName: z.string() }), await this.get('/rest/api/3/myself', signal))
  }

  async search(jql: string, signal: AbortSignal): Promise<SourceIssue[]> {
    const issues: SourceIssue[] = []
    let pageToken: string | null = null
    do {
      const query = new URLSearchParams({ jql, fields: SUMMARY_FIELDS, maxResults: String(PAGE_SIZE) })
      if (pageToken) {
        query.set('nextPageToken', pageToken)
      }
      const page = parse(SearchPage, await this.get(`/rest/api/3/search/jql?${query}`, signal))
      issues.push(...page.issues.flatMap((row) => summarize(this.credentials.site, row) ?? []))
      pageToken = page.isLast ? null : (page.nextPageToken ?? null)
    } while (pageToken && issues.length < SEARCH_LIMIT)
    return issues.slice(0, SEARCH_LIMIT)
  }

  async issue(key: string, signal: AbortSignal): Promise<JiraIssue> {
    const path = `/rest/api/3/issue/${encodeURIComponent(key)}`
    const row = parse(IssueDetail, await this.get(`${path}?${new URLSearchParams({ fields: ISSUE_FIELDS })}`, signal))
    const summary = summarize(this.credentials.site, row)
    if (!summary) {
      throw new SourceError('request-failed', 'Jira answered with a malformed issue key')
    }
    // The issue's own comment field is not guaranteed to hold the newest ones; this endpoint is.
    const query = new URLSearchParams({ orderBy: '-created', maxResults: String(COMMENT_LIMIT) })
    const page = parse(CommentPage, await this.get(`${path}/comment?${query}`, signal))
    const attachments = row.fields.attachment ?? []
    const structured = page.comments.map((comment) => SourceComment.safeParse(this.structuredComment(comment, key, attachments)))
    let state = structured.every((value) => value.success) ? commentState(structured.flatMap((value) => value.data ? [value.data] : [])) : undefined
    if (state && page.comments.length === COMMENT_LIMIT && page.comments.every((comment) => time(comment.created) === state?.checkpoint.createdAt)) {
      const complete = await this.commentChanges(key, signal, { checkpoint: { createdAt: state.checkpoint.createdAt, ids: [] }, continuation: null })
      state = { ...state, checkpoint: complete.checkpoint }
    }
    return {
      ...summary,
      ...(state ? { commentState: state } : {}),
      description: row.fields.description,
      comments: page.comments
        .map((comment) => ({ author: comment.author?.displayName ?? '', created: time(comment.created), body: comment.body }))
        .reverse(),
      commentTotal: page.total ?? page.comments.length,
      attachments: row.fields.attachment ?? []
    }
  }

  // An image pasted into a comment is an attachment of the issue, found by its file name as in the
  // description; the comment lists it by attachment id for Antumi to fetch when it is sent on.
  private structuredComment(comment: z.infer<typeof CommentPage>['comments'][number], key: string, attachments: readonly JiraAttachment[]) {
    const images: { id: string; name: string }[] = []
    const markdown = adfToMarkdown(comment.body, { describeMedia: (name) => {
      const file = attachments.find((attachment) => attachment.filename === name)
      const label = escapeLinkText(name ?? '文件')
      if (!file || !isImageAttachment(file)) return `（附件：${label}）`
      if (images.length < MAX_TASK_IMAGES && !images.some((image) => image.id === file.id)) images.push({ id: file.id, name: file.filename })
      return `（图片：${label}）`
    } })
    return { id: comment.id ?? '', author: comment.author?.displayName ?? '', createdAt: time(comment.created), updatedAt: time(comment.updated),
      url: `${this.credentials.site}/browse/${encodeURIComponent(key)}${comment.id ? `?focusedCommentId=${encodeURIComponent(comment.id)}` : ''}`, markdown: markdown.slice(0, 50_000), truncated: markdown.length > 50_000,
      ...(images.length ? { images } : {}) }
  }

  // The issue's attachments, asked for only when a comment holds a file to match against them.
  private async attachments(key: string, raw: readonly z.infer<typeof CommentPage>['comments'][number][], signal: AbortSignal): Promise<JiraAttachment[]> {
    if (!raw.some((comment) => JSON.stringify(comment.body ?? null).includes('"media'))) return []
    const query = new URLSearchParams({ fields: 'attachment' })
    return parse(AttachmentFields, await this.get(`/rest/api/3/issue/${encodeURIComponent(key)}?${query}`, signal)).fields.attachment ?? []
  }

  async commentChanges(key: string, signal: AbortSignal, options: SourceCommentOptions): Promise<SourceCommentPage> {
    if (!JIRA_KEY_PATTERN.test(key)) throw new SourceError('not-found', 'Invalid Jira issue key')
    const raw: z.infer<typeof CommentPage>['comments'] = []
    for (let startAt = 0; ; startAt += 100) {
      const query = new URLSearchParams({ orderBy: '-created', maxResults: '100', startAt: String(startAt) })
      const page = parse(CommentPage, await this.get(`/rest/api/3/issue/${encodeURIComponent(key)}/comment?${query}`, signal))
      raw.push(...page.comments)
      if (page.comments.length < 100 || (page.total != null && startAt + page.comments.length >= page.total) || page.comments.some((comment) => (time(comment.created) ?? Infinity) < options.checkpoint.createdAt)) break
      if (startAt >= 100_000) throw new SourceError('response-too-large', 'Comment history is too large')
    }
    const attachments = await this.attachments(key, raw, signal)
    const comments = raw.map((comment) => SourceComment.parse(this.structuredComment(comment, key, attachments)))
    return commentPage(comments, options)
  }

  // The transitions open to the issue now, as Jira lists them for this user; one leading back to the
  // current status (a self loop) is not a move, nor one whose screen asks for a field with no
  // default (a resolution, say), which Antumi cannot fill and Jira would refuse.
  async transitions(key: string, signal: AbortSignal): Promise<SourceTransitions> {
    const current = await this.status(key, signal)
    const path = `/rest/api/3/issue/${encodeURIComponent(key)}/transitions?expand=transitions.fields`
    const { transitions } = parse(TransitionList, await this.get(path, signal))
    const options = transitions.flatMap((transition) => {
      const to = transition.to
      const name = (to?.name ?? '').trim().slice(0, 100)
      const id = transition.id.slice(0, 500)
      const here = to?.id && current.id ? to.id === current.id : name === current.status
      const asks = Object.values(transition.fields ?? {}).some((field) => field.required && !field.hasDefaultValue)
      if (transition.isAvailable === false || !id || !name || here || asks) return []
      const action = transition.name.trim().slice(0, 100)
      return [{ id, name, ...(action && action.toLowerCase() !== name.toLowerCase() ? { action } : {}), category: statusOf(to).statusCategory }]
    })
    return { status: current.status, statusCategory: current.statusCategory, options: options.slice(0, MAX_OPTIONS) }
  }

  // Only a transition Jira offers right now: an id from an older list would fail with a vaguer 400.
  async transition(key: string, id: string, signal: AbortSignal): Promise<SourceStatusResult> {
    const { options } = await this.transitions(key, signal)
    const option = options.find((candidate) => candidate.id === id)
    if (!option) {
      throw new SourceError('request-failed', `${key} 现在不能这样流转，状态可能已在 Jira 里被改过，请刷新后重选。`)
    }
    const path = `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`
    const response = await this.send(path, signal, 'application/json', { method: 'POST', body: { transition: { id } } }, (failed) => writeFailure(failed, 'transition', key))
    await response.body?.cancel()
    // Post functions may move it on again; what Jira holds afterwards is the answer.
    const { status, statusCategory } = await this.status(key, signal)
    return { status, statusCategory }
  }

  async addComment(key: string, body: AdfDocument, signal: AbortSignal): Promise<SourceCommentResult> {
    if (!JIRA_KEY_PATTERN.test(key)) throw new SourceError('not-found', `${key} 不是 Jira 事项编号`)
    const path = `/rest/api/3/issue/${encodeURIComponent(key)}/comment`
    const response = await this.send(path, signal, 'application/json', { method: 'POST', body: { body } }, (failed) => writeFailure(failed, 'comment', key))
    const { id } = parse(CreatedComment, await readJson(response))
    // The same id and link comment sync gives this comment, so Antumi knows it for its own.
    return { id, url: `${this.credentials.site}/browse/${encodeURIComponent(key)}?focusedCommentId=${encodeURIComponent(id)}` }
  }

  private async status(key: string, signal: AbortSignal): Promise<SourceStatusResult & { id: string | null }> {
    if (!JIRA_KEY_PATTERN.test(key)) throw new SourceError('not-found', `${key} 不是 Jira 事项编号`)
    const query = new URLSearchParams({ fields: 'status' })
    const row = parse(IssueStatus, await this.get(`/rest/api/3/issue/${encodeURIComponent(key)}?${query}`, signal))
    return { ...statusOf(row.fields.status), id: row.fields.status?.id ?? null }
  }

  // Straight from the site, never through a redirect: the token must not follow one elsewhere.
  async download(attachmentId: string, limit: number, signal: AbortSignal): Promise<Uint8Array> {
    if (!/^\d+$/.test(attachmentId)) {
      throw new SourceError('request-failed', `not an attachment id: ${attachmentId}`)
    }
    const response = await this.send(`/rest/api/3/attachment/content/${attachmentId}?redirect=false`, signal, '*/*')
    return readBytes(response, limit)
  }

  private async get(pathAndQuery: string, signal: AbortSignal): Promise<unknown> {
    return readJson(await this.send(pathAndQuery, signal, 'application/json'))
  }

  // One successful response, trying the gateway once if the site turns the token down. A write is
  // safe to repeat there: a 401 means the site did nothing.
  private async send(pathAndQuery: string, signal: AbortSignal, accept: string, write?: Write, fail: (response: Response) => Promise<SourceError> = failure): Promise<Response> {
    const response = await this.request(`${this.base}${pathAndQuery}`, signal, accept, true, write)
    const gateway = response.status === 401 && this.base === this.credentials.site ? await this.gateway(signal) : null
    if (gateway) {
      await response.body?.cancel()
      const retried = await this.request(`${gateway}${pathAndQuery}`, signal, accept, true, write)
      if (!retried.ok) {
        throw await fail(retried)
      }
      this.base = gateway
      return retried
    }
    if (!response.ok) {
      throw await fail(response)
    }
    return response
  }

  // Loopback sites are test doubles, which have no gateway.
  private async gateway(signal: AbortSignal): Promise<string | null> {
    if (new URL(this.credentials.site).protocol !== 'https:') {
      return null
    }
    try {
      const response = await this.request(`${this.credentials.site}/_edge/tenant_info`, signal, 'application/json', false)
      if (!response.ok) {
        await response.body?.cancel()
        return null
      }
      const { cloudId } = parse(TenantInfo, await readJson(response))
      return `https://api.atlassian.com/ex/jira/${encodeURIComponent(cloudId)}`
    } catch {
      // No tenant info (a server install, a proxy in between): the original 401 stands.
      return null
    }
  }

  private async request(url: string, signal: AbortSignal, accept: string, authorized: boolean = true, write?: Write): Promise<Response> {
    const { email, token } = this.credentials
    const headers: Record<string, string> = { Accept: accept }
    if (authorized) {
      headers.Authorization = `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`
    }
    if (write) {
      headers['Content-Type'] = 'application/json'
    }
    try {
      return await this.fetchImpl(url, {
        ...(write ? { method: write.method, body: JSON.stringify(write.body) } : {}),
        headers,
        signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
        redirect: 'error'
      })
    } catch (error) {
      throw new SourceError('request-failed', error instanceof Error ? error.message : String(error))
    }
  }
}
