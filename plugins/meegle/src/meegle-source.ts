import { SourceError, type SourceCredential, type SourcePlugin, type SourceSettings } from '@antumi/plugin-sdk'
import { McpSession } from './mcp-session.js'
import { MeegleClient } from './meegle-client.js'
import { normalizeFilter } from './meegle-mql.js'
import { configPage, itemId, parseSpace, spaceUrl, type Space } from './meegle-url.js'

const TOKEN = /^m-[A-Za-z0-9_.-]{8,200}$/

function types(value: string | undefined): string[] {
  const keys = [...new Set((value || 'story,issue').split(',').map((key) => key.trim()).filter(Boolean))]
  if (!keys.length || keys.length > 10 || keys.some((key) => !/^[A-Za-z0-9_.-]{1,100}$/.test(key))) {
    throw new SourceError('invalid-settings', '请填写 1 到 10 个工作项类型 key，用逗号分隔，例如 story,issue')
  }
  return keys
}

// A token is used only on the site it was checked against; an environment token goes to the space's.
function token(credential: SourceCredential, space: Space): string {
  const { token: value, host } = credential.payload
  if (credential.kind !== 'token' || !value) throw new SourceError('not-configured', '请先登录飞书项目')
  if (host && host !== space.host) throw new SourceError('not-configured', '空间换了站点，请重新登录')
  return value
}

export function meegleSource(connect = (host: string, key: string) => new MeegleClient(new McpSession(host, key))): SourcePlugin {
  const client = (settings: SourceSettings, credential: SourceCredential) => {
    const space = parseSpace(settings.space ?? '')
    return { space, client: connect(space.host, token(credential, space)) }
  }
  return {
    id: 'meegle',
    normalizeSettings(values) {
      return { space: spaceUrl(parseSpace(values.space ?? '')), types: types(values.types).join(','), filter: normalizeFilter(values.filter) }
    },
    normalizeKey: itemId,
    envCredential: (env) => env.ANTUMI_MEEGLE_TOKEN ? { kind: 'token', payload: { token: env.ANTUMI_MEEGLE_TOKEN.trim() } } : null,
    async login(session, settings, signal) {
      const { host } = parseSpace(settings.space ?? '')
      const page = configPage(host)
      let error: string | undefined
      for (let attempt = 0; attempt < 3; attempt++) {
        const value = (await session.prompt({
          kind: 'secret', label: 'MCP Token', placeholder: 'm-…', error,
          hint: '在 MCP 配置页打开个人偏好里的 MCP 开关，数据权限只勾「允许查看数据信息」，然后复制 Token。',
          link: { url: page, label: '打开 MCP 配置页', translations: { en: { label: 'Open MCP settings' } } },
          translations: { en: { label: 'MCP token', hint: 'On the MCP settings page, turn on MCP in your personal preferences, allow viewing data only, then copy the token.' } }
        })).trim()
        if (!TOKEN.test(value)) { error = 'Token 应以 m- 开头，请从 MCP 配置页复制'; continue }
        try {
          const account = await connect(host, value).user(signal)
          return { credential: { kind: 'token', payload: { token: value, host } }, account }
        } catch (failure) {
          if (!(failure instanceof SourceError) || failure.code !== 'auth-failed' || attempt === 2) throw failure
          error = failure.message
        }
      }
      throw new SourceError('auth-failed', '飞书项目登录失败')
    },
    async list(settings, credential, signal) {
      const { space, client: meegle } = client(settings, credential)
      return meegle.list(space, { types: types(settings.types), filter: normalizeFilter(settings.filter) }, signal)
    },
    async fetch(settings, credential, key, signal) {
      const { space, client: meegle } = client(settings, credential)
      return meegle.issue(space, itemId(key), signal)
    }
  }
}
