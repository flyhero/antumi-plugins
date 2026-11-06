import { describe, expect, it } from 'vitest'
import { LinearClient } from './linear-client.js'

const signal = new AbortController().signal
describe('Linear comment synchronization', () => {
  it('reads GraphQL cursors until the baseline and preserves stable comment IDs', async () => {
    const rows = Array.from({ length: 125 }, (_, id) => ({ id: `id-${id}`, body: `comment ${id}`, createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T01:00:00Z', user: { name: 'Ann' } }))
    const fetcher: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body))
      const offset = body.variables.after ? Number(body.variables.after) : 0
      return Response.json({ data: { issue: { identifier: 'A-1', url: 'https://linear.app/a/issue/A-1', comments: { nodes: rows.slice(offset, offset + 100), pageInfo: { hasNextPage: offset === 0, endCursor: offset === 0 ? '100' : null } } } } })
    }
    const client = new LinearClient('secret', fetcher)
    const options = { checkpoint: { createdAt: 0, ids: [] }, continuation: null }
    const first = await client.commentChanges('A-1', signal, options)
    expect(first.comments).toHaveLength(100)
    const second = await client.commentChanges('A-1', signal, { ...options, continuation: first.continuation })
    expect(second.comments).toHaveLength(25)
    expect(new Set([...first.comments, ...second.comments].map((comment) => comment.id)).size).toBe(125)
  })
  it('rejects a repeated GraphQL cursor instead of silently dropping comments', async () => {
    const fetcher: typeof fetch = async () => Response.json({ data: { issue: { identifier: 'A-1', url: 'https://linear.app/a/issue/A-1', comments: { nodes: [{ id: 'one', body: 'text', createdAt: '2026-11-01T00:00:00Z', user: null }], pageInfo: { hasNextPage: true, endCursor: 'repeated' } } } } })
    await expect(new LinearClient('secret', fetcher).commentChanges('A-1', signal, { checkpoint: { createdAt: 0, ids: [] }, continuation: null })).rejects.toThrow('pagination')
  })
})
