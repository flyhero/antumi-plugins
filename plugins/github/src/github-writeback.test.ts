import { describe, expect, it } from 'vitest'
import { GitHubClient } from './github-client.js'
import { githubProvider } from './github-provider.js'

type Call = { method: string; url: URL; body: unknown }

const signal = new AbortController().signal
const credential = { kind: 'token', payload: { token: 'secret' } } as const
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers })
const row = (overrides: Record<string, unknown> = {}) => ({
  number: 7, title: 'Fix login', html_url: 'https://github.com/acme/widgets/issues/7', state: 'open', state_reason: null, comments: 0, ...overrides
})

// A GitHub that answers the issue read with current and every write with reply.
function github(current: Record<string, unknown>, reply: (call: Call) => Response) {
  const calls: Call[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const call = { method: init?.method ?? 'GET', url: new URL(String(input)), body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined }
    calls.push(call)
    expect(init?.redirect).toBe('error')
    expect(init?.signal).toBeDefined()
    return call.method === 'GET' ? json(current) : reply(call)
  }
  return { provider: githubProvider(() => new GitHubClient({ token: 'secret' }, fetchImpl)), calls }
}

describe('GitHub writeback', () => {
  it('offers closing an open issue as completed or not planned', async () => {
    const { provider } = github(row(), () => json({}))
    expect(await provider.transitions({}, credential, 'acme/widgets#7', signal)).toEqual({
      status: 'open', statusCategory: 'todo',
      options: [
        { id: 'close:completed', name: 'completed', action: 'Close as completed', category: 'done' },
        { id: 'close:not_planned', name: 'not_planned', action: 'Close as not planned', category: 'done' }
      ]
    })
  })

  it('offers reopening a closed issue or pull request, but not a merged one', async () => {
    const closed = github(row({ state: 'closed', state_reason: 'not_planned' }), () => json({}))
    expect(await closed.provider.transitions({}, credential, 'acme/widgets#7', signal)).toEqual({
      status: 'not_planned', statusCategory: 'done', options: [{ id: 'reopen', name: 'open', action: 'Reopen', category: 'todo' }]
    })
    const pull = github(row({ pull_request: { merged_at: null } }), () => json({}))
    expect((await pull.provider.transitions({}, credential, 'acme/widgets#7', signal)).options).toEqual([{ id: 'close', name: 'closed', action: 'Close', category: 'done' }])
    const merged = github(row({ state: 'closed', pull_request: { merged_at: '2026-11-01T00:00:00Z' } }), () => json({}))
    expect(await merged.provider.transitions({}, credential, 'acme/widgets#7', signal)).toEqual({ status: 'closed', statusCategory: 'done', options: [] })
  })

  it('closes an issue with its reason and reports the status GitHub answers with', async () => {
    const { provider, calls } = github(row(), () => json(row({ state: 'closed', state_reason: 'completed' })))
    expect(await provider.transition({}, credential, 'acme/widgets#7', 'close:completed', signal)).toEqual({ status: 'completed', statusCategory: 'done' })
    expect(calls.map((call) => [call.method, call.url.pathname, call.body])).toEqual([
      ['GET', '/repos/acme/widgets/issues/7', undefined],
      ['PATCH', '/repos/acme/widgets/issues/7', { state: 'closed', state_reason: 'completed' }]
    ])
  })

  it('closes a pull request through the pulls endpoint and reads its status back', async () => {
    const { provider, calls } = github(row({ pull_request: { merged_at: null } }), () => json({ number: 7, state: 'closed' }))
    await provider.transition({}, credential, 'acme/widgets#7', 'close', signal)
    expect(calls.map((call) => [call.method, call.url.pathname, call.body])).toEqual([
      ['GET', '/repos/acme/widgets/issues/7', undefined],
      ['PATCH', '/repos/acme/widgets/pulls/7', { state: 'closed' }],
      ['GET', '/repos/acme/widgets/issues/7', undefined]
    ])
  })

  it('refuses a move the issue cannot make now without writing', async () => {
    const { provider, calls } = github(row({ state: 'closed', state_reason: 'completed' }), () => json({}))
    await expect(provider.transition({}, credential, 'acme/widgets#7', 'close:not_planned', signal)).rejects.toMatchObject({ code: 'request-failed', message: expect.stringContaining('不能这样改状态') })
    await expect(provider.transition({}, credential, 'acme/widgets#7', 'merge', signal)).rejects.toMatchObject({ code: 'request-failed' })
    expect(calls.every((call) => call.method === 'GET')).toBe(true)
  })

  it('posts Markdown as it is and returns the id comment sync reads back', async () => {
    const markdown = '做完了：\n\n- 修复登录\n- 见 [PR](https://github.com/acme/widgets/pull/8)\n\n```ts\nconst a = `<b>`\n```'
    const { provider, calls } = github(row(), () => json({ id: 1234567, html_url: 'https://github.com/acme/widgets/issues/7#issuecomment-1234567', body: markdown }, 201))
    expect(await provider.comment({}, credential, 'acme/widgets#7', { markdown, writeId: '8d7a0a3e-1c1d-4c77-9b55-5b1a3c1f2e9d' }, signal)).toEqual({
      id: '1234567', url: 'https://github.com/acme/widgets/issues/7#issuecomment-1234567'
    })
    expect(calls.at(-1)).toMatchObject({ method: 'POST', body: { body: markdown } })
    expect(calls.at(-1)?.url.pathname).toBe('/repos/acme/widgets/issues/7/comments')

    // Comment sync reports the same comment under the same id.
    const synced = new GitHubClient({ token: 'secret' }, async (input) => new URL(String(input)).pathname.endsWith('/comments')
      ? json([{ id: 1234567, body: markdown, created_at: '2026-11-01T00:00:00Z', user: { login: 'qingfei' } }])
      : json(row({ comments: 1 })))
    const page = await synced.commentChanges('acme/widgets#7', signal, { checkpoint: { createdAt: 0, ids: [] }, continuation: null })
    expect(page.comments[0]?.id).toBe('1234567')
  })

  it('tells a token that cannot write to sign in again with write access', async () => {
    for (const denied of [json({ message: 'Resource not accessible by personal access token' }, 403), json({ message: 'Not Found' }, 404)]) {
      const { provider } = github(row(), () => denied.clone())
      const failure = provider.comment({}, credential, 'acme/widgets#7', { markdown: 'hi', writeId: 'w' }, signal)
      await expect(failure).rejects.toMatchObject({ code: 'forbidden', message: expect.stringContaining('Issues 读写') })
      const move = github(row(), () => denied.clone()).provider.transition({}, credential, 'acme/widgets#7', 'close:completed', signal)
      await expect(move).rejects.toMatchObject({ code: 'forbidden' })
    }
  })

  it('does not take a rate limit or a locked issue for missing permission', async () => {
    const limited = github(row(), () => json({ message: 'API rate limit exceeded' }, 403, { 'x-ratelimit-remaining': '0' }))
    await expect(limited.provider.comment({}, credential, 'acme/widgets#7', { markdown: 'hi', writeId: 'w' }, signal)).rejects.toMatchObject({ code: 'request-failed' })
    const locked = github(row(), () => json({ message: 'Unable to create comment because issue is locked.' }, 403))
    await expect(locked.provider.comment({}, credential, 'acme/widgets#7', { markdown: 'hi', writeId: 'w' }, signal)).rejects.toMatchObject({ code: 'request-failed', message: expect.stringContaining('锁定') })
  })

  it('reports a missing issue as not found before writing', async () => {
    const calls: string[] = []
    const provider = githubProvider(() => new GitHubClient({ token: 'secret' }, async (_input, init) => (calls.push(init?.method ?? 'GET'), json({ message: 'Not Found' }, 404))))
    await expect(provider.comment({}, credential, 'acme/widgets#404', { markdown: 'hi', writeId: 'w' }, signal)).rejects.toMatchObject({ code: 'not-found' })
    await expect(provider.transitions({}, credential, 'acme/widgets#404', signal)).rejects.toMatchObject({ code: 'not-found' })
    await expect(provider.transition({}, credential, '../x#1', 'reopen', signal)).rejects.toMatchObject({ code: 'not-found' })
    expect(calls).toEqual(['GET', 'GET'])
  })
})
