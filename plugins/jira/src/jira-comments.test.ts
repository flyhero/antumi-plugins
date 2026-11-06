import { describe, expect, it } from 'vitest'
import { JiraClient } from './jira-client.js'

const signal = new AbortController().signal
describe('Jira comment synchronization', () => {
  it('paginates comments, converts ADF, and preserves comment identity', async () => {
    const rows = Array.from({ length: 125 }, (_, id) => ({ id: String(id), author: { displayName: 'Ann' }, created: '2026-11-01T00:00:00Z', updated: '2026-11-01T01:00:00Z', body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: `comment ${id}` }] }] } }))
    const fetched: number[] = []
    const fetcher: typeof fetch = async (input) => {
      const url = new URL(String(input))
      const offset = Number(url.searchParams.get('startAt'))
      fetched.push(offset)
      return Response.json({ total: rows.length, comments: rows.slice(offset, offset + 100) })
    }
    const client = new JiraClient({ site: 'https://a.atlassian.net', email: 'a@a.test', token: 'secret' }, fetcher)
    const options = { checkpoint: { createdAt: 0, ids: [] }, continuation: null }
    const first = await client.commentChanges('A-1', signal, options)
    expect(fetched).toEqual([0, 100])
    expect(first.comments).toHaveLength(100)
    expect(first.comments[0]?.markdown).toContain('comment')
    expect(first.comments[0]?.url).toContain('focusedCommentId=')
    const second = await client.commentChanges('A-1', signal, { ...options, continuation: first.continuation })
    expect(second.comments).toHaveLength(25)
    expect(second.checkpoint.ids).toHaveLength(125)
  })
})
