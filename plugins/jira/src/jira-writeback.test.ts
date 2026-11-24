import { describe, expect, it } from 'vitest'
import { SourceTransitionOption } from '@antumi/plugin-sdk'
import { JiraClient } from './jira-client.js'
import { jiraProvider } from './jira-provider.js'

type Call = { method: string; url: URL; body: unknown; contentType: string | null; redirect: RequestInit['redirect'] }
type Route = (call: Call) => Response | undefined

function fakeFetch(route: Route): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers)
    const call = { method: init?.method ?? 'GET', url: new URL(String(input)), body: init?.body ? JSON.parse(String(init.body)) : null, contentType: headers.get('content-type'), redirect: init?.redirect }
    calls.push(call)
    return route(call) ?? new Response('{"errorMessages":["no route"]}', { status: 404 })
  }
  return { fetch: fetchImpl, calls }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const site = 'https://acme.atlassian.net'
const settings = { site, jql: 'x' }
const credential = { kind: 'basic', payload: { email: 'me@acme.com', token: 'secret' } }
const signal = new AbortController().signal
const status = (id: string, name: string, key: string) => ({ id, name, statusCategory: { key } })
let current = status('3', '处理中', 'indeterminate')

// PROJ-1 is in progress; Jira offers a self loop, a move back, two ways to Done and an unavailable one.
function jira(write: (call: Call) => Response | undefined = () => undefined): Route {
  return (call) => {
    const path = call.url.pathname
    if (call.method === 'GET' && path === '/rest/api/3/issue/PROJ-1') return json({ key: 'PROJ-1', fields: { status: current } })
    if (call.method === 'GET' && path === '/rest/api/3/issue/PROJ-1/transitions') {
      return json({
        transitions: [
          { id: '11', name: '处理中', isAvailable: true, to: status('3', '处理中', 'indeterminate') },
          { id: '21', name: 'Back to do', isAvailable: true, to: status('1', 'To Do', 'new') },
          { id: '31', name: 'Done', isAvailable: true, to: status('10001', 'Done', 'done') },
          { id: '41', name: '直接关闭', isAvailable: true, to: status('10001', 'Done', 'done') },
          { id: '51', name: '审核', isAvailable: false, to: status('10002', 'In Review', 'indeterminate') },
          { id: '61', name: 'Odd', to: { id: '9', name: 'Parked' } }
        ]
      })
    }
    return write(call)
  }
}

describe('Jira writeback', () => {
  it('lists the moves open now with their categories, leaving out the current status', async () => {
    current = status('3', '处理中', 'indeterminate')
    const { fetch } = fakeFetch(jira())
    const result = await new JiraClient({ site, email: 'e', token: 't' }, fetch).transitions('PROJ-1', signal)
    expect(result.options.map((option) => SourceTransitionOption.parse(option))).toEqual(result.options)
    expect(result).toEqual({
      status: '处理中',
      statusCategory: 'doing',
      options: [
        { id: '21', name: 'To Do', action: 'Back to do', category: 'todo' },
        { id: '31', name: 'Done', category: 'done' },
        { id: '41', name: 'Done', action: '直接关闭', category: 'done' },
        { id: '61', name: 'Parked', action: 'Odd', category: 'unknown' }
      ]
    })
  })

  it('moves the issue by a transition Jira offers, and answers with the status it ends up in', async () => {
    current = status('3', '处理中', 'indeterminate')
    const { fetch, calls } = fakeFetch(
      jira((call) => {
        if (call.method === 'POST' && call.url.pathname === '/rest/api/3/issue/PROJ-1/transitions') {
          current = status('10001', 'Done', 'done')
          return new Response(null, { status: 204 })
        }
        return undefined
      })
    )
    const provider = jiraProvider((credentials) => new JiraClient(credentials, fetch))
    expect(await provider.transition!(settings, credential, 'PROJ-1', '41', signal)).toEqual({ status: 'Done', statusCategory: 'done' })
    const post = calls.find((call) => call.method === 'POST')
    expect(post?.body).toEqual({ transition: { id: '41' } })
    expect(post?.contentType).toBe('application/json')
    expect(post?.redirect).toBe('error')
    expect(calls.at(-1)?.url.pathname).toBe('/rest/api/3/issue/PROJ-1')
  })

  it('refuses an id Jira does not offer for the issue, without writing', async () => {
    current = status('3', '处理中', 'indeterminate')
    const { fetch, calls } = fakeFetch(jira())
    const client = new JiraClient({ site, email: 'e', token: 't' }, fetch)
    await expect(client.transition('PROJ-1', '51', signal)).rejects.toMatchObject({ code: 'request-failed', message: expect.stringContaining('不能这样流转') })
    await expect(client.transition('PROJ-1', '11', signal)).rejects.toMatchObject({ code: 'request-failed' })
    expect(calls.some((call) => call.method === 'POST')).toBe(false)
  })

  it('says a move needs fields filled in Jira, and maps a missing permission to forbidden', async () => {
    current = status('3', '处理中', 'indeterminate')
    let reply = json({ errorMessages: [], errors: { resolution: 'Resolution is required.' } }, 400)
    const { fetch } = fakeFetch(jira((call) => (call.method === 'POST' ? reply : undefined)))
    const client = new JiraClient({ site, email: 'e', token: 't' }, fetch)
    await expect(client.transition('PROJ-1', '31', signal)).rejects.toMatchObject({ code: 'request-failed', message: expect.stringContaining('需要先填写字段') })
    reply = json({ errorMessages: ['You do not have permission to transition this issue.'] }, 400)
    await expect(client.transition('PROJ-1', '31', signal)).rejects.toMatchObject({ code: 'forbidden', message: expect.stringContaining('Transition Issues') })
  })

  it('posts a comment as ADF and answers with the id and link comment sync uses', async () => {
    const { fetch, calls } = fakeFetch((call) =>
      call.method === 'POST' && call.url.pathname === '/rest/api/3/issue/PROJ-1/comment' ? json({ id: '10234', self: `${site}/rest/api/3/issue/1/comment/10234` }, 201) : undefined
    )
    const provider = jiraProvider((credentials) => new JiraClient(credentials, fetch))
    const result = await provider.comment!(settings, credential, 'PROJ-1', { markdown: '已修复，见 [PR](https://example.com/pr/1)\n\n- 补了测试', writeId: '7f2c1d7e-0000-4000-8000-000000000000' }, signal)
    expect(result).toEqual({ id: '10234', url: `${site}/browse/PROJ-1?focusedCommentId=10234` })
    expect(calls[0]?.body).toEqual({
      body: {
        type: 'doc',
        version: 1,
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: '已修复，见 ' }, { type: 'text', text: 'PR', marks: [{ type: 'link', attrs: { href: 'https://example.com/pr/1' } }] }] },
          { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '补了测试' }] }] }] }
        ]
      }
    })

    // Comment sync reads the same comment back under the same id and link.
    const synced = await new JiraClient({ site, email: 'e', token: 't' }, async () =>
      json({ total: 1, comments: [{ id: '10234', author: { displayName: 'Me' }, created: '2026-11-24T00:00:00Z', body: { type: 'doc', version: 1, content: [] } }] })
    ).commentChanges('PROJ-1', signal, { checkpoint: { createdAt: 0, ids: [] }, continuation: null })
    expect(synced.comments[0]).toMatchObject({ id: result.id, url: result.url })
  })

  it('refuses an empty comment without calling Jira', async () => {
    const { fetch, calls } = fakeFetch(() => undefined)
    const provider = jiraProvider((credentials) => new JiraClient(credentials, fetch))
    await expect(provider.comment!(settings, credential, 'PROJ-1', { markdown: ' \n\n', writeId: 'w' }, signal)).rejects.toMatchObject({ code: 'request-failed' })
    expect(calls).toHaveLength(0)
  })

  it('tells a read-only token to sign in again with write:jira-work, whether Jira says 403 or the gateway says scope', async () => {
    const forbidden = fakeFetch((call) => (call.method === 'POST' ? json({ errorMessages: ['You do not have the permission to comment on this issue.'] }, 403) : undefined))
    const body = { type: 'doc' as const, version: 1 as const, content: [] }
    const error = await new JiraClient({ site, email: 'e', token: 'secret-token' }, forbidden.fetch).addComment('PROJ-1', body, signal).catch((failure: unknown) => failure)
    expect(error).toMatchObject({ code: 'forbidden', message: expect.stringContaining('write:jira-work') })
    expect(String(error instanceof Error ? error.message : error)).not.toContain('secret-token')

    // A scoped token: the site turns it down, the gateway lets reads through and refuses the write.
    const scoped = fakeFetch((call) => {
      if (call.url.host === 'acme.atlassian.net' && call.url.pathname === '/_edge/tenant_info') return json({ cloudId: 'cloud-1' })
      if (call.url.host === 'acme.atlassian.net') return json({ errorMessages: ['unauthorized'] }, 401)
      return json({ code: 401, message: 'Unauthorized; scope does not match' }, 401)
    })
    await expect(new JiraClient({ site, email: 'e', token: 't' }, scoped.fetch).addComment('PROJ-1', body, signal)).rejects.toMatchObject({ code: 'forbidden' })
    expect(scoped.calls.filter((call) => call.method === 'POST').map((call) => call.url.host)).toEqual(['acme.atlassian.net', 'api.atlassian.com'])
  })

  it('reports a missing issue as not found', async () => {
    const { fetch } = fakeFetch(() => json({ errorMessages: ['Issue does not exist or you do not have permission to see it.'] }, 404))
    const client = new JiraClient({ site, email: 'e', token: 't' }, fetch)
    await expect(client.addComment('PROJ-404', { type: 'doc', version: 1, content: [] }, signal)).rejects.toMatchObject({ code: 'not-found' })
    await expect(client.transitions('PROJ-404', signal)).rejects.toMatchObject({ code: 'not-found' })
    await expect(client.transitions('../admin', signal)).rejects.toMatchObject({ code: 'not-found' })
  })
})
