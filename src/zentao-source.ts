import { SourceError, type SourceCredential, type SourcePlugin } from '@antumi/plugin-sdk'
import { ZentaoClient, type ItemKind } from './zentao-client.js'

function kind(value: string | undefined): ItemKind {
  if (value === 'task' || value === 'bug' || value === 'story') return value
  throw new SourceError('invalid-settings', '不支持的禅道事项类型')
}

function token(credential: SourceCredential): string {
  if (credential.kind !== 'token' || !credential.payload.token) throw new SourceError('not-configured', '请先登录禅道')
  return credential.payload.token
}

export function normalizeApiBase(value: string): string {
  let url: URL
  try { url = new URL(value.trim()) } catch { throw new SourceError('invalid-settings', '请填写完整的禅道 REST API 地址') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !/\/api\.php\/v1\/?$/.test(url.pathname)) {
    throw new SourceError('invalid-settings', 'API 地址应以 /api.php/v1 结尾，且不能包含账号、密码或查询参数')
  }
  return url.href.replace(/\/$/, '')
}

export function zentaoSource(connect = (base: string, key: string) => new ZentaoClient(base, key)): SourcePlugin {
  return {
    id: 'zentao',
    normalizeSettings(values) {
      const apiBase = normalizeApiBase(values.apiBase ?? '')
      const selected = kind(values.kind || 'task')
      const scopeId = values.scopeId?.trim() ?? ''
      if (!/^[1-9][0-9]*$/.test(scopeId)) throw new SourceError('invalid-settings', '请填写有效的执行 / 产品 ID')
      const assignee = values.assignee === undefined ? '@me' : values.assignee.trim()
      const state = values.state || 'active'
      if (state !== 'active' && state !== 'all') throw new SourceError('invalid-settings', '不支持的状态范围')
      return { apiBase, kind: selected, scopeId, assignee, state }
    },
    normalizeKey(value) {
      const key = value.trim().toLowerCase()
      if (!/^(task|bug|story)-[1-9][0-9]*$/.test(key) || key.length > 160) throw new SourceError('not-found', '请输入 task-123、bug-123 或 story-123')
      return key
    },
    envCredential: (env) => env.ANTUMI_ZENTAO_TOKEN ? { kind: 'token', payload: { token: env.ANTUMI_ZENTAO_TOKEN } } : null,
    async login(session, settings, signal) {
      const base = normalizeApiBase(settings.apiBase ?? '')
      let error: string | undefined
      for (let attempt = 0; attempt < 3; attempt++) {
        const key = (await session.prompt({ kind: 'secret', label: '禅道 REST API Token', hint: '填写该禅道站点的 RESTful API v1 Token；过期后重新登录。', error, translations: { en: { label: 'ZenTao REST API token', hint: 'RESTful API v1 token for this site. Sign in again when it expires.' } } })).trim()
        if (!key) { error = 'Token 不能为空'; continue }
        try {
          const profile = await connect(base, key).profile(signal)
          return { credential: { kind: 'token', payload: { token: key } }, account: profile.realname ? `${profile.realname} (${profile.account})` : profile.account }
        } catch (failure) {
          if (!(failure instanceof SourceError) || failure.code !== 'auth-failed' || attempt === 2) throw failure
          error = 'Token 无效或已过期，请重新输入'
        }
      }
      throw new SourceError('auth-failed', '禅道登录失败')
    },
    list: (settings, credential, signal) => connect(normalizeApiBase(settings.apiBase ?? ''), token(credential)).list(kind(settings.kind), settings, signal),
    fetch(settings, credential, key, signal) {
      const match = /^(task|bug|story)-([1-9][0-9]*)$/.exec(key)
      if (!match) throw new SourceError('not-found', '无效的禅道事项编号')
      return connect(normalizeApiBase(settings.apiBase ?? ''), token(credential)).issue(kind(match[1]), match[2] ?? '', signal)
    }
  }
}
