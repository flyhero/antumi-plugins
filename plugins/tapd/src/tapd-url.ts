import { SourceError } from '@antumi/plugin-sdk'

export const API = 'https://api.tapd.cn'
export const WEB = 'https://www.tapd.cn'
export type ItemKind = 'story' | 'bug' | 'task'
export type ItemRef = { kind: ItemKind, id: string }

const WEB_HOSTS = new Set(['www.tapd.cn', 'tapd.cn'])
const WORKSPACE = /^[1-9][0-9]{0,14}$/
const ID = '([1-9][0-9]{0,18})'

export function itemKind(value: string | undefined): ItemKind | undefined {
  switch (value?.toLowerCase()) {
    case 'story': case 'stories': return 'story'
    case 'bug': case 'bugs': return 'bug'
    case 'task': case 'tasks': return 'task'
    default: return undefined
  }
}

function webUrl(value: string): URL | null {
  let url: URL
  try { url = new URL(value) } catch { return null }
  return url.protocol === 'https:' && WEB_HOSTS.has(url.hostname.toLowerCase()) && !url.username && !url.password && !url.port ? url : null
}

export function parseWorkspace(value: string): string {
  const text = value.trim()
  if (WORKSPACE.test(text)) return text
  const segments = webUrl(text)?.pathname.split('/').filter(Boolean) ?? []
  // Classic pages start with the project; the newer front end puts it after tapd_fe, and lightweight projects after tapd_fe/t/index.
  const candidate = segments[0] !== 'tapd_fe' ? segments[0] : segments[1] === 't' && segments[2] === 'index' ? segments[3] : segments[1]
  if (!candidate || !WORKSPACE.test(candidate)) throw new SourceError('invalid-settings', '请填写 TAPD 项目 ID，或粘贴项目里任意页面的地址')
  return candidate
}

export function itemUrl(workspace: string, kind: ItemKind, id: string, lightweight: boolean): string {
  if (lightweight && kind === 'story') return `${WEB}/tapd_fe/t/index/${workspace}?workitemId=${id}`
  const path = kind === 'story' ? 'prong/stories' : kind === 'task' ? 'prong/tasks' : 'bugtrace/bugs'
  return `${WEB}/${workspace}/${path}/view/${id}`
}

export const itemKey = (ref: ItemRef): string => `${ref.kind}-${ref.id}`

export function parseKey(value: string): ItemRef {
  const match = new RegExp(`^(story|bug|task)-${ID}$`).exec(value)
  const kind = itemKind(match?.[1])
  if (!kind || !match?.[2]) throw new SourceError('not-found', '无效的 TAPD 事项编号')
  return { kind, id: match[2] }
}

// What a user pastes to import one item: its key, or the address of its page in either front end.
export function itemRef(value: string): ItemRef {
  const text = value.trim()
  const key = new RegExp(`^(story|bug|task)-${ID}$`, 'i').exec(text)
  const url = key ? null : webUrl(text)
  const path = url?.pathname.replace(/\/+$/, '') ?? ''
  const classic = new RegExp(`/(?:prong|bugtrace)/(stories|tasks|bugs)/view/${ID}$`).exec(path)
  const modern = new RegExp(`^/tapd_fe/[0-9]+/(story|bug|task)/detail/${ID}$`).exec(path)
  const found: [string | undefined, string | null | undefined] =
    key ? [key[1], key[2]]
    : classic ? [classic[1], classic[2]]
    : modern ? [modern[1], modern[2]]
    : path.endsWith('/bugtrace/bugs/view') ? ['bug', url?.searchParams.get('bug_id')]
    : path.startsWith('/tapd_fe/t/index/') ? ['story', url?.searchParams.get('workitemId')]
    : [undefined, undefined]
  const kind = itemKind(found[0])
  const id = found[1]
  if (!kind || !id || !new RegExp(`^${ID}$`).test(id)) throw new SourceError('not-found', '请输入 story-编号、bug-编号、task-编号，或 TAPD 事项详情页的地址')
  return { kind, id }
}
