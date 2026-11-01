import { describe, expect, it, vi } from 'vitest'
import { ZentaoClient } from './zentao-client.js'
import { normalizeApiBase, zentaoSource } from './zentao-source.js'

const signal = new AbortController().signal
const base = 'https://example.com/zentao/api.php/v1'
const row = { id: 12, name: 'Fix login', status: 'doing', pri: 2, assignedTo: { account: 'ann', realname: 'Ann' }, desc: '<p>Reproduce <strong>this</strong></p>', lastEditedDate: '2026-10-22T08:00:00Z' }

describe('ZenTao source', () => {
  it('validates the API URL and keeps deployment subdirectories', () => {
    expect(normalizeApiBase(` ${base}/ `)).toBe(base)
    for (const url of ['file:///api.php/v1', 'https://user:secret@example.com/api.php/v1', `${base}?token=secret`, 'https://example.com/api.php/v2']) expect(() => normalizeApiBase(url)).toThrow()
    const source = zentaoSource()
    expect(source.normalizeSettings({ apiBase: base, scopeId: ' 42 ' })).toEqual({ apiBase: base, kind: 'task', scopeId: '42', assignee: '@me', state: 'active' })
    expect(() => source.normalizeSettings({ apiBase: base, scopeId: '../42' })).toThrow()
    expect(source.normalizeKey?.(' BUG-12 ')).toBe('bug-12')
    expect(() => source.normalizeKey?.('12')).toThrow()
  })

  it('validates a token against the configured site before saving it', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ profile: { account: 'ann', realname: 'Ann' } }))
    const source = zentaoSource((url, key) => new ZentaoClient(url, key, fetcher))
    const result = await source.login({ prompt: async () => ' token ', notify: () => {} }, { apiBase: base }, signal)
    expect(result).toEqual({ credential: { kind: 'token', payload: { token: 'token' } }, account: 'Ann (ann)' })
    expect(fetcher.mock.calls[0]).toMatchObject([`${base}/user`, { headers: { Token: 'token' }, redirect: 'error' }])
  })

  it('pages task results before filtering assignee and completion locally', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ profile: { account: 'ann' } }))
      .mockResolvedValueOnce(Response.json({ page: 1, limit: 1, total: 3, tasks: [{ ...row, id: 1, assignedTo: 'bob' }] }))
      .mockResolvedValueOnce(Response.json({ page: 2, limit: 1, total: 3, tasks: [{ ...row, id: 2, status: 'closed' }] }))
      .mockResolvedValueOnce(Response.json({ page: 3, limit: 1, total: 3, tasks: [row] }))
    const issues = await new ZentaoClient(base, 'token', fetcher).list('task', { scopeId: '42', assignee: '@me', state: 'active' }, signal)
    expect(issues).toMatchObject([{ key: 'task-12', priority: 'P2', statusCategory: 'doing' }])
    expect(issues[0]?.url).toBe('https://example.com/zentao/index.php?m=task&f=view&taskID=12')
    expect(fetcher.mock.calls[1]?.[0]).toBe(`${base}/executions/42/tasks?page=1&limit=100&orderBy=id_desc`)
    expect(fetcher).toHaveBeenCalledTimes(4)
  })

  it('maps bugs and stories to separate namespaces and excludes deleted items', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ page: 1, limit: 100, total: 2, bugs: [{ ...row, status: 'resolved' }, { ...row, id: 13, deleted: true }] }))
      .mockResolvedValueOnce(Response.json({ page: 1, limit: 100, total: 1, stories: [{ ...row, status: 'active' }] }))
    const client = new ZentaoClient(base, 'token', fetcher)
    expect(await client.list('bug', { scopeId: '7', state: 'all' }, signal)).toMatchObject([{ key: 'bug-12', statusCategory: 'done' }])
    expect(await client.list('story', { scopeId: '7' }, signal)).toMatchObject([{ key: 'story-12', type: '需求' }])
  })

  it('converts descriptions, acceptance criteria and available action comments to Markdown', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      ...row, spec: '<h2>Requirement</h2><p>Hello</p>', verify: '<ul><li>Works</li></ul>',
      actions: [{ actor: 'Bob', comment: '<p>Confirmed</p>', date: '2026-10-22T00:00:00Z' }]
    }))
    const issue = await new ZentaoClient(base, 'token', fetcher).issue('story', '12', signal)
    expect(issue.markdown).toContain('## Requirement')
    expect(issue.markdown).toContain('验收标准')
    expect(issue.markdown).toContain('Confirmed')
    expect(issue.markdown).not.toContain('<p>')
  })

  it('reports expired tokens and does not include response bodies in errors', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('secret-token', { status: 401 }))
    await expect(new ZentaoClient(base, 'key', fetcher).profile(signal)).rejects.toMatchObject({ code: 'auth-failed' })
    const malformed = vi.fn<typeof fetch>().mockResolvedValue(new Response('<html>Login</html>'))
    await expect(new ZentaoClient(base, 'key', malformed).profile(signal)).rejects.toMatchObject({ code: 'request-failed' })
  })

  it('rejects oversized replies and mismatched details', async () => {
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response('x', { headers: { 'content-length': '9999999' } }))
    await expect(new ZentaoClient(base, 'key', large).profile(signal)).rejects.toMatchObject({ code: 'response-too-large' })
    const mismatch = vi.fn<typeof fetch>().mockResolvedValue(Response.json(row))
    await expect(new ZentaoClient(base, 'key', mismatch).issue('task', '13', signal)).rejects.toMatchObject({ code: 'request-failed' })
  })
})
