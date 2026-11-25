import { describe, expect, it } from 'vitest'
import { SourceIssue, SourceTransitionOption } from '@antumi/plugin-sdk'
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
  it('leaves out a transition whose screen asks for a field with no default, and asks Jira for the fields', async () => {
    current = status('3', '处理中', 'indeterminate')
    const { fetch, calls } = fakeFetch((call) => {
      if (call.url.pathname === '/rest/api/3/issue/PROJ-1') return json({ key: 'PROJ-1', fields: { status: current } })
      return json({ transitions: [
        { id: '71', name: 'Resolve', to: status('10003', 'Resolved', 'done'), fields: { resolution: { required: true, hasDefaultValue: false } } },
        { id: '81', name: 'Verify', to: status('10004', 'Verified', 'done'), fields: { customfield_1: { required: true, hasDefaultValue: true }, comment: { required: false, hasDefaultValue: false } } }
      ] })
    })
    const result = await new JiraClient({ site, email: 'e', token: 't' }, fetch).transitions('PROJ-1', signal)
    expect(result.options.map((option) => option.id)).toEqual(['81'])
    expect(calls.some((call) => call.url.pathname.endsWith('/transitions') && call.url.searchParams.get('expand') === 'transitions.fields')).toBe(true)
  })

  it('lists the moves open now with their categories, leaving out the current status', async () => {
    current = status('3', '处理中', 'indeterminate')
    const { fetch } = fakeFetch(jira())
    const result = await new JiraClient({ site, email: 'e', token: 't' }, fetch).transitions('PROJ-1', signal)
    expect(result.options.map((option) => SourceTransitionOption.parse(option))).toEqual(result.options)
    // This Jira names no one and nothing besides the status, so no other fact is made up.
    expect(result).toEqual({
      status: '处理中',
      statusCategory: 'doing',
      statusId: '3',
      options: [
        { id: '21', name: 'To Do', action: 'Back to do', category: 'todo', toStatusId: '1' },
        { id: '31', name: 'Done', category: 'done', toStatusId: '10001' },
        { id: '41', name: 'Done', action: '直接关闭', category: 'done', toStatusId: '10001' },
        { id: '61', name: 'Parked', action: 'Odd', category: 'unknown', toStatusId: '9' }
      ]
    })
    expect(Object.keys(result).sort()).toEqual(['options', 'status', 'statusCategory', 'statusId'])
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
    // A move does not ask who is signed in: that is for the list a rule reads before it.
    expect(calls.some((call) => call.url.pathname.endsWith('/myself'))).toBe(false)
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

// PROJ-1 as Jira Cloud has it: who it is with, who reported it, its type and its project.
const me = { accountId: '5b10a2844c20165700ede21g', displayName: 'Mia Wang', emailAddress: 'me@acme.com' }
const rita = { accountId: '5b10ac8d82e05b22cc7d4ef5', displayName: 'Rita QA' }
const bug = { id: '10004', name: 'Bug', subtask: false }
const project = { id: '10000', key: 'PROJ', name: 'Project X' }

function owned(fields: Record<string, unknown>, myself: () => Response = () => json(me)): Route {
  return (call) => {
    const path = call.url.pathname
    if (path === '/rest/api/3/myself') return myself()
    if (path === '/rest/api/3/issue/PROJ-1') return json({ key: 'PROJ-1', fields: { status: status('3', '处理中', 'indeterminate'), ...fields } })
    if (path === '/rest/api/3/issue/PROJ-1/transitions') return json({ transitions: [{ id: '31', name: 'Done', to: status('10001', 'Done', 'done') }] })
    return undefined
  }
}

describe('Jira ownership facts', () => {
  it('reports who the issue is with, who reported it, its type and its project, from the one read of the issue', async () => {
    const { fetch, calls } = fakeFetch(owned({ assignee: me, reporter: rita, issuetype: bug, project }))
    const provider = jiraProvider((credentials) => new JiraClient(credentials, fetch))
    expect(await provider.transitions!(settings, credential, 'PROJ-1', signal)).toEqual({
      status: '处理中',
      statusCategory: 'doing',
      statusId: '3',
      options: [{ id: '31', name: 'Done', category: 'done', toStatusId: '10001' }],
      viewer: { id: me.accountId, name: 'Mia Wang' },
      assignees: [{ id: me.accountId, name: 'Mia Wang' }],
      reporter: { id: rita.accountId, name: 'Rita QA' },
      type: { id: '10004', name: 'Bug' },
      scope: { id: 'PROJ', name: 'Project X' }
    })
    const reads = calls.filter((call) => call.url.pathname === '/rest/api/3/issue/PROJ-1')
    expect(reads.map((call) => call.url.searchParams.get('fields'))).toEqual(['status,assignee,reporter,issuetype,project'])
    expect(calls.filter((call) => call.url.pathname === '/rest/api/3/myself')).toHaveLength(1)
    expect(calls.every((call) => call.method === 'GET')).toBe(true)
  })

  it('reports an issue handed to someone else as theirs, and one with no assignee as no one\'s', async () => {
    const handed = fakeFetch(owned({ assignee: rita, reporter: me, issuetype: bug, project }))
    const theirs = await new JiraClient({ site, email: 'e', token: 't' }, handed.fetch).transitions('PROJ-1', signal)
    expect(theirs.viewer?.id).toBe(me.accountId)
    expect(theirs.assignees).toEqual([{ id: rita.accountId, name: 'Rita QA' }])

    const free = fakeFetch(owned({ assignee: null, reporter: null, issuetype: bug, project }))
    const result = await new JiraClient({ site, email: 'e', token: 't' }, free.fetch).transitions('PROJ-1', signal)
    expect(result.assignees).toEqual([])
    expect(result.reporter).toBeNull()
    expect(result.viewer).toEqual({ id: me.accountId, name: 'Mia Wang' })
  })

  it('leaves out the viewer and the people when Jira gives no accountId, as a Server install does', async () => {
    const server = { name: 'mia', key: 'JIRAUSER10000', displayName: 'Mia Wang' }
    const { fetch } = fakeFetch(owned({ assignee: server, reporter: server, issuetype: bug, project }, () => json(server)))
    const result = await new JiraClient({ site, email: 'e', token: 't' }, fetch).transitions('PROJ-1', signal)
    expect(Object.keys(result).sort()).toEqual(['options', 'scope', 'status', 'statusCategory', 'statusId', 'type'])
    expect(result.type).toEqual({ id: '10004', name: 'Bug' })
  })

  it('leaves out the viewer when the token may not read its own profile, and fails rather than go unchecked on a passing fault', async () => {
    const scoped = fakeFetch(owned({ assignee: me }, () => json({ errorMessages: ['forbidden'] }, 403)))
    const result = await new JiraClient({ site, email: 'e', token: 't' }, scoped.fetch).transitions('PROJ-1', signal)
    expect('viewer' in result).toBe(false)
    expect(result.assignees).toEqual([{ id: me.accountId, name: 'Mia Wang' }])
    expect(result.options.map((option) => option.id)).toEqual(['31'])

    const down = fakeFetch(owned({ assignee: me }, () => json({ errorMessages: ['try later'] }, 503)))
    await expect(new JiraClient({ site, email: 'e', token: 't' }, down.fetch).transitions('PROJ-1', signal)).rejects.toMatchObject({ code: 'request-failed' })
  })

  it('keeps the status and the moves when a fact comes in a shape it does not know', async () => {
    const { fetch } = fakeFetch(owned({ assignee: 'mia', reporter: 7, issuetype: [], project: { key: 'P'.repeat(501), name: 'Long' } }))
    const result = await new JiraClient({ site, email: 'e', token: 't' }, fetch).transitions('PROJ-1', signal)
    expect(Object.keys(result).sort()).toEqual(['options', 'status', 'statusCategory', 'statusId', 'viewer'])
  })

  it('gives each issue of a list and a fetched issue its type id and project', async () => {
    const row = (key: string, extra: Record<string, unknown> = {}) => ({
      key,
      fields: { summary: key, status: status('1', 'To Do', 'new'), priority: null, issuetype: bug, project, updated: null, ...extra }
    })
    const { fetch, calls } = fakeFetch((call) => {
      const path = call.url.pathname
      // PROJ-3 is as an older Jira or a proxy might send it: no type id, no project.
      if (path === '/rest/api/3/search/jql') return json({ issues: [row('PROJ-2'), row('PROJ-3', { issuetype: { name: 'Task' }, project: undefined })], isLast: true })
      if (path === '/rest/api/3/issue/PROJ-2') return json(row('PROJ-2', { description: null, attachment: [] }))
      if (path === '/rest/api/3/issue/PROJ-2/comment') return json({ comments: [], total: 0 })
      return undefined
    })
    const provider = jiraProvider((credentials) => new JiraClient(credentials, fetch))
    const [listed, bare] = await provider.list(settings, credential, signal)
    expect(listed).toMatchObject({ key: 'PROJ-2', type: 'Bug', typeId: '10004', scope: { id: 'PROJ', name: 'Project X' } })
    expect(SourceIssue.parse(listed)).toEqual(listed)
    expect(bare).toMatchObject({ key: 'PROJ-3', type: 'Task' })
    expect(bare && ('typeId' in bare || 'scope' in bare)).toBe(false)
    const fetched = await provider.fetch(settings, credential, 'PROJ-2', signal, { images: false })
    expect(fetched).toMatchObject({ key: 'PROJ-2', type: 'Bug', typeId: '10004', scope: { id: 'PROJ', name: 'Project X' } })
    for (const call of calls.filter((entry) => !entry.url.pathname.endsWith('/comment'))) {
      expect(call.url.searchParams.get('fields')?.split(',')).toEqual(expect.arrayContaining(['issuetype', 'project']))
    }
  })
})
