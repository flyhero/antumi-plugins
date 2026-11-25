import { PluginManifest } from '@antumi/plugin-sdk'
import { describe, expect, it, vi } from 'vitest'
import { ZentaoClient } from './zentao-client.js'
import { zentaoSource } from './zentao-source.js'
import manifest from '../manifest.json' with { type: 'json' }

const signal = new AbortController().signal
const base = 'https://example.com/zentao/api.php/v1'
const settings = { apiBase: base, kind: 'task', scopeId: '1' }
const credential = { kind: 'token' as const, payload: { token: 'secret-token' } }
const task = { id: 12, name: 'Fix login', status: 'wait', left: 3, estimate: 4, consumed: 0, realStarted: null }
const ann = { id: 'ann', name: 'Ann' }
const bob = { id: 'bob', name: 'Bob' }

// The account is read alongside the item and answered here, so replies are the item's own calls.
function source(...replies: Response[]) {
  const fetcher = vi.fn<typeof fetch>()
  for (const reply of replies) fetcher.mockResolvedValueOnce(reply)
  const routed: typeof fetch = async (url, init) => String(url).endsWith('/user') ? Response.json({ profile: { account: 'ann', realname: 'Ann' } }) : fetcher(url, init)
  return { fetcher, source: zentaoSource((url, key) => new ZentaoClient(url, key, routed)) }
}

async function facts(key: string, row: Record<string, unknown>) {
  const result = await source(Response.json({ ...task, ...row })).source.transitions?.(settings, credential, key, signal)
  if (!result) throw new Error('no transitions')
  return result
}

function body(call: Parameters<typeof fetch> | undefined): unknown {
  const init = call?.[1]
  return typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
}

describe('ZenTao writeback', () => {
  it('offers the actions the current status allows, named by the status they lead to', async () => {
    const { source: waiting } = source(Response.json(task))
    expect(await waiting.transitions?.(settings, credential, 'task-12', signal)).toEqual({
      status: '未开始', statusCategory: 'todo', statusId: 'wait',
      options: [
        { id: 'start', name: '进行中', action: '开始', category: 'doing', toStatusId: 'doing' },
        { id: 'finish', name: '已完成', action: '完成', category: 'done', toStatusId: 'done' }
      ],
      viewer: ann, type: { id: 'task', name: '任务' }
    })
    const { source: done } = source(Response.json({ ...task, status: 'done' }))
    expect((await done.transitions?.(settings, credential, 'task-12', signal))?.options.map((option) => option.id)).toEqual(['close', 'activate'])
    // A parent task only pauses, resumes and closes.
    const { source: parent } = source(Response.json({ ...task, status: 'doing', isParent: 1 }))
    expect((await parent.transitions?.(settings, credential, 'task-12', signal))?.options.map((option) => option.id)).toEqual(['pause', 'close'])
  })

  it('maps bug and story actions, leaving out an action named like its status', async () => {
    const { source: bug } = source(Response.json({ ...task, title: 'Crash', status: 'resolved' }))
    expect(await bug.transitions?.(settings, credential, 'bug-12', signal)).toEqual({
      status: '已解决', statusCategory: 'done', statusId: 'resolved',
      options: [
        { id: 'close', name: '已关闭', action: '关闭', category: 'done', toStatusId: 'closed' },
        { id: 'activate', name: '激活', category: 'todo', toStatusId: 'active' }
      ],
      viewer: ann, type: { id: 'bug', name: 'Bug' }
    })
    const { source: story } = source(Response.json({ ...task, title: 'Login', status: 'active' }))
    expect(await story.transitions?.(settings, credential, 'story-12', signal)).toMatchObject({
      status: '激活', options: [{ id: 'close', name: '已关闭', action: '关闭', category: 'done' }]
    })
  })

  it('starts a task with its hours and reports the status ZenTao answers with', async () => {
    const { fetcher, source: zentao } = source(Response.json(task), Response.json({ ...task, status: 'doing' }))
    expect(await zentao.transition?.(settings, credential, 'task-12', 'start', signal)).toEqual({ status: '进行中', statusCategory: 'doing' })
    expect(fetcher.mock.calls[1]).toMatchObject([`${base}/tasks/12/start`, { method: 'POST', headers: { Token: 'secret-token', 'Content-Type': 'application/json' }, redirect: 'error' }])
    expect(body(fetcher.mock.calls[1])).toEqual({ consumed: 0, left: 3 })
  })

  it('resolves a bug as fixed in trunk, finishes a task and closes a story as done', async () => {
    const bug = source(Response.json({ ...task, status: 'active' }), Response.json({ ...task, status: 'resolved' }))
    expect(await bug.source.transition?.(settings, credential, 'bug-12', 'resolve', signal)).toEqual({ status: '已解决', statusCategory: 'done' })
    expect(bug.fetcher.mock.calls[1]?.[0]).toBe(`${base}/bugs/12/resolve`)
    expect(body(bug.fetcher.mock.calls[1])).toEqual({ resolution: 'fixed', resolvedBuild: 'trunk' })

    const finish = source(Response.json({ ...task, status: 'doing', consumed: 2, realStarted: '2026-11-01T00:00:00Z' }), Response.json({ ...task, status: 'done' }))
    await finish.source.transition?.(settings, credential, 'task-12', 'finish', signal)
    expect(body(finish.fetcher.mock.calls[1])).toEqual({ currentConsumed: 0, finishedDate: expect.stringMatching(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/) })

    // Reads the story back when the action's answer has no plain status.
    const story = source(Response.json({ ...task, status: 'active' }), Response.json({ result: 'success' }), Response.json({ ...task, status: 'closed' }))
    expect(await story.source.transition?.(settings, credential, 'story-12', 'close', signal)).toEqual({ status: '已关闭', statusCategory: 'done' })
    expect(body(story.fetcher.mock.calls[1])).toEqual({ closedReason: 'done' })
    expect(story.fetcher).toHaveBeenCalledTimes(3)
  })

  it('rejects an action the status does not allow without calling it', async () => {
    const { fetcher, source: zentao } = source(Response.json({ ...task, status: 'closed' }))
    await expect(zentao.transition?.(settings, credential, 'task-12', 'start', signal)).rejects.toMatchObject({ code: 'request-failed' })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('refuses to start a task with no hours left rather than finishing it', async () => {
    const { fetcher, source: zentao } = source(Response.json({ ...task, left: 0, estimate: 0 }))
    await expect(zentao.transition?.(settings, credential, 'task-12', 'start', signal)).rejects.toThrow('预计剩余')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('names the missing privilege, passes on ZenTao reasons and keeps tokens out of errors', async () => {
    const denied = source(Response.json(task), Response.json({ error: 'Access not allowed' }, { status: 403 }))
    const failure = await denied.source.transition?.(settings, credential, 'task-12', 'start', signal).catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: 'forbidden', message: expect.stringContaining('任务-开始') })
    expect(String(failure)).toContain('重新登录')

    const refused = source(Response.json({ ...task, status: 'doing' }), Response.json({ error: { currentConsumed: ['<p>总计消耗为0时不能完成任务</p>'] }, token: 'secret-token' }, { status: 400 }))
    const reason = await refused.source.transition?.(settings, credential, 'task-12', 'finish', signal).catch((error: unknown) => error)
    expect(reason).toMatchObject({ code: 'request-failed', message: '禅道拒绝了这次操作：总计消耗为0时不能完成任务' })

    const missing = source(new Response('secret-token', { status: 404 }))
    const gone = await missing.source.transitions?.(settings, credential, 'task-99', signal).catch((error: unknown) => error)
    expect(gone).toMatchObject({ code: 'not-found' })
    expect(String(gone)).not.toContain('secret-token')
  })

  it('reports whose a task is, by account, with its type and execution', async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) => String(url).endsWith('/user')
      ? Response.json({ profile: { account: 'ann', realname: 'Ann' } })
      : Response.json({ ...task, assignedTo: { id: 3, account: 'ann', realname: 'Ann' }, openedBy: { account: 'bob', realname: 'Bob' }, execution: 42, executionName: 'Sprint 12' }))
    const zentao = zentaoSource((url, key) => new ZentaoClient(url, key, fetcher))
    expect(await zentao.transitions?.(settings, credential, 'task-12', signal)).toEqual({
      status: '未开始', statusCategory: 'todo', statusId: 'wait',
      options: [
        { id: 'start', name: '进行中', action: '开始', category: 'doing', toStatusId: 'doing' },
        { id: 'finish', name: '已完成', action: '完成', category: 'done', toStatusId: 'done' }
      ],
      viewer: ann, assignees: [ann], reporter: bob, type: { id: 'task', name: '任务' }, scope: { id: '42', name: 'Sprint 12' }
    })
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([`${base}/tasks/12`, `${base}/user`])
    for (const [, init] of fetcher.mock.calls) expect(init).toMatchObject({ headers: { Token: 'secret-token' }, redirect: 'error', signal: expect.any(AbortSignal) })
  })

  it('reads an assignee and a creator given as a bare account, and no one as an empty list', async () => {
    expect(await facts('task-12', { assignedTo: 'bob', openedBy: 'ann' })).toMatchObject({ viewer: ann, assignees: [{ id: 'bob', name: 'bob' }], reporter: { id: 'ann', name: 'ann' } })
    expect(await facts('task-12', { assignedTo: { account: 'bob' } })).toMatchObject({ assignees: [{ id: 'bob', name: 'bob' }] })
    expect((await facts('task-12', { assignedTo: '' })).assignees).toEqual([])
    expect((await facts('bug-12', { status: 'active', assignedTo: null, openedBy: null })).assignees).toEqual([])
  })

  it('leaves the assignees out when ZenTao does not say who has the item', async () => {
    const unknown = [
      // Multi-person tasks: assignedTo is blank, or only the one whose turn it is.
      ['task-12', { assignedTo: '', mode: 'multi' }],
      ['task-12', { assignedTo: 'ann', mode: 'linear', team: [{ account: 'ann' }, { account: 'bob' }] }],
      ['task-12', { assignedTo: '', mode: '', team: { ann: { account: 'ann' }, bob: { account: 'bob' } } }],
      // The pseudo account of a closed item, which newer versions answer as null.
      ['task-12', { status: 'closed', assignedTo: 'closed' }],
      ['bug-12', { status: 'closed', assignedTo: { account: 'closed', realname: 'Closed' } }],
      ['story-12', { status: 'closed', assignedTo: null }],
      ['task-12', { assignedTo: { realname: 'No account' } }],
      ['task-12', {}]
    ] as const
    for (const [key, row] of unknown) {
      const result = await facts(key, row)
      expect(result, JSON.stringify(row)).not.toHaveProperty('assignees')
      expect(result.viewer).toEqual(ann)
    }
    // A single-person task says so with an empty mode and team.
    expect((await facts('task-12', { assignedTo: 'ann', mode: '', team: [] })).assignees).toEqual([{ id: 'ann', name: 'ann' }])
  })

  it('reports the creator, or null when ZenTao names none, and nothing when it is not given', async () => {
    expect((await facts('bug-12', { status: 'resolved', assignedTo: { account: 'bob', realname: 'Bob' }, openedBy: { account: 'bob', realname: 'Bob' } }))).toMatchObject({ assignees: [bob], reporter: bob })
    expect((await facts('bug-12', { status: 'active', openedBy: null })).reporter).toBeNull()
    expect(await facts('bug-12', { status: 'active' })).not.toHaveProperty('reporter')
    // A shape this does not know is not a creator, and does not fail the call.
    expect(await facts('bug-12', { status: 'active', openedBy: 7 })).not.toHaveProperty('reporter')
  })

  it('reports the type and the product of bugs and stories, leaving out a scope it was not given', async () => {
    expect(await facts('bug-12', { status: 'active', product: 7, productName: 'App', execution: 42, executionName: 'Sprint 12' })).toMatchObject({ type: { id: 'bug', name: 'Bug' }, scope: { id: '7', name: 'App' } })
    expect(await facts('story-12', { status: 'active', product: '7' })).toMatchObject({ type: { id: 'story', name: '需求' }, scope: { id: '7', name: '7' } })
    expect(await facts('story-12', { status: 'active', product: 0 })).not.toHaveProperty('scope')
    expect(await facts('task-12', { product: 7, productName: 'App' })).not.toHaveProperty('scope')
  })

  it('still offers the moves when the account cannot be read, without a viewer', async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) => String(url).endsWith('/user') ? new Response('secret-token', { status: 500 }) : Response.json({ ...task, assignedTo: 'ann' }))
    const result = await zentaoSource((url, key) => new ZentaoClient(url, key, fetcher)).transitions?.(settings, credential, 'task-12', signal)
    expect(result).not.toHaveProperty('viewer')
    expect(result).toMatchObject({ statusId: 'wait', assignees: [{ id: 'ann', name: 'ann' }], options: [{ id: 'start', toStatusId: 'doing' }, { id: 'finish', toStatusId: 'done' }] })
  })

  it('declares rules by type, and never offers to close a bug', async () => {
    const [declared] = PluginManifest.parse(manifest).contributes.sources
    const types = Object.fromEntries((declared?.writebackTypes ?? []).map((type) => [type.id, type]))
    expect(Object.keys(types)).toEqual(['task', 'bug', 'story'])
    const values = (stage: unknown) => stage && typeof stage === 'object' && 'presets' in stage && Array.isArray(stage.presets) ? stage.presets.map((preset: { value: string }) => preset.value) : stage
    expect(values(types.task?.rules?.start)).toEqual(['进行中'])
    expect(values(types.task?.rules?.review)).toEqual(['已完成'])
    expect(values(types.task?.rules?.done)).toEqual(['已完成', '已关闭|已完成'])
    expect(types.bug?.rules).toMatchObject({ start: false, done: false })
    expect(values(types.bug?.rules?.review)).toEqual(['已解决'])
    expect(types.story?.rules).toMatchObject({ start: false, review: false })
    expect(values(types.story?.rules?.done)).toEqual(['已关闭'])
    for (const type of Object.values(types)) for (const stage of Object.values(type.rules ?? {})) if (stage) expect(stage.custom).toBe(false)
    // Older Antumi reads the source's own rules: a resolved bug stops at 已解决 there, before 已关闭.
    expect(values(declared?.writebackRules?.done)).toEqual(['已完成|已解决|已关闭'])
    expect(JSON.stringify(manifest)).not.toContain('"value":"已关闭|已完成|已解决"')
  })

  it('offers status moves only, as RESTful API v1 cannot post a comment', async () => {
    const { source: zentao } = source()
    expect(zentao.comment).toBeUndefined()
    expect(manifest.contributes.sources[0]).toMatchObject({ writeback: 1, writebackComment: false })
  })

  it('shows statuses by their ZenTao names when syncing too', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ page: 1, limit: 100, total: 1, tasks: [{ ...task, status: 'doing' }] }))
    expect(await new ZentaoClient(base, 'token', fetcher).list('task', { scopeId: '1', assignee: '', state: 'all' }, signal)).toMatchObject([{ status: '进行中', statusCategory: 'doing' }])
  })
})
