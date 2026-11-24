import { SourceError, type SourceStatusResult, type SourceTransitions } from '@antumi/plugin-sdk'
import { category, statusName, type ItemKind, type ZentaoClient, type ZentaoRow } from './zentao-client.js'

// ZenTao moves an item by actions, each allowed from some statuses (the model's isClickable), not by
// editing its status. Only actions with a RESTful v1 endpoint are offered; cancelling a task has none.
type Move = {
  id: string
  action: string
  path: string
  to: string
  allowed(status: string, parent: boolean): boolean
  body?(row: ZentaoRow, action: string): Record<string, unknown>
}

const unfinished = (status: string) => !['done', 'closed', 'cancel'].includes(status)
const moves: Record<ItemKind, Move[]> = {
  task: [
    { id: 'start', action: '开始', path: 'start', to: 'doing', allowed: (status, parent) => !parent && status === 'wait', body: (row, action) => ({ consumed: row.consumed, left: remaining(row, action) }) },
    { id: 'pause', action: '暂停', path: 'pause', to: 'pause', allowed: (status) => status === 'doing' },
    { id: 'restart', action: '继续', path: 'restart', to: 'doing', allowed: (status) => status === 'pause', body: (row, action) => ({ consumed: row.consumed, left: remaining(row, action) }) },
    // No hours are made up: a task with nothing logged is refused by ZenTao, and says so.
    { id: 'finish', action: '完成', path: 'finish', to: 'done', allowed: (status, parent) => !parent && unfinished(status), body: finishing },
    { id: 'close', action: '关闭', path: 'close', to: 'closed', allowed: (status, parent) => status === 'done' || status === 'cancel' || (parent && status !== 'closed') },
    { id: 'activate', action: '激活', path: 'active', to: 'doing', allowed: (status, parent) => !parent && !unfinished(status), body: (row, action) => ({ left: remaining(row, action) }) }
  ],
  bug: [
    // trunk (主干) stands in for the build ZenTao requires with a fixed resolution.
    { id: 'resolve', action: '解决', path: 'resolve', to: 'resolved', allowed: (status) => status === 'active', body: () => ({ resolution: 'fixed', resolvedBuild: 'trunk' }) },
    { id: 'close', action: '关闭', path: 'close', to: 'closed', allowed: (status) => status === 'resolved' },
    { id: 'activate', action: '激活', path: 'active', to: 'active', allowed: (status) => status !== 'active' }
  ],
  story: [
    { id: 'close', action: '关闭', path: 'close', to: 'closed', allowed: (status) => status !== 'closed', body: () => ({ closedReason: 'done' }) },
    { id: 'activate', action: '激活', path: 'active', to: 'active', allowed: (status) => status === 'closed' }
  ]
}

// Starting with nothing left makes ZenTao finish the task at once, so a positive estimate is needed.
function remaining(row: ZentaoRow, action: string): number {
  const left = row.left > 0 ? row.left : row.estimate
  if (left > 0) return left
  throw new SourceError('request-failed', `任务没有预计剩余工时，无法「${action}」，请到禅道里填写后操作`)
}

function finishing(row: ZentaoRow): Record<string, unknown> {
  const now = localTime(new Date())
  // ZenTao fills in the start time it recorded; a task finished before it was started has none.
  return { currentConsumed: 0, finishedDate: now, ...(row.realStarted ? {} : { realStarted: now }) }
}

// ZenTao's forms take the server's local wall time.
function localTime(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function isParent(row: ZentaoRow): boolean {
  return row.isParent === true || row.isParent === 1 || row.isParent === '1' || Number(row.parent) === -1
}

function available(kind: ItemKind, row: ZentaoRow): Move[] {
  return moves[kind].filter((move) => move.to !== row.status && move.allowed(row.status, isParent(row)))
}

export async function transitions(client: ZentaoClient, kind: ItemKind, id: string, signal: AbortSignal): Promise<SourceTransitions> {
  const row = await client.row(kind, id, signal)
  return {
    status: statusName(kind, row.status), statusCategory: category(kind, row.status),
    options: available(kind, row).map((move) => {
      const name = statusName(kind, move.to)
      return { id: move.id, name, ...(move.action === name ? {} : { action: move.action }), category: category(kind, move.to) }
    })
  }
}

export async function transition(client: ZentaoClient, kind: ItemKind, id: string, option: string, signal: AbortSignal): Promise<SourceStatusResult> {
  const row = await client.row(kind, id, signal)
  const move = available(kind, row).find((candidate) => candidate.id === option)
  if (!move) throw new SourceError('request-failed', '禅道事项当前不能执行这个操作，请刷新状态后重试')
  const titles: Record<ItemKind, string> = { task: '任务', bug: 'Bug', story: '需求' }
  const status = await client.act(kind, id, move.path, move.body?.(row, move.action) ?? {}, `${titles[kind]}-${move.action}`, signal)
  return { status: statusName(kind, status), statusCategory: category(kind, status) }
}
