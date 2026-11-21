import { SourceError } from '@antumi/plugin-sdk'

// Feishu Project and Meegle are one product on two account systems; the address picks the one.
const HOSTS: ReadonlyMap<string, string> = new Map([
  ['project.feishu.cn', 'project.feishu.cn'],
  ['project.larksuite.com', 'project.larksuite.com'],
  ['meegle.com', 'meegle.com'],
  ['www.meegle.com', 'meegle.com']
])
// First path segments that are product pages rather than a space (meegle-cli url_rules.go).
const RESERVED = new Set(['b', 'workbench', 'list', 'setting', 'settings', 'chart', 'user-gantt', 'userGantt', 'multiProjectView', 'project-overview', 'mcp_server', 'open_api', 'goapi'])
const SIMPLE_NAME = /^[A-Za-z0-9_-]{1,100}$/

export type Space = { host: string, simpleName: string }

export function parseSpace(value: string): Space {
  let url: URL
  try { url = new URL(value.trim()) } catch { throw new SourceError('invalid-settings', '请粘贴飞书项目或 Meegle 空间的网页地址') }
  const host = HOSTS.get(url.hostname.toLowerCase())
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !host) {
    throw new SourceError('invalid-settings', '空间地址应以 https://project.feishu.cn、https://project.larksuite.com 或 https://meegle.com 开头')
  }
  const segments = url.pathname.split('/').filter(Boolean)
  if (segments[0] === 'meego') segments.shift()
  const simpleName = segments[0] ?? ''
  if (!SIMPLE_NAME.test(simpleName) || RESERVED.has(simpleName)) throw new SourceError('invalid-settings', '地址里找不到空间，请在空间里打开任意页面再复制地址')
  return { host, simpleName }
}

export const spaceUrl = (space: Space): string => `https://${space.host}/${space.simpleName}`

export const configPage = (host: string): string => `https://${host}/b/mcp`

export function itemUrl(space: Space, routeName: string, id: string): string {
  return `https://${space.host}/${encodeURIComponent(space.simpleName)}/${encodeURIComponent(routeName)}/detail/${id}`
}

// A work item ID is unique across spaces, so it alone is the key; links and `#123` are accepted too.
export function itemId(value: string): string {
  const text = value.trim()
  const id = /\/detail\/([1-9][0-9]{0,18})(?:[/?#]|$)/.exec(text)?.[1] ?? /^#?([1-9][0-9]{0,18})$/.exec(text)?.[1]
  if (!id) throw new SourceError('not-found', '请输入工作项 ID 或工作项详情页的地址')
  return id
}
