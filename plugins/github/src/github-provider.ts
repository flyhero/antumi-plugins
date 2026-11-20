import { GitHubClient, GITHUB_KEY_PATTERN, type GitHubApi, type GitHubCredentials } from './github-client.js'
import { githubIssueSnapshot } from './github-snapshot.js'
import { SourceError } from './source-error.js'
import { MAX_TASK_IMAGES, MAX_SOURCE_IMAGE_BYTES, type SourceCredential, type SourceFetchOptions, type SourcePlugin } from '@antumi/plugin-sdk'

export const DEFAULT_GITHUB_QUERY = 'assignee:@me is:open'

const TOKEN_PAGE = 'https://github.com/settings/personal-access-tokens'
const LOGIN_ATTEMPTS = 3

function githubCredentials(credential: SourceCredential): GitHubCredentials {
  const { token } = credential.payload
  if (credential.kind !== 'token' || !token) {
    throw new SourceError('not-configured', 'the saved GitHub credential is incomplete; sign in again')
  }
  return { token }
}

export function githubProvider(connect: (credentials: GitHubCredentials) => GitHubApi = (c) => new GitHubClient(c)) {
  const clients = new Map<string, GitHubApi>()
  const client = (credentials: GitHubCredentials): GitHubApi => {
    const cached = clients.get(credentials.token)
    if (cached) return cached
    if (clients.size >= 8) clients.clear()
    const created = connect(credentials)
    clients.set(credentials.token, created)
    return created
  }

  return {
    id: 'github',
    normalizeSettings: (values) => ({ query: values.query?.trim().split(/\s+/).join(' ') || DEFAULT_GITHUB_QUERY }),
    normalizeKey: (key) => key.trim(),
    envCredential: (env) => {
      const token = env.ANTUMI_GITHUB_TOKEN
      return token ? { kind: 'token', payload: { token } } : null
    },

    async login(session, _settings, signal) {
      let error: string | undefined
      for (let attempt = 1; ; attempt += 1) {
        const token = (
          await session.prompt({
            translations: { en: {
              hint: 'Needs access to your account and issues in accessible repositories. Your token stays on this computer and is never shared with Agents.',
              ...(error ? { error: 'Personal access token is invalid. Try again' } : {})
            } },
            kind: 'secret',
            label: 'Personal access token',
            hint: '需要读取账号和可访问仓库的 issue。token 只保存在本机，不会交给 Agent。',
            link: { url: TOKEN_PAGE, label: '在 GitHub 设置里创建', translations: { en: { label: 'Create in GitHub settings' } } },
            error
          })
        ).trim()
        try {
          const { login } = await client({ token }).myself(signal)
          return { credential: { kind: 'token', payload: { token } }, account: login }
        } catch (failure) {
          if (!(failure instanceof SourceError) || failure.code !== 'auth-failed' || attempt >= LOGIN_ATTEMPTS) throw failure
          error = 'Personal access token 不对，请重新输入'
        }
      }
    },

    comments: (settings, credential, key, signal, options) => {
      const api = client(githubCredentials(credential))
      if (!api.commentChanges) throw new SourceError('request-failed', 'Comment sync is unavailable')
      return api.commentChanges(key, signal, options)
    },
    image: (_settings, credential, key, id, signal) => {
      const api = client(githubCredentials(credential))
      if (!api.commentImage) throw new SourceError('request-failed', 'Comment images are unavailable')
      return api.commentImage(key, id, signal)
    },
    list: (settings, credential, signal) => client(githubCredentials(credential)).search(settings.query ?? DEFAULT_GITHUB_QUERY, signal),

    async fetch(_settings, credential, key, signal, options?: SourceFetchOptions) {
      if (!GITHUB_KEY_PATTERN.test(key)) throw new SourceError('not-found', `not a GitHub issue key: ${key}`)
      const api = client(githubCredentials(credential))
      const issue = await api.issue(key, signal)
      signal.throwIfAborted()
      const candidates = issue.images ?? []
      const wanted = candidates.slice(0, MAX_TASK_IMAGES)
      if (options?.images === false) return {
        ...issue, markdown: githubIssueSnapshot(issue, wanted.length ? `（${wanted.length} 张图片稍后下载）` : ''), images: [], imagesDeferred: wanted.length
      }
      const images: { name: string; bytes: Uint8Array }[] = []
      const downloading = AbortSignal.any([signal, AbortSignal.timeout(30_000)])
      let size = 0
      for (let at = 0; at < wanted.length && size < MAX_SOURCE_IMAGE_BYTES && !downloading.aborted; at += 3) {
        signal.throwIfAborted()
        const fetched = await Promise.all(wanted.slice(at, at + 3).map(async (image) => {
          try {
            const bytes = await api.download?.(image.url, downloading)
            return bytes ? { name: image.name, bytes } : null
          } catch {
            signal.throwIfAborted()
            return null
          }
        }))
        for (const image of fetched) {
          if (image && size + image.bytes.byteLength <= MAX_SOURCE_IMAGE_BYTES) { images.push(image); size += image.bytes.byteLength }
        }
      }
      signal.throwIfAborted()
      const lost = candidates.length - images.length
      const note = candidates.length ? `（已下载 ${images.length} 张图片${lost ? `；另有 ${lost} 张图片未能下载或超出数量、大小限制，原链接保留在正文中` : ''}）` : ''
      return { ...issue, markdown: githubIssueSnapshot(issue, note), images }
    }
  } satisfies SourcePlugin
}
