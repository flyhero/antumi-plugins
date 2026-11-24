import { describe, expect, it, vi } from 'vitest'
import { ZentaoClient } from './zentao-client.js'
import { zentaoSource } from './zentao-source.js'
import manifest from '../manifest.json' with { type: 'json' }

const signal = new AbortController().signal
const base = 'https://example.com/zentao/api.php/v1'
const settings = { apiBase: base, kind: 'task', scopeId: '1' }
const credential = { kind: 'token' as const, payload: { token: 'secret-token' } }
const task = { id: 12, name: 'Fix login', status: 'wait', left: 3, estimate: 4, consumed: 0, realStarted: null }

function source(...replies: Response[]) {
  const fetcher = vi.fn<typeof fetch>()
  for (const reply of replies) fetcher.mockResolvedValueOnce(reply)
  return { fetcher, source: zentaoSource((url, key) => new ZentaoClient(url, key, fetcher)) }
}

function body(call: Parameters<typeof fetch> | undefined): unknown {
  const init = call?.[1]
  return typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
}

describe('ZenTao writeback', () => {
  it('offers the actions the current status allows, named by the status they lead to', async () => {
    const { source: waiting } = source(Response.json(task))
    expect(await waiting.transitions?.(settings, credential, 'task-12', signal)).toEqual({
      status: '未开始', statusCategory: 'todo',
      options: [
        { id: 'start', name: '进行中', action: '开始', category: 'doing' },
        { id: 'finish', name: '已完成', action: '完成', category: 'done' }
      ]
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
      status: '已解决', statusCategory: 'done',
      options: [
        { id: 'close', name: '已关闭', action: '关闭', category: 'done' },
        { id: 'activate', name: '激活', category: 'todo' }
      ]
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
