import { describe, expect, it } from 'vitest'
import { ZentaoClient } from './zentao-client.js'

const signal = new AbortController().signal
const row = { id: 1, name: 'Task', status: 'doing' }
const action = { actor: 'Ann', comment: '<p>Confirmed</p>', date: '2026-11-01T00:00:00Z' }
describe('ZenTao comment synchronization', () => {
  it('uses action map keys as stable identities and ignores actions without comments', async () => {
    const fetcher: typeof fetch = async () => Response.json({ ...row, actions: { '100': action, '101': { ...action, comment: '' }, '102': { ...action, id: 102 } } })
    const client = new ZentaoClient('https://a.test/api.php/v1', 'secret', fetcher)
    const issue = await client.issue('task', '1', signal)
    expect(issue.commentState?.comments.map((comment) => comment.id)).toEqual(['100', '102'])
    const page = await client.commentChanges('task', '1', signal, { checkpoint: { createdAt: 0, ids: [] }, continuation: null })
    expect(page.comments[0]?.markdown).toBe('Confirmed')
  })
  it('keeps the snapshot but refuses to invent identities for an action array without IDs', async () => {
    const fetcher: typeof fetch = async () => Response.json({ ...row, actions: [action] })
    const client = new ZentaoClient('https://a.test/api.php/v1', 'secret', fetcher)
    expect((await client.issue('task', '1', signal)).commentState).toBeUndefined()
    await expect(client.commentChanges('task', '1', signal, { checkpoint: { createdAt: 0, ids: [] }, continuation: null })).rejects.toThrow('稳定')
  })
})
