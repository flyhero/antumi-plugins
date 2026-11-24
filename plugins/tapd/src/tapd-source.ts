import { SourceError, type SourceCredential, type SourcePlugin } from '@antumi/plugin-sdk'
import { TapdClient } from './tapd-client.js'
import { itemKey, itemKind, itemRef, parseKey, parseWorkspace } from './tapd-url.js'

function token(credential: SourceCredential): string {
  if (credential.kind !== 'token' || !credential.payload.token) throw new SourceError('not-configured', '请先登录 TAPD')
  return credential.payload.token
}

export function tapdSource(connect = (key: string) => new TapdClient(key)): SourcePlugin {
  return {
    id: 'tapd',
    normalizeSettings(values) {
      const workspace = parseWorkspace(values.workspace ?? '')
      const kind = itemKind(values.kind || 'story')
      if (!kind) throw new SourceError('invalid-settings', '不支持的 TAPD 事项类型')
      const assignee = values.assignee === undefined ? '@me' : values.assignee.trim()
      if (assignee.length > 100 || /[;,]/.test(assignee)) throw new SourceError('invalid-settings', '处理人只能填一个 TAPD 昵称')
      const state = values.state || 'active'
      if (state !== 'active' && state !== 'all') throw new SourceError('invalid-settings', '不支持的状态范围')
      return { workspace, kind, assignee, state }
    },
    normalizeKey: (value) => itemKey(itemRef(value)),
    envCredential: (env) => env.ANTUMI_TAPD_TOKEN ? { kind: 'token', payload: { token: env.ANTUMI_TAPD_TOKEN } } : null,
    async login(session, _settings, signal) {
      let error: string | undefined
      for (let attempt = 0; attempt < 3; attempt++) {
        const key = (await session.prompt({
          kind: 'secret', label: 'TAPD 个人访问令牌', hint: '在 TAPD 的「我的设置 → 个人访问令牌」创建，令牌只显示一次。', error,
          translations: { en: { label: 'TAPD personal access token', hint: 'Create one in TAPD under My Settings → Personal Access Token. It is shown only once.' } }
        })).trim()
        if (!key) { error = '令牌不能为空'; continue }
        try {
          const user = await connect(key).user(signal)
          return { credential: { kind: 'token', payload: { token: key } }, account: user.name && user.name !== user.nick ? `${user.name} (${user.nick})` : user.nick }
        } catch (failure) {
          if (!(failure instanceof SourceError) || failure.code !== 'auth-failed' || attempt === 2) throw failure
          error = '令牌无效或已失效，请重新输入'
        }
      }
      throw new SourceError('auth-failed', 'TAPD 登录失败')
    },
    list: (settings, credential, signal) => connect(token(credential)).list(settings, signal),
    fetch(settings, credential, key, signal) {
      const { kind, id } = parseKey(key)
      return connect(token(credential)).issue(parseWorkspace(settings.workspace ?? ''), kind, id, signal)
    },
    comments(settings, credential, key, signal, options) {
      const { kind, id } = parseKey(key)
      return connect(token(credential)).commentChanges(parseWorkspace(settings.workspace ?? ''), kind, id, signal, options)
    }
  }
}
