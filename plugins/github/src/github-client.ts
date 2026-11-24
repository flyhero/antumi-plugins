import { z } from 'zod'
import { commentState, commentPage, SourceComment, type SourceCommentState, type SourceCommentOptions, type SourceCommentPage } from '@antumi/plugin-sdk'
import { MAX_ISSUE_TITLE_LENGTH, MAX_TASK_IMAGES, type SourceIssue, type SourceCommentResult, type SourceStatusResult, type SourceTransitions } from '@antumi/plugin-sdk'
import { SourceError } from './source-error.js'
import { githubImages, type GitHubImage } from './github-images.js'
import { downloadGitHubImage } from './github-image-download.js'

export const GITHUB_KEY_PATTERN = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#([1-9][0-9]*)$/

export type GitHubCredentials = { token: string }
export type GitHubComment = { author: string; created: number | null; body: string }
export type GitHubIssue = SourceIssue & {
  images?: GitHubImage[]
  commentState?: SourceCommentState
  repository: string
  author: string
  body: string
  labels: string[]
  comments: GitHubComment[]
  commentTotal: number
}

export type GitHubApi = {
  download?(url: string, signal: AbortSignal): Promise<Uint8Array>
  commentImage?(key: string, id: string, signal: AbortSignal): Promise<{ name: string; bytes: Uint8Array }>
  commentChanges?(key: string, signal: AbortSignal, options: SourceCommentOptions): Promise<SourceCommentPage>
  myself(signal: AbortSignal): Promise<{ login: string }>
  search(query: string, signal: AbortSignal): Promise<SourceIssue[]>
  issue(key: string, signal: AbortSignal): Promise<GitHubIssue>
  transitions?(key: string, signal: AbortSignal): Promise<SourceTransitions>
  transition?(key: string, id: string, signal: AbortSignal): Promise<SourceStatusResult>
  comment?(key: string, markdown: string, signal: AbortSignal): Promise<SourceCommentResult>
}

const API = 'https://api.github.com'
const TIMEOUT_MS = 15_000
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024
const MAX_ERROR_BYTES = 64 * 1024
const SEARCH_LIMIT = 200
const PAGE_SIZE = 100
const COMMENT_LIMIT = 20
const COMMENT_PAGE_SIZE = 100
// GitHub's issue search refuses a query that does not pick issues or pull requests; one that
// picks neither is searched once for each.
const KIND_QUALIFIER = /(?:^|\s)(?:is|type):(?:issue|pr|pull-request)(?=\s|$)/i
const KINDS = ['is:issue', 'is:pull-request'] as const

const User = z.object({ login: z.string() })
const Label = z.union([z.string(), z.object({ name: z.string().nullish() })])
const IssueRow = z.object({
  number: z.number().int().positive(),
  title: z.string().nullish(),
  html_url: z.string(),
  state: z.enum(['open', 'closed']),
  state_reason: z.string().nullish(),
  updated_at: z.string().nullish(),
  body: z.string().nullish(),
  body_html: z.string().nullish(),
  user: User.nullish(),
  labels: z.array(Label).nullish(),
  comments: z.number().int().nonnegative().nullish(),
  pull_request: z.unknown().optional(),
  repository_url: z.string().optional(),
  repository: z.object({ full_name: z.string() }).optional()
})
const SearchPage = z.object({ items: z.array(IssueRow) })
const Comment = z.object({
  id: z.union([z.number().int(), z.string()]).optional(), updated_at: z.string().nullish(), html_url: z.string().optional(),
  body: z.string().nullish(),
  body_html: z.string().nullish(),
  issue_url: z.string().optional(),
  user: User.nullish(),
  created_at: z.string().nullish()
})
const ErrorBody = z.object({ message: z.string().optional() })
const CreatedComment = z.object({ id: z.union([z.number().int(), z.string().min(1)]), html_url: z.string().nullish() })
const PullRef = z.object({ merged_at: z.string().nullish() })

const WRITE_FORBIDDEN = 'GitHub Token 没有写权限，请换一个有写权限的 Token 重新登录：Fine-grained Token 需要 Issues 读写（Pull Request 还需要 Pull requests 读写），Classic Token 需要 repo（公开仓库可用 public_repo）。'

// What an issue or pull request can move to now. The ids are this plugin's own and come back in
// transition; names are the statuses list and fetch report after the move.
type Move = { id: string; name: string; action: string; category: 'todo' | 'done'; state: 'open' | 'closed'; reason?: 'completed' | 'not_planned' }
const REOPEN: Move = { id: 'reopen', name: 'open', action: 'Reopen', category: 'todo', state: 'open' }
const ISSUE_CLOSES: Move[] = [
  { id: 'close:completed', name: 'completed', action: 'Close as completed', category: 'done', state: 'closed', reason: 'completed' },
  { id: 'close:not_planned', name: 'not_planned', action: 'Close as not planned', category: 'done', state: 'closed', reason: 'not_planned' }
]
const PULL_CLOSE: Move = { id: 'close', name: 'closed', action: 'Close', category: 'done', state: 'closed' }

function moves(row: z.infer<typeof IssueRow>): Move[] {
  if (row.pull_request === undefined) return row.state === 'open' ? ISSUE_CLOSES : [REOPEN]
  if (row.state === 'open') return [PULL_CLOSE]
  // A merged pull request can no longer be reopened.
  return PullRef.safeParse(row.pull_request).data?.merged_at ? [] : [REOPEN]
}

function statusOf(row: z.infer<typeof IssueRow>): SourceStatusResult {
  return { status: row.state_reason ?? row.state, statusCategory: row.state === 'open' ? 'todo' : 'done' }
}

function issuePath(key: string): string {
  const match = GITHUB_KEY_PATTERN.exec(key)
  if (!match || ['.', '..'].includes(match[1] ?? '') || ['.', '..'].includes(match[2] ?? '')) throw new SourceError('not-found', 'Invalid GitHub issue key')
  return `/repos/${encodeURIComponent(match[1] ?? '')}/${encodeURIComponent(match[2] ?? '')}/issues/${match[3]}`
}

function structuredComment(comment: z.infer<typeof Comment>, url: string) {
  const images = githubImages(comment.body ?? '', comment.html_url ?? url, comment.body_html).slice(0, MAX_TASK_IMAGES)
    .map((image) => ({ id: `${comment.id}:${image.id}`, name: image.name }))
  return { id: comment.id === undefined ? '' : String(comment.id), author: comment.user?.login ?? '', createdAt: time(comment.created_at), updatedAt: time(comment.updated_at), url: comment.html_url ?? url, markdown: (comment.body ?? '').slice(0, 50_000), truncated: (comment.body?.length ?? 0) > 50_000, ...(images.length ? { images } : {}) }
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    throw new SourceError('request-failed', 'unexpected reply from GitHub')
  }
  return parsed.data
}

async function readBytes(response: Response, limit: number): Promise<Uint8Array> {
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel()
    throw new SourceError('response-too-large', `GitHub answered with more than ${limit} bytes`)
  }
  const reader = response.body?.getReader()
  if (!reader) return new Uint8Array()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) {
      await reader.cancel()
      throw new SourceError('response-too-large', `GitHub answered with more than ${limit} bytes`)
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}

async function readText(response: Response, limit: number): Promise<string> {
  return Buffer.from(await readBytes(response, limit)).toString('utf8')
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return JSON.parse(await readText(response, MAX_RESPONSE_BYTES))
  } catch (error) {
    if (error instanceof SourceError) throw error
    throw new SourceError('request-failed', 'GitHub did not answer with JSON')
  }
}

function time(value: string | null | undefined): number | null {
  const ms = value ? Date.parse(value) : Number.NaN
  return Number.isFinite(ms) ? ms : null
}

function labels(row: z.infer<typeof IssueRow>): string[] {
  return (row.labels ?? []).flatMap((label) => {
    const name = typeof label === 'string' ? label : label.name
    return name ? [name] : []
  })
}

function repositoryOf(row: z.infer<typeof IssueRow>): string | null {
  if (row.repository?.full_name) return row.repository.full_name
  try {
    const url = new URL(row.repository_url ?? '')
    const match = /^\/repos\/([^/]+)\/([^/]+)$/.exec(url.pathname)
    return match ? `${decodeURIComponent(match[1] ?? '')}/${decodeURIComponent(match[2] ?? '')}` : null
  } catch {
    return null
  }
}

function summarize(repository: string, row: z.infer<typeof IssueRow>): SourceIssue | null {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) return null
  const issueLabels = labels(row)
  const priority = issueLabels.find((label) => /^p[0-4]$/i.test(label) || /^priority(?:\s*[:=-]|$)/i.test(label)) ?? null
  return {
    key: `${repository}#${row.number}`,
    title: (row.title ?? '').slice(0, MAX_ISSUE_TITLE_LENGTH),
    url: row.html_url,
    ...statusOf(row),
    type: row.pull_request === undefined ? 'Issue' : 'Pull Request',
    priority,
    updatedAt: time(row.updated_at)
  }
}

async function failure(response: Response): Promise<SourceError> {
  let detail = ''
  try {
    detail = ErrorBody.parse(JSON.parse(await readText(response, MAX_ERROR_BYTES))).message ?? ''
  } catch {
    detail = ''
  }
  const message = detail || `GitHub answered ${response.status}`
  switch (response.status) {
    case 401:
      return new SourceError('auth-failed', message)
    case 403:
      return new SourceError('forbidden', message)
    case 404:
      return new SourceError('not-found', message)
    case 422:
      return new SourceError('bad-query', message)
    default:
      return new SourceError('request-failed', message)
  }
}

// A write follows a read of the same issue, so a 404 here means the token may read but not write
// (GitHub hides what a token cannot write behind 404 as well as 403).
async function writeFailure(response: Response): Promise<SourceError> {
  const error = await failure(response)
  if (response.status === 403 && (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after') || /rate limit/i.test(error.message))) {
    return new SourceError('request-failed', 'GitHub 请求过于频繁，请稍后重试')
  }
  if (response.status === 403 && /locked/i.test(error.message)) return new SourceError('request-failed', 'GitHub 上这个事项已锁定，无法写入')
  if (response.status === 403 || response.status === 404) return new SourceError('forbidden', WRITE_FORBIDDEN)
  if (response.status === 422) return new SourceError('request-failed', `GitHub 拒绝了这次写入：${error.message}`)
  return error
}

export class GitHubClient implements GitHubApi {
  constructor(
    private readonly credentials: GitHubCredentials,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly base: string = API
  ) {}

  async myself(signal: AbortSignal): Promise<{ login: string }> {
    return parse(User, await this.get('/user', signal))
  }

  async search(query: string, signal: AbortSignal): Promise<SourceIssue[]> {
    const queries = KIND_QUALIFIER.test(query) ? [query] : KINDS.map((kind) => `${query} ${kind}`)
    const issues: SourceIssue[] = []
    for (const q of queries) issues.push(...(await this.searchPages(q, signal)))
    return issues.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)).slice(0, SEARCH_LIMIT)
  }

  private async searchPages(q: string, signal: AbortSignal): Promise<SourceIssue[]> {
    const issues: SourceIssue[] = []
    for (let page = 1; issues.length < SEARCH_LIMIT; page += 1) {
      const query = new URLSearchParams({
        q,
        sort: 'updated',
        order: 'desc',
        per_page: String(PAGE_SIZE),
        page: String(page)
      })
      const found = parse(SearchPage, await this.get(`/search/issues?${query}`, signal))
      issues.push(
        ...found.items.flatMap((row) => {
          const repository = repositoryOf(row)
          const summary = repository ? summarize(repository, row) : null
          return summary ? [summary] : []
        })
      )
      if (found.items.length < PAGE_SIZE) break
    }
    return issues.slice(0, SEARCH_LIMIT)
  }

  async issue(key: string, signal: AbortSignal): Promise<GitHubIssue> {
    const match = GITHUB_KEY_PATTERN.exec(key)
    if (!match) throw new SourceError('not-found', `not a GitHub issue key: ${key}`)
    const [, owner = '', repo = '', number = ''] = match
    if (owner === '.' || owner === '..' || repo === '.' || repo === '..') {
      throw new SourceError('not-found', `not a GitHub issue key: ${key}`)
    }
    const repository = `${owner}/${repo}`
    const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}`
    const row = parse(IssueRow, await this.get(path, signal, 'application/vnd.github.full+json'))
    const summary = summarize(repository, row)
    if (!summary || summary.key !== key) {
      throw new SourceError('request-failed', 'GitHub answered with a mismatched issue')
    }
    const rawComments = await this.comments(path, row.comments ?? 0, signal)
    const structured = rawComments.map((comment) => SourceComment.safeParse(structuredComment(comment, summary.url)))
    const state = structured.every((value) => value.success) ? commentState(structured.flatMap((value) => value.data ? [value.data] : [])) : undefined
    const comments = rawComments.slice(-20)
      .map((comment) => ({ author: comment.user?.login ?? '', created: time(comment.created_at), body: comment.body ?? '' }))
    return {
      ...summary,
      images: [...new Map([
        ...githubImages(row.body ?? '', summary.url, row.body_html),
        ...rawComments.slice(-COMMENT_LIMIT).flatMap((comment) => githubImages(comment.body ?? '', comment.html_url ?? summary.url, comment.body_html))
      ].map((image) => [image.id, image])).values()],
      ...(state ? { commentState: state } : {}),
      repository,
      author: row.user?.login ?? '',
      body: row.body ?? '',
      labels: labels(row),
      comments,
      commentTotal: row.comments ?? comments.length
    }
  }

  async commentChanges(key: string, signal: AbortSignal, options: SourceCommentOptions): Promise<SourceCommentPage> {
    const path = issuePath(key)
    const row = parse(IssueRow, await this.get(path, signal))
    const comments: SourceComment[] = []
    for (let page = Math.max(1, Math.ceil((row.comments ?? 0) / COMMENT_PAGE_SIZE)); page >= 1; page--) {
      const rows = parse(z.array(Comment), await this.get(`${path}/comments?${new URLSearchParams({ per_page: String(COMMENT_PAGE_SIZE), page: String(page) })}`, signal, 'application/vnd.github.full+json'))
      for (const comment of rows) comments.push(SourceComment.parse(structuredComment(comment, row.html_url)))
      if (rows.some((comment) => (time(comment.created_at) ?? Infinity) < options.checkpoint.createdAt)) break
      if (page > 1000) throw new SourceError('response-too-large', 'Comment history is too large')
    }
    return commentPage(comments, options)
  }

  async transitions(key: string, signal: AbortSignal): Promise<SourceTransitions> {
    const row = parse(IssueRow, await this.get(issuePath(key), signal))
    return { ...statusOf(row), options: moves(row).map(({ id, name, action, category }) => ({ id, name, action, category })) }
  }

  async transition(key: string, id: string, signal: AbortSignal): Promise<SourceStatusResult> {
    const path = issuePath(key)
    const row = parse(IssueRow, await this.get(path, signal))
    const move = moves(row).find((candidate) => candidate.id === id)
    if (!move) throw new SourceError('request-failed', `GitHub 上的 ${key} 现在不能这样改状态，请刷新后重试`)
    if (row.pull_request === undefined) {
      const body = { state: move.state, ...(move.reason ? { state_reason: move.reason } : {}) }
      return statusOf(parse(IssueRow, await this.send('PATCH', path, body, signal)))
    }
    // Pull requests move through their own endpoint, which needs Pull requests write access.
    await this.send('PATCH', path.replace(/\/issues\/(\d+)$/, '/pulls/$1'), { state: move.state }, signal)
    return statusOf(parse(IssueRow, await this.get(path, signal)))
  }

  // GitHub takes the Markdown as it is.
  async comment(key: string, markdown: string, signal: AbortSignal): Promise<SourceCommentResult> {
    const path = issuePath(key)
    // Reading first tells a missing issue (not-found) from a token that cannot write (forbidden).
    parse(IssueRow, await this.get(path, signal))
    const created = parse(CreatedComment, await this.send('POST', `${path}/comments`, { body: markdown }, signal))
    return { id: String(created.id), url: created.html_url ?? null }
  }

  download(url: string, signal: AbortSignal): Promise<Uint8Array> {
    return downloadGitHubImage(url, this.credentials.token, signal, this.fetchImpl)
  }

  // Refresh a comment's signed URLs at delivery time instead of persisting expiring URLs as IDs.
  async commentImage(key: string, id: string, signal: AbortSignal): Promise<{ name: string; bytes: Uint8Array }> {
    const path = issuePath(key)
    const match = /^(\d+):([0-9a-f]{64})$/.exec(id)
    if (!match) throw new SourceError('not-found', 'Invalid GitHub comment image')
    const comment = parse(Comment, await this.get(`${path.replace(/\/issues\/\d+$/, '')}/issues/comments/${match[1]}`, signal, 'application/vnd.github.full+json'))
    if (!comment.issue_url || new URL(comment.issue_url).pathname.toLowerCase() !== path.toLowerCase()) throw new SourceError('not-found', 'The comment does not belong to this issue')
    const image = githubImages(comment.body ?? '', comment.html_url ?? `https://github.com/${key.replace('#', '/issues/')}`, comment.body_html).find((image) => image.id === match[2])
    if (!image) throw new SourceError('not-found', 'The image is no longer in the GitHub comment')
    return { name: image.name, bytes: await this.download(image.url, signal) }
  }

  private get(pathAndQuery: string, signal: AbortSignal, accept = 'application/vnd.github+json'): Promise<unknown> {
    return this.request('GET', pathAndQuery, signal, accept, undefined, failure)
  }

  private send(method: 'PATCH' | 'POST', path: string, body: unknown, signal: AbortSignal): Promise<unknown> {
    return this.request(method, path, signal, 'application/vnd.github+json', JSON.stringify(body), writeFailure)
  }

  private async request(method: string, pathAndQuery: string, signal: AbortSignal, accept: string, body: string | undefined, fail: (response: Response) => Promise<SourceError>): Promise<unknown> {
    let response: Response
    try {
      response = await this.fetchImpl(`${this.base}${pathAndQuery}`, {
        method,
        headers: {
          Accept: accept,
          Authorization: `Bearer ${this.credentials.token}`,
          'User-Agent': 'Antumi',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
        },
        ...(body === undefined ? {} : { body }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
        redirect: 'error'
      })
    } catch (error) {
      throw new SourceError('request-failed', error instanceof Error ? error.message : String(error))
    }
    if (!response.ok) throw await fail(response)
    return readJson(response)
  }

  private async comments(path: string, total: number, signal: AbortSignal): Promise<z.infer<typeof Comment>[]> {
    if (total === 0) return []
    const page = Math.ceil(total / COMMENT_PAGE_SIZE)
    const fetchPage = (number: number) => {
      const query = new URLSearchParams({ per_page: String(COMMENT_PAGE_SIZE), page: String(number) })
      return this.get(`${path}/comments?${query}`, signal, 'application/vnd.github.full+json').then((value) => parse(z.array(Comment), value))
    }
    const latest = await fetchPage(page)
    const previous = latest.length < COMMENT_LIMIT && page > 1 ? await fetchPage(page - 1) : []
    const combined = [...previous, ...latest]
    const newest = combined.at(-1)?.created_at
    if (combined.length >= COMMENT_LIMIT && newest && combined.every((comment) => comment.created_at === newest)) {
      for (let earlier = page - (previous.length ? 2 : 1); earlier >= 1; earlier--) {
        const rows = await fetchPage(earlier)
        combined.unshift(...rows)
        if (rows.some((comment) => comment.created_at !== newest)) break
      }
    }
    return combined
  }
}
