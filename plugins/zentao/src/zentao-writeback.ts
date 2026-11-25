import { SourceError, type SourceStatusResult, type SourceTransitions, type SourceUser } from '@antumi/plugin-sdk'
import { category, person, scope, statusName, titles, type ItemKind, type ZentaoClient, type ZentaoRow } from './zentao-client.js'

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

function multiPerson(row: ZentaoRow): boolean {
  const team = Array.isArray(row.team) ? row.team.length : row.team && typeof row.team === 'object' ? Object.keys(row.team).length : 0
  return !!row.mode || team > 0
}

// Who the item is with, or undefined when ZenTao does not say. A multi-person task has no single
// assignedTo. A closed item goes to the pseudo account closed, which newer versions answer as
// null, the same as no one, so the status has to rule it out.
function assignees(kind: ItemKind, row: ZentaoRow): SourceUser[] | undefined {
  if (row.assignedTo === undefined || row.status === 'closed' || (kind === 'task' && multiPerson(row))) return undefined
  if (row.assignedTo === null || row.assignedTo === '') return []
  const user = person(row.assignedTo)
  return !user || user.id === 'closed' ? undefined : [user]
}

// Besides the moves, the facts Antumi tells ownership by; what to make of them is Antumi's.
export async function transitions(client: ZentaoClient, kind: ItemKind, id: string, signal: AbortSignal): Promise<SourceTransitions> {
  const [row, viewer] = await Promise.all([
    client.row(kind, id, signal),
    // Moving a status must not depend on reading the account: without it ownership is unknown.
    client.profile(signal).then(person, (error: unknown) => { if (error instanceof SourceError) return null; throw error })
  ])
  const assigned = assignees(kind, row)
  const within = scope(kind, row)
  return {
    status: statusName(kind, row.status), statusCategory: category(kind, row.status),
    options: available(kind, row).map((move) => {
      const name = statusName(kind, move.to)
      return { id: move.id, name, ...(move.action === name ? {} : { action: move.action }), category: category(kind, move.to), toStatusId: move.to }
    }),
    ...(row.status && row.status.length <= 500 ? { statusId: row.status } : {}),
    ...(viewer ? { viewer } : {}),
    ...(assigned ? { assignees: assigned } : {}),
    ...(row.openedBy === undefined ? {} : { reporter: person(row.openedBy) }),
    type: { id: kind, name: titles[kind] },
    ...(within ? { scope: within } : {})
  }
}

export async function transition(client: ZentaoClient, kind: ItemKind, id: string, option: string, signal: AbortSignal): Promise<SourceStatusResult> {
  const row = await client.row(kind, id, signal)
  const move = available(kind, row).find((candidate) => candidate.id === option)
  if (!move) throw new SourceError('request-failed', '禅道事项当前不能执行这个操作，请刷新状态后重试')
  const status = await client.act(kind, id, move.path, move.body?.(row, move.action) ?? {}, `${titles[kind]}-${move.action}`, signal)
  return { status: statusName(kind, status), statusCategory: category(kind, status) }
}
