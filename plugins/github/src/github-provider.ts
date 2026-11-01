import { GitHubClient, GITHUB_KEY_PATTERN, type GitHubApi, type GitHubCredentials } from './github-client.js'
import { githubIssueSnapshot } from './github-snapshot.js'
import { SourceError } from './source-error.js'
import type { SourceCredential, SourcePlugin } from '@antumi/plugin-sdk'

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

    list: (settings, credential, signal) => client(githubCredentials(credential)).search(settings.query ?? DEFAULT_GITHUB_QUERY, signal),

    async fetch(_settings, credential, key, signal) {
      if (!GITHUB_KEY_PATTERN.test(key)) throw new SourceError('not-found', `not a GitHub issue key: ${key}`)
      const issue = await client(githubCredentials(credential)).issue(key, signal)
      return { ...issue, markdown: githubIssueSnapshot(issue) }
    }
  } satisfies SourcePlugin
}
