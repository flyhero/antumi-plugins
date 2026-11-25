import { describe, expect, it, vi } from 'vitest'
import { SourceTransitionOption } from '@antumi/plugin-sdk'
import { LinearClient } from './linear-client.js'
import { linearSource } from './linear-source.js'

const signal = new AbortController().signal
const credential = { kind: 'token', payload: { token: 'secret' } } as const
const writeId = '5f0c6a3e-8b1d-4c2a-9e7f-1a2b3c4d5e6f'
const states = [
  { id: 'done', name: 'Done', type: 'completed', position: 0 },
  { id: 'dup', name: 'Duplicate', type: 'duplicate', position: 0 },
  { id: 'progress', name: 'In Progress', type: 'started', position: 0 },
  { id: 'review', name: 'In Review', type: 'started', position: 1 },
  { id: 'todo', name: 'Todo', type: 'unstarted', position: 0 },
  { id: 'backlog', name: 'Backlog', type: 'backlog', position: 0 },
  { id: 'cancel', name: 'Canceled', type: 'canceled', position: 0 },
  { id: 'odd', name: 'Custom', type: 'mystery', position: 0 }
]
const ann = { id: 'user-ann', name: 'Ann' }
const bob = { id: 'user-bob', name: 'Bob' }
const team = { id: 'team-uuid', key: 'ENG', name: 'Engineering' }
const workflow = (state = states[4], people: { viewer?: unknown, assignee?: unknown, creator?: unknown } = {}) => Response.json({ data: {
  viewer: 'viewer' in people ? people.viewer : ann,
  issue: {
    id: 'issue-uuid', identifier: 'ENG-12', state,
    assignee: 'assignee' in people ? people.assignee : ann, creator: 'creator' in people ? people.creator : bob,
    team: { ...team, states: { nodes: states } }
  }
} })
const body = (fetcher: ReturnType<typeof vi.fn<typeof fetch>>, call: number) => {
  const value = fetcher.mock.calls[call]?.[1]?.body
  if (typeof value !== 'string') throw new Error('Missing request body')
  return JSON.parse(value)
}
const source = (fetcher: typeof fetch) => linearSource((key) => new LinearClient(key, fetcher))

describe('Linear writeback', () => {
  it('lists the team statuses in board order, without the current one or Duplicate', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => workflow())
    const result = await source(fetcher).transitions?.({}, credential, 'eng-12', signal)
    for (const option of result?.options ?? []) expect(SourceTransitionOption.parse(option)).toEqual(option)
    expect(result).toEqual({ status: 'Todo', statusCategory: 'todo', statusId: 'todo', options: [
      { id: 'backlog', name: 'Backlog', category: 'todo', toStatusId: 'backlog' },
      { id: 'progress', name: 'In Progress', category: 'doing', toStatusId: 'progress' },
      { id: 'review', name: 'In Review', category: 'doing', toStatusId: 'review' },
      { id: 'done', name: 'Done', category: 'done', toStatusId: 'done' },
      { id: 'cancel', name: 'Canceled', category: 'done', toStatusId: 'cancel' },
      { id: 'odd', name: 'Custom', category: 'unknown', toStatusId: 'odd' }
    ], viewer: ann, assignees: [ann], reporter: bob, scope: { id: 'team-uuid', name: 'Engineering' } })
    expect(body(fetcher, 0).variables).toEqual({ id: 'ENG-12' })
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ headers: { Authorization: 'secret' }, redirect: 'error' })
  })

  it('reports who the issue is with and its team from the one read of its workflow', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => workflow(states[2], { assignee: bob }))
    const result = await source(fetcher).transitions?.({}, credential, 'ENG-12', signal)
    expect(result).toMatchObject({ statusId: 'progress', viewer: ann, assignees: [bob], reporter: bob, scope: { id: 'team-uuid', name: 'Engineering' } })
    // Linear has no issue types, so there is none to report.
    expect(result).not.toHaveProperty('type')
    for (const option of result?.options ?? []) expect(SourceTransitionOption.parse(option)).toMatchObject({ toStatusId: option.id })
    expect(fetcher).toHaveBeenCalledTimes(1)
    const { query } = body(fetcher, 0)
    for (const field of ['viewer { id name }', 'assignee { id name }', 'creator { id name }', 'team { id key name']) expect(query).toContain(field)
  })

  it('reports an unassigned issue as with no one, and one an integration made as without a reporter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => workflow(states[4], { assignee: null, creator: null }))
    const result = await source(fetcher).transitions?.({}, credential, 'ENG-12', signal)
    expect(result).toMatchObject({ viewer: ann, assignees: [], reporter: null })
  })

  it('leaves out a fact Linear did not give, and cuts a name to what Antumi takes', async () => {
    const bare = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: { issue: { id: 'issue-uuid', identifier: 'ENG-12', state: states[4], team: { states: { nodes: states } } } } }))
    const result = await source(bare).transitions?.({}, credential, 'ENG-12', signal)
    expect(result).toMatchObject({ status: 'Todo', statusId: 'todo' })
    for (const fact of ['viewer', 'assignees', 'reporter', 'scope', 'type']) expect(result).not.toHaveProperty(fact)

    // An assignee that does not read is unknown, not no one: Antumi must not take the issue for unassigned.
    const odd = vi.fn<typeof fetch>().mockResolvedValue(workflow(states[4], { viewer: { id: '', name: 'Ann' }, assignee: { name: 'No id' }, creator: { id: 'user-long', name: 'x'.repeat(300) } }))
    const partial = await source(odd).transitions?.({}, credential, 'ENG-12', signal)
    expect(partial).not.toHaveProperty('viewer')
    expect(partial).not.toHaveProperty('assignees')
    expect(partial?.reporter).toEqual({ id: 'user-long', name: 'x'.repeat(200) })
  })

  it('moves the issue by its UUID to a status of its team', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(workflow())
      .mockResolvedValueOnce(Response.json({ data: { issueUpdate: { success: true, issue: { state: states[2] } } } }))
    const result = await source(fetcher).transition?.({}, credential, 'ENG-12', 'progress', signal)
    expect(result).toEqual({ status: 'In Progress', statusCategory: 'doing' })
    expect(body(fetcher, 1)).toMatchObject({ query: expect.stringContaining('issueUpdate'), variables: { id: 'issue-uuid', stateId: 'progress' } })
  })

  it('refuses a status the issue cannot move to, without writing', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => workflow())
    const plugin = source(fetcher)
    await expect(plugin.transition?.({}, credential, 'ENG-12', 'other-team-state', signal)).rejects.toMatchObject({ code: 'request-failed', message: expect.stringContaining('不能改到这个状态') })
    await expect(plugin.transition?.({}, credential, 'ENG-12', 'dup', signal)).rejects.toMatchObject({ code: 'request-failed' })
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher.mock.calls.every(([, init]) => !String(init?.body).includes('mutation'))).toBe(true)
  })

  it('leaves an issue already in the asked status alone', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(workflow(states[2]))
    await expect(source(fetcher).transition?.({}, credential, 'ENG-12', 'progress', signal)).resolves.toEqual({ status: 'In Progress', statusCategory: 'doing' })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('posts Markdown as is with the write id, returning the id comment sync reads', async () => {
    const markdown = '完成了 **登录修复**。\n\n- 改了 `auth.ts`\n- PR: [#42](https://github.com/acme/app/pull/42)\n\n```ts\nconst a = 1\n```'
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: { commentCreate: { success: true, comment: { id: writeId, url: 'https://linear.app/acme/issue/ENG-12#comment-5f0c6a3e' } } } }))
    const result = await source(fetcher).comment?.({}, credential, 'ENG-12', { markdown, writeId: writeId.toUpperCase() }, signal)
    expect(result).toEqual({ id: writeId, url: 'https://linear.app/acme/issue/ENG-12#comment-5f0c6a3e' })
    expect(body(fetcher, 0).variables).toEqual({ input: { issueId: 'ENG-12', body: markdown, id: writeId } })

    // Comment sync keys comments by the same GraphQL id.
    const sync = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: { issue: { identifier: 'ENG-12', url: 'https://linear.app/acme/issue/ENG-12', comments: {
      nodes: [{ id: writeId, body: markdown, createdAt: '2026-11-24T00:00:00Z', user: { name: 'Ann' } }], pageInfo: { hasNextPage: false, endCursor: null }
    } } } }))
    const page = await new LinearClient('secret', sync).commentChanges('ENG-12', signal, { checkpoint: { createdAt: 0, ids: [] }, continuation: null })
    expect(page.comments.map((comment) => comment.id)).toEqual([result?.id])
  })

  it('returns the comment an earlier attempt already posted when Linear refuses the repeated id', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ errors: [{ message: 'Duplicate key', extensions: { code: 'INVALID_INPUT' } }] }, { status: 400 }))
      .mockResolvedValueOnce(Response.json({ data: { comment: { id: writeId, url: 'https://linear.app/c', issue: { id: 'issue-uuid' } }, issue: { id: 'issue-uuid' } } }))
    await expect(source(fetcher).comment?.({}, credential, 'ENG-12', { markdown: 'hi', writeId }, signal)).resolves.toEqual({ id: writeId, url: 'https://linear.app/c' })
    expect(body(fetcher, 1).variables).toEqual({ comment: writeId, issue: 'ENG-12' })
  })

  it('keeps the original failure when no earlier comment exists on this issue', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ errors: [{ message: 'Something broke', extensions: { code: 'INTERNAL' } }] }))
      .mockResolvedValueOnce(Response.json({ data: { comment: { id: writeId, url: 'https://linear.app/c', issue: { id: 'elsewhere' } }, issue: { id: 'issue-uuid' } } }))
    await expect(source(fetcher).comment?.({}, credential, 'ENG-12', { markdown: 'hi', writeId }, signal)).rejects.toMatchObject({ code: 'request-failed' })
  })

  it('asks for a key with Write permission when a read-only key writes', async () => {
    const scope = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ errors: [{ message: 'Invalid scope: `write` required', extensions: { type: 'forbidden', code: 'FORBIDDEN' } }] }, { status: 400 }))
    const failure = source(scope).comment?.({}, credential, 'ENG-12', { markdown: 'hi', writeId }, signal)
    await expect(failure).rejects.toMatchObject({ code: 'forbidden', message: expect.stringContaining('Write 权限') })
    expect(scope).toHaveBeenCalledTimes(1)

    const http = vi.fn<typeof fetch>().mockResolvedValueOnce(workflow()).mockResolvedValueOnce(new Response('secret body', { status: 403 }))
    const move = source(http).transition?.({}, credential, 'ENG-12', 'progress', signal)
    await expect(move).rejects.toMatchObject({ code: 'forbidden', message: expect.stringContaining('重新登录') })
    await expect(move).rejects.not.toMatchObject({ message: expect.stringContaining('secret') })
  })

  it('reports a missing issue as not found', async () => {
    const missing = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ errors: [{ message: 'Entity not found: Issue', extensions: { code: 'INVALID_INPUT' } }] }, { status: 400 }))
    await expect(source(missing).transitions?.({}, credential, 'ENG-99', signal)).rejects.toMatchObject({ code: 'not-found', message: 'Linear 中没有 ENG-99' })
    await expect(source(missing).comment?.({}, credential, 'ENG-99', { markdown: 'hi', writeId }, signal)).rejects.toMatchObject({ code: 'not-found' })
    const empty = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: { issue: null } }))
    await expect(source(empty).transition?.({}, credential, 'ENG-99', 'progress', signal)).rejects.toMatchObject({ code: 'not-found' })
  })
})
