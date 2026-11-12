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

  it('lists the images pasted into a comment by attachment id, asking for attachments only when needed', async () => {
    const media = (alt: string) => ({ type: 'mediaSingle', content: [{ type: 'media', attrs: { type: 'file', id: 'uuid', alt } }] })
    const rows = [
      { id: '1', author: { displayName: 'Ann' }, created: '2026-11-01T00:00:00Z', body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'see' }] }, media('shot.png'), media('spec.pdf')] } },
      { id: '2', author: { displayName: 'Bob' }, created: '2026-11-01T00:01:00Z', body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'plain' }] }] } }
    ]
    const asked: string[] = []
    const fetcher: typeof fetch = async (input) => {
      const url = new URL(String(input))
      asked.push(url.pathname)
      if (url.pathname.endsWith('/comment')) return Response.json({ total: rows.length, comments: rows })
      return Response.json({ fields: { attachment: [{ id: 10, filename: 'shot.png', mimeType: 'image/png', size: 100 }, { id: 11, filename: 'spec.pdf', mimeType: 'application/pdf', size: 100 }] } })
    }
    const client = new JiraClient({ site: 'https://a.atlassian.net', email: 'a@a.test', token: 'secret' }, fetcher)
    const page = await client.commentChanges('A-1', signal, { checkpoint: { createdAt: 0, ids: [] }, continuation: null })
    const pictured = page.comments.find((comment) => comment.id === '1')
    expect(pictured?.images).toEqual([{ id: '10', name: 'shot.png' }])
    expect(pictured?.markdown).toContain('（图片：shot.png）')
    expect(pictured?.markdown).toContain('（附件：spec.pdf）')
    expect(page.comments.find((comment) => comment.id === '2')?.images).toBeUndefined()
    expect(asked.filter((path) => path === '/rest/api/3/issue/A-1')).toHaveLength(1)

    asked.length = 0
    rows.splice(0, 1)
    await client.commentChanges('A-1', signal, { checkpoint: { createdAt: 0, ids: [] }, continuation: null })
    expect(asked).toEqual(['/rest/api/3/issue/A-1/comment'])
  })
})
