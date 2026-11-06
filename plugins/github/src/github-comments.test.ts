import { describe, expect, it } from 'vitest'
import { GitHubClient } from './github-client.js'

const signal = new AbortController().signal
const created = '2026-11-01T00:00:00Z'
const row = { number: 1, title: 'Issue', state: 'open', html_url: 'https://github.com/a/b/issues/1', comments: 125 }
const comments = Array.from({ length: 125 }, (_, id) => ({ id: id + 1, body: `comment ${id + 1}`, created_at: created, updated_at: created, user: { login: 'Ann' }, html_url: `${row.html_url}#issuecomment-${id + 1}` }))

describe('GitHub comment synchronization', () => {
  it('keeps stable IDs and catches up more than twenty comments across API and plugin pages', async () => {
    const fetcher: typeof fetch = async (input) => {
      const url = new URL(String(input))
      if (!url.pathname.endsWith('/comments')) return Response.json(row)
      const page = Number(url.searchParams.get('page'))
      return Response.json(comments.slice((page - 1) * 100, page * 100))
    }
    const client = new GitHubClient({ token: 'secret' }, fetcher)
    const first = await client.commentChanges('a/b#1', signal, { checkpoint: { createdAt: 0, ids: [] }, continuation: null })
    expect(first.comments).toHaveLength(100)
    const second = await client.commentChanges('a/b#1', signal, { checkpoint: { createdAt: 0, ids: [] }, continuation: first.continuation })
    expect(second.comments).toHaveLength(25)
    expect(second.continuation).toBeNull()
    const next = await client.commentChanges('a/b#1', signal, { checkpoint: second.checkpoint, continuation: null })
    expect(next.comments).toEqual([])
    expect(new Set([...first.comments, ...second.comments].map((comment) => comment.id)).size).toBe(125)
  })
  it('includes the full same-time identity boundary in the initial snapshot', async () => {
    const fetcher: typeof fetch = async (input) => {
      const url = new URL(String(input))
      if (!url.pathname.endsWith('/comments')) return Response.json(row)
      const page = Number(url.searchParams.get('page'))
      return Response.json(comments.slice((page - 1) * 100, page * 100))
    }
    const issue = await new GitHubClient({ token: 'secret' }, fetcher).issue('a/b#1', signal)
    expect(issue.comments).toHaveLength(20)
    expect(issue.commentState?.checkpoint.ids).toHaveLength(125)
  })
})
