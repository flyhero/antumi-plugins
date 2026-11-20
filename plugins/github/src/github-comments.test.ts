import { describe, expect, it } from 'vitest'
import { GitHubClient } from './github-client.js'
import { githubProvider } from './github-provider.js'

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

  it('deduplicates body and comment images and refreshes private comment image addresses when delivering', async () => {
    const asset = 'https://github.com/user-attachments/assets/screenshot'
    const body = `![Screenshot](${asset})`
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0])
    const fetched: { url: URL; headers: Headers }[] = []
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(String(input))
      fetched.push({ url, headers: new Headers(init?.headers) })
      if (url.hostname === 'private-user-images.githubusercontent.com') return new Response(png, { headers: { 'content-type': 'image/png' } })
      const fresh = url.pathname === '/repos/a/b/issues/comments/42'
      const comment = { id: 42, body, body_html: `<img src="https://private-user-images.githubusercontent.com/1/a.png?jwt=${fresh ? 'new' : 'old'}">`, created_at: created, updated_at: created, issue_url: 'https://api.github.com/repos/a/b/issues/1', html_url: `${row.html_url}#issuecomment-42` }
      if (fresh) return Response.json(comment)
      if (url.pathname.endsWith('/comments')) return Response.json([comment])
      return Response.json({ ...row, comments: 1, body, body_html: comment.body_html })
    }
    const client = new GitHubClient({ token: 'secret' }, fetcher)
    const issue = await client.issue('a/b#1', signal)
    expect(issue.images).toHaveLength(1)
    expect(issue.images?.[0]?.url).toContain('jwt=old')
    const initialRef = issue.commentState?.comments[0]?.images?.[0]
    expect(initialRef?.id).toMatch(/^42:[0-9a-f]{64}$/)
    expect(initialRef?.id).not.toContain('jwt')
    const updates = await client.commentChanges('a/b#1', signal, { checkpoint: { createdAt: 0, ids: [] }, continuation: null })
    expect(updates.comments[0]?.images?.[0]).toEqual(initialRef)
    const id = initialRef?.id
    if (!id) throw new Error('no image reference')
    const provider = githubProvider(() => client)
    const image = await provider.image({}, { kind: 'token', payload: { token: 'secret' } }, 'a/b#1', id, signal)
    expect(image.bytes).toEqual(Buffer.from(png))
    expect(image.name).toBe('Screenshot')
    expect(fetched.at(-1)?.url.searchParams.get('jwt')).toBe('new')
    expect(fetched.at(-1)?.headers.has('authorization')).toBe(false)
    expect(fetched.filter((call) => call.url.pathname.endsWith('/comments') || call.url.pathname.endsWith('/42')).every((call) => call.headers.get('accept') === 'application/vnd.github.full+json')).toBe(true)
  })

  it('refuses images from another issue and removed images before downloading', async () => {
    let issueUrl = 'https://api.github.com/repos/a/b/issues/2'
    const calls: string[] = []
    const client = new GitHubClient({ token: 'secret' }, async (input) => {
      calls.push(String(input))
      return Response.json({ id: 42, body: 'The image was removed.', issue_url: issueUrl })
    })
    const id = `42:${'a'.repeat(64)}`
    await expect(client.commentImage('a/b#1', id, signal)).rejects.toMatchObject({ code: 'not-found' })
    issueUrl = 'https://api.github.com/repos/a/b/issues/1'
    await expect(client.commentImage('a/b#1', id, signal)).rejects.toMatchObject({ code: 'not-found' })
    expect(calls.every((url) => url === 'https://api.github.com/repos/a/b/issues/comments/42')).toBe(true)
    await expect(client.commentImage('a/b#1', 'https://evil.test/secret', signal)).rejects.toMatchObject({ code: 'not-found' })
    expect(calls).toHaveLength(2)
  })
})
