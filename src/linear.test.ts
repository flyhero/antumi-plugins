import { describe, expect, it, vi } from 'vitest'
import { LinearClient } from './linear-client.js'
import { linearSource } from './linear-source.js'

const signal = new AbortController().signal
const row = {
  identifier: 'ENG-12', title: 'Fix login', url: 'https://linear.app/acme/issue/ENG-12/fix-login',
  updatedAt: '2026-10-22T08:00:00Z', priority: 1, priorityLabel: 'Urgent',
  state: { name: 'In Progress', type: 'started' }, labels: { nodes: [{ name: 'Bug' }] }
}
const response = (data: unknown) => Response.json({ data })

describe('Linear source', () => {
  it('normalizes filters and preserves an explicitly empty assignee', () => {
    const source = linearSource()
    expect(source.normalizeSettings({ team: ' eng ' })).toEqual({ team: 'ENG', project: '', assignee: '@me', state: 'active' })
    expect(source.normalizeSettings({ assignee: '' })).toMatchObject({ assignee: '' })
    expect(() => source.normalizeSettings({ project: '../bad' })).toThrow('UUID')
    expect(() => source.normalizeSettings({ state: 'unknown' })).toThrow()
    expect(source.normalizeKey?.(' eng-12 ')).toBe('ENG-12')
    expect(() => source.normalizeKey?.('../ENG-12')).toThrow()
  })

  it('uses a personal API key without Bearer and retries invalid login keys', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(response({ viewer: { id: 'u1', name: 'Ann', email: 'ann@example.com' } }))
    const source = linearSource((key) => new LinearClient(key, fetcher))
    const answers = ['bad', 'good']
    const prompt = vi.fn(async () => answers.shift() ?? '')
    const result = await source.login({ prompt, notify: () => {} }, {}, signal)
    expect(result).toEqual({ credential: { kind: 'token', payload: { token: 'good' } }, account: 'ann@example.com' })
    expect(prompt).toHaveBeenCalledTimes(2)
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({ headers: { Authorization: 'good' }, redirect: 'error' })
    expect(source.envCredential?.({ ANTUMI_LINEAR_TOKEN: 'env-key' })).toEqual({ kind: 'token', payload: { token: 'env-key' } })
  })

  it('pages assigned issues using GraphQL variables and maps states and priority', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ viewer: { id: 'u1', name: 'Ann', email: 'ann@example.com' } }))
      .mockResolvedValueOnce(response({ issues: { nodes: [row], pageInfo: { hasNextPage: true, endCursor: 'next' } } }))
      .mockResolvedValueOnce(response({ issues: { nodes: [{ ...row, identifier: 'ENG-13', priority: 0, state: { name: 'Done', type: 'completed' } }], pageInfo: { hasNextPage: false, endCursor: null } } }))
    const issues = await new LinearClient('key', fetcher).list({ assignee: '@me', team: 'ENG', state: 'active' }, signal)
    expect(issues).toMatchObject([{ key: 'ENG-12', statusCategory: 'doing', type: 'Bug', priority: 'Urgent' }, { key: 'ENG-13', statusCategory: 'done', priority: null }])
    const request = fetcher.mock.calls[1]?.[1]?.body
    expect(typeof request).toBe('string')
    if (typeof request !== 'string') throw new Error('Missing request body')
    expect(JSON.parse(request)).toMatchObject({ variables: { filter: { team: { key: { eq: 'ENG' } }, assignee: { id: { eq: 'u1' } }, state: { type: { nin: ['completed', 'canceled', 'duplicate'] } } }, after: null } })
    expect(fetcher.mock.calls[2]?.[1]?.body).toContain('"after":"next"')
  })

  it('keeps descriptions and the latest comments in a bounded Markdown snapshot', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ issue: {
      ...row, description: '# Reproduction\nThe button fails', creator: { name: 'Ann' }, assignee: null,
      comments: { nodes: [{ body: 'Confirmed', createdAt: '2026-10-21T00:00:00Z', user: { name: 'Bob' } }] }
    } }))
    const issue = await new LinearClient('key', fetcher).issue('ENG-12', signal)
    expect(issue.markdown).toContain('# Reproduction')
    expect(issue.markdown).toContain('Bob')
    expect(issue.markdown).toContain('Confirmed')
    expect(issue.markdown.length).toBeLessThanOrEqual(50_000)
  })

  it('rejects GraphQL errors even when partial data arrives with HTTP 200', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      data: { issues: { nodes: [row] } }, errors: [{ message: 'private-data', extensions: { code: 'FORBIDDEN' } }]
    }))
    await expect(new LinearClient('key', fetcher).list({ assignee: '', state: 'all' }, signal)).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('rejects repeated pagination cursors', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response({ issues: { nodes: [row], pageInfo: { hasNextPage: true, endCursor: 'same' } } }))
    await expect(new LinearClient('key', fetcher).list({ assignee: '' }, signal)).rejects.toMatchObject({ code: 'request-failed' })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('rejects oversized and malformed responses', async () => {
    const oversized = vi.fn<typeof fetch>().mockResolvedValue(new Response('x', { headers: { 'content-length': String(6 * 1024 * 1024) } }))
    await expect(new LinearClient('key', oversized).viewer(signal)).rejects.toMatchObject({ code: 'response-too-large' })
    const malformed = vi.fn<typeof fetch>().mockResolvedValue(new Response('<html>error</html>'))
    await expect(new LinearClient('key', malformed).viewer(signal)).rejects.toMatchObject({ code: 'request-failed' })
  })

  it('rejects missing or mismatched issue details', async () => {
    const missing = vi.fn<typeof fetch>().mockResolvedValue(response({ issue: null }))
    await expect(new LinearClient('key', missing).issue('ENG-12', signal)).rejects.toMatchObject({ code: 'not-found' })
    const mismatch = vi.fn<typeof fetch>().mockResolvedValue(response({ issue: { ...row, description: '', creator: null, assignee: null, comments: { nodes: [] } } }))
    await expect(new LinearClient('key', mismatch).issue('ENG-99', signal)).rejects.toMatchObject({ code: 'request-failed' })
  })

  it('does not send credentials to a configurable endpoint', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ viewer: { id: 'u1', name: 'Ann', email: 'ann@example.com' } }))
    await new LinearClient('secret', fetcher).viewer(signal)
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://api.linear.app/graphql')
  })
})
