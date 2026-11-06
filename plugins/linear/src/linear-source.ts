import { SourceError, type SourceCredential, type SourcePlugin } from '@antumi/plugin-sdk'
import { LinearClient } from './linear-client.js'

const KEY = /^[A-Z][A-Z0-9_]*-[1-9][0-9]*$/

function token(credential: SourceCredential): string {
  if (credential.kind !== 'token' || !credential.payload.token) throw new SourceError('not-configured', '请先登录 Linear')
  return credential.payload.token
}

export function linearSource(connect = (key: string) => new LinearClient(key)): SourcePlugin {
  return {
    id: 'linear',
    normalizeSettings(values) {
      const team = values.team?.trim().toUpperCase() ?? ''
      const project = values.project?.trim() ?? ''
      const assignee = values.assignee === undefined ? '@me' : values.assignee.trim()
      const state = values.state || 'active'
      if (team && !/^[A-Z][A-Z0-9_]*$/.test(team)) throw new SourceError('invalid-settings', '请填写团队短标识，例如 ENG')
      if (project && !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(project)) throw new SourceError('invalid-settings', '项目 ID 必须是 UUID')
      if (assignee && assignee !== '@me' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(assignee)) throw new SourceError('invalid-settings', '指派给需要填写 @me、邮箱或留空')
      if (state !== 'active' && state !== 'all') throw new SourceError('invalid-settings', '不支持的状态范围')
      return { team, project, assignee, state }
    },
    normalizeKey(value) {
      const key = value.trim().toUpperCase()
      if (!KEY.test(key) || key.length > 160) throw new SourceError('not-found', '请输入 Linear 事项编号，例如 ENG-123')
      return key
    },
    envCredential: (env) => env.ANTUMI_LINEAR_TOKEN ? { kind: 'token', payload: { token: env.ANTUMI_LINEAR_TOKEN } } : null,
    async login(session, _settings, signal) {
      let error: string | undefined
      for (let attempt = 0; attempt < 3; attempt++) {
        const key = (await session.prompt({
          kind: 'secret', label: 'Linear API Key', error,
          hint: '创建具有 Read 权限的个人 API Key，可限制为指定团队。',
          link: { url: 'https://linear.app/settings/account/security', label: '创建 API Key' },
          translations: { en: { hint: 'Create a personal API key with Read access; optionally restrict it to specific teams.' } }
        })).trim()
        if (!key) { error = 'API Key 不能为空'; continue }
        try {
          const viewer = await connect(key).viewer(signal)
          return { credential: { kind: 'token', payload: { token: key } }, account: viewer.email || viewer.name }
        } catch (failure) {
          if (!(failure instanceof SourceError) || failure.code !== 'auth-failed' || attempt === 2) throw failure
          error = 'API Key 无效，请重新输入'
        }
      }
      throw new SourceError('auth-failed', 'Linear 登录失败')
    },
    comments: (_settings, credential, key, signal, options) => connect(token(credential)).commentChanges(key, signal, options),
    list: (settings, credential, signal) => connect(token(credential)).list(settings, signal),
    fetch: (settings, credential, key, signal) => {
      const normalized = key.trim().toUpperCase()
      if (!KEY.test(normalized)) throw new SourceError('not-found', '无效的 Linear 事项编号')
      return connect(token(credential)).issue(normalized, signal)
    }
  }
}
