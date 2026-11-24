import { describe, expect, it, vi } from 'vitest'
import { SourceError } from '@antumi/plugin-sdk'
import { people, TapdClient, time } from './tapd-client.js'
import { tapdSource } from './tapd-source.js'
import { itemRef, itemUrl, parseWorkspace } from './tapd-url.js'

const signal = new AbortController().signal
const token = 'tapd-secret-token'
const ws = '20003271'
const storyId = '1120003271001000012'
const ok = (data: unknown) => Response.json({ status: 1, info: 'success', data })

type Route = (params: URLSearchParams) => Response
// TAPD's API: every reply in the {status, info, data} envelope, list rows wrapped by their type.
function server(routes: Record<string, Route>) {
  const calls: { path: string, params: URLSearchParams, init: RequestInit | undefined }[] = []
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input))
    expect(url.origin).toBe('https://api.tapd.cn')
    calls.push({ path: url.pathname, params: url.searchParams, init })
    const route = routes[url.pathname]
    if (!route) throw new Error(`unexpected request ${url.pathname}`)
    return route(url.searchParams)
  })
  return { fetcher, calls, client: new TapdClient(token, fetcher, async () => {}) }
}

const story = (id: string, extra: object = {}) => ({ Story: {
  id, name: `Story ${id}`, status: 'developing', owner: 'ann;bob;', creator: 'carl', priority: '', priority_label: 'High',
  created: '2026-11-01 09:00:00', modified: '2026-11-20 10:00:00', ...extra
} })
const routes = {
  '/users/info': () => ok({ id: '1', nick: 'ann', name: '安' }),
  '/workspaces/get_workspace_info': (params: URLSearchParams) => ok({ Workspace: { id: params.get('workspace_id'), name: '商城', category: 'project' } }),
  '/workflows/status_map': () => ok({ planning: '规划中', developing: '实现中', status_3: '已上线' }),
  '/workflows/last_steps': () => ok({ status_3: '已上线' })
}

describe('TAPD addresses', () => {
  it('reads the project from its ID or any page in either front end', () => {
    expect(parseWorkspace(` ${ws} `)).toBe(ws)
    expect(parseWorkspace(`https://www.tapd.cn/${ws}/prong/stories/stories_list`)).toBe(ws)
    expect(parseWorkspace(`https://www.tapd.cn/tapd_fe/${ws}/story/list`)).toBe(ws)
    expect(parseWorkspace(`https://www.tapd.cn/tapd_fe/t/index/${ws}?workitemId=1`)).toBe(ws)
    for (const value of ['', 'abc', 'http://www.tapd.cn/1/prong', 'https://tapd.cn.evil.example/1', 'https://user@www.tapd.cn/1', 'https://www.tapd.cn/company/list']) {
      expect(() => parseWorkspace(value), value).toThrow(SourceError)
    }
  })

  it('reads an item from its key or its page, and links back to it', () => {
    expect(itemRef(` STORY-${storyId} `)).toEqual({ kind: 'story', id: storyId })
    expect(itemRef(`https://www.tapd.cn/${ws}/prong/stories/view/${storyId}`)).toEqual({ kind: 'story', id: storyId })
    expect(itemRef(`https://www.tapd.cn/${ws}/prong/tasks/view/42/`)).toEqual({ kind: 'task', id: '42' })
    expect(itemRef(`https://www.tapd.cn/${ws}/bugtrace/bugs/view/43`)).toEqual({ kind: 'bug', id: '43' })
    expect(itemRef(`https://www.tapd.cn/${ws}/bugtrace/bugs/view?bug_id=44`)).toEqual({ kind: 'bug', id: '44' })
    expect(itemRef(`https://www.tapd.cn/tapd_fe/${ws}/bug/detail/45`)).toEqual({ kind: 'bug', id: '45' })
    expect(itemRef(`https://www.tapd.cn/tapd_fe/t/index/${ws}?workitemId=46`)).toEqual({ kind: 'story', id: '46' })
    for (const value of ['12', 'epic-12', 'story-0', `https://evil.example/${ws}/prong/stories/view/1`, `https://www.tapd.cn/${ws}/prong/stories/view/1x`]) {
      expect(() => itemRef(value), value).toThrow(SourceError)
    }
    expect(itemUrl(ws, 'story', '1', false)).toBe(`https://www.tapd.cn/${ws}/prong/stories/view/1`)
    expect(itemUrl(ws, 'story', '1', true)).toBe(`https://www.tapd.cn/tapd_fe/t/index/${ws}?workitemId=1`)
    expect(itemUrl(ws, 'bug', '1', true)).toBe(`https://www.tapd.cn/${ws}/bugtrace/bugs/view/1`)
  })

  it('normalizes settings and keys', () => {
    const source = tapdSource()
    expect(source.normalizeSettings({ workspace: `https://www.tapd.cn/${ws}/prong/stories/stories_list` })).toEqual({ workspace: ws, kind: 'story', assignee: '@me', state: 'active' })
    expect(source.normalizeSettings({ workspace: ws, kind: 'bug', assignee: ' bob ', state: 'all' })).toEqual({ workspace: ws, kind: 'bug', assignee: 'bob', state: 'all' })
    expect(() => source.normalizeSettings({ workspace: ws, kind: 'epic' })).toThrow(SourceError)
    expect(() => source.normalizeSettings({ workspace: ws, assignee: 'ann;bob' })).toThrow(SourceError)
    expect(source.normalizeKey?.(`https://www.tapd.cn/${ws}/bugtrace/bugs/view/43`)).toBe('bug-43')
  })

  it('reads Beijing time and owner lists', () => {
    expect(time('2026-11-20 10:00:00')).toBe(Date.parse('2026-11-20T02:00:00Z'))
    expect(time('0000-00-00 00:00:00')).toBeNull()
    expect(time('')).toBeNull()
    expect(people('ann;bob;')).toEqual(['ann', 'bob'])
  })
})

describe('TAPD client', () => {
  it('checks a token with the current user before saving it', async () => {
    const { fetcher, client } = server(routes)
    const source = tapdSource(() => client)
    const result = await source.login({ prompt: async () => ` ${token} `, notify: () => {} }, {}, signal)
    expect(result).toEqual({ credential: { kind: 'token', payload: { token } }, account: '安 (ann)' })
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ headers: { Authorization: `Bearer ${token}` }, redirect: 'error' })
  })

  it('asks again for a rejected token', async () => {
    let calls = 0
    // What api.tapd.cn answers a bearer token it does not know (2026-11-24).
    const invalid = () => Response.json({ status: 422, data: '', info: 'The access token provided is invalid', meta: { request_id: 'abc123' } }, { status: 422 })
    const { client } = server({ '/users/info': () => ++calls === 1 ? invalid() : ok({ nick: 'ann', name: 'ann' }) })
    const prompts: (string | undefined)[] = []
    const result = await tapdSource(() => client).login({ prompt: async (prompt) => { prompts.push(prompt.error); return 'key' }, notify: () => {} }, {}, signal)
    expect(result.account).toBe('ann')
    expect(prompts).toEqual([undefined, '令牌无效或已失效，请重新输入'])
  })

  it('syncs my unfinished stories, matching the handler exactly and naming statuses', async () => {
    const { calls, client } = server({
      ...routes,
      '/stories': () => ok([
        story('1120003271001000001', { modified: '2026-11-19 10:00:00' }),
        story('1120003271001000002', { owner: 'annie;' }),
        story('1120003271001000003', { status: 'status_3' }),
        story('1120003271001000004', { status: 'status_9', modified: '2026-11-21 08:00:00', priority_label: '' })
      ])
    })
    const issues = await client.list({ workspace: ws, kind: 'story', assignee: '@me', state: 'active' }, signal)
    expect(issues).toEqual([
      { key: 'story-1120003271001000004', title: 'Story 1120003271001000004', url: `https://www.tapd.cn/${ws}/prong/stories/view/1120003271001000004`,
        status: 'status_9', statusCategory: 'unknown', type: '需求', priority: null, updatedAt: Date.parse('2026-11-21T00:00:00Z') },
      expect.objectContaining({ key: 'story-1120003271001000001', status: '实现中', statusCategory: 'doing', priority: '高' })
    ])
    const list = calls.find((call) => call.path === '/stories')
    expect(Object.fromEntries(list?.params ?? [])).toEqual({ workspace_id: ws, limit: '200', page: '1', order: 'modified desc', owner: 'ann' })
  })

  it('filters bugs by their current handler and falls back to built-in final statuses', async () => {
    const { calls, client } = server({
      ...routes,
      '/workflows/last_steps': () => new Response('missing', { status: 404 }),
      '/bugs': () => ok([
        { Bug: { id: '11', title: 'Crash', status: 'resolved', current_owner: 'bob', priority: 'urgent', modified: '2026-11-20 10:00:00' } },
        { Bug: { id: '12', title: 'Typo', status: 'new', current_owner: 'bob', priority: 'low', modified: '2026-11-20 11:00:00' } }
      ])
    })
    const all = await client.list({ workspace: ws, kind: 'bug', assignee: 'bob', state: 'all' }, signal)
    expect(all.map((issue) => [issue.key, issue.statusCategory, issue.priority])).toEqual([['bug-12', 'todo', '低'], ['bug-11', 'done', '紧急']])
    expect(calls.find((call) => call.path === '/bugs')?.params.get('current_owner')).toBe('bob')
    expect(calls.some((call) => call.path === '/users/info')).toBe(false)
  })

  it('pages until a short page and uses the fixed task workflow', async () => {
    const page = (n: number, count: number) => Array.from({ length: count }, (_, i) => ({ Task: { id: String(n * 1000 + i + 1), name: 'T', status: i === 0 ? 'done' : 'open', owner: '', modified: '2026-11-20 10:00:00' } }))
    const { calls, client } = server({ ...routes, '/tasks': (params) => ok(page(Number(params.get('page')), params.get('page') === '1' ? 200 : 3)) })
    const issues = await client.list({ workspace: ws, kind: 'task', assignee: '', state: 'active' }, signal)
    expect(issues).toHaveLength(200)
    expect(issues[0]).toMatchObject({ type: '任务', status: '未开始', statusCategory: 'todo' })
    expect(calls.filter((call) => call.path === '/tasks')).toHaveLength(2)
    expect(calls.some((call) => call.path.startsWith('/workflows'))).toBe(false)
  })

  it('links stories in lightweight projects to the new front end', async () => {
    const { client } = server({ ...routes, '/workspaces/get_workspace_info': () => ok({ Workspace: { id: ws, name: '轻量', category: 'mini_project' } }), '/stories': () => ok([story('7')]) })
    expect((await client.list({ workspace: ws, kind: 'story', assignee: '', state: 'all' }, signal))[0]?.url).toBe(`https://www.tapd.cn/tapd_fe/t/index/${ws}?workitemId=7`)
  })

  it('fetches the description, attachments and comments into a snapshot', async () => {
    const { calls, client } = server({
      ...routes,
      '/stories': (params) => ok([story(storyId, params.get('fields') ? { description: '<p>Steps <img src="/tfl/captures/a.png"></p>' } : {})]),
      '/attachments': () => ok([{ Attachment: { id: '9', filename: 'log.txt' } }]),
      '/comments': () => ok([
        { Comment: { id: '502', description: '<p>Second</p>', author: 'bob', created: '2026-11-20 12:00:00', modified: '2026-11-20 12:00:00' } },
        { Comment: { id: '501', description: '<p>First</p>', author: 'ann', created: '2026-11-20 11:00:00', modified: '2026-11-20 11:30:00' } }
      ])
    })
    const issue = await client.issue(ws, 'story', storyId, signal)
    expect(issue.markdown).toContain(`# story-${storyId} Story ${storyId}`)
    expect(issue.markdown).toContain('处理人：ann、bob')
    expect(issue.markdown).toContain('![](https://www.tapd.cn/tfl/captures/a.png)')
    expect(issue.markdown).toContain('- log.txt')
    expect(issue.markdown.indexOf('First')).toBeLessThan(issue.markdown.indexOf('Second'))
    expect(issue.markdown).not.toContain('<p>')
    expect(issue.commentState?.comments.map((comment) => [comment.id, comment.author, comment.updatedAt])).toEqual([
      ['501', 'ann', Date.parse('2026-11-20T03:30:00Z')], ['502', 'bob', null]
    ])
    expect(issue.commentState?.checkpoint).toEqual({ createdAt: Date.parse('2026-11-20T04:00:00Z'), ids: ['502'] })
    expect(calls.find((call) => call.path === '/comments')?.params.get('entry_type')).toBe('stories')
  })

  it('keeps the item when comments or attachments fail', async () => {
    const { client } = server({
      ...routes,
      '/bugs': () => ok([{ Bug: { id: '11', title: 'Crash', status: 'new', current_owner: 'bob', reporter: 'carl', description: '<p>Boom</p>' } }]),
      '/attachments': () => new Response('no', { status: 403 }),
      '/comments': () => Response.json({ status: 0, info: 'no permission', data: null })
    })
    const issue = await client.issue(ws, 'bug', '11', signal)
    expect(issue.markdown).toContain('创建人：carl')
    expect(issue.markdown).toContain('附件未能获取')
    expect(issue.markdown).toContain('评论未能获取')
    expect(issue.commentState).toBeUndefined()
  })

  it('reads bug comments from both comment types for later syncs', async () => {
    const { calls, client } = server({
      ...routes,
      '/comments': (params) => ok(params.get('entry_type') === 'bug'
        ? [{ Comment: { id: '1', description: 'a', author: 'ann', created: '2026-11-20 10:00:00' } }]
        : [{ Comment: { id: '2', description: 'b', author: 'bob', created: '2026-11-20 11:00:00' } }])
    })
    const page = await client.commentChanges(ws, 'bug', '11', signal, { checkpoint: { createdAt: Date.parse('2026-11-20T02:00:00Z'), ids: ['1'] }, continuation: null })
    expect(page.comments.map((comment) => comment.id)).toEqual(['2'])
    expect(page.comments[0]?.url).toBe(`https://www.tapd.cn/${ws}/bugtrace/bugs/view/11`)
    expect(calls.filter((call) => call.path === '/comments').map((call) => call.params.get('entry_type'))).toEqual(['bug', 'bug_remark'])
  })

  it('reports a missing item', async () => {
    const { client } = server({ ...routes, '/stories': () => ok([]) })
    await expect(client.issue(ws, 'story', '1', signal)).rejects.toMatchObject({ code: 'not-found' })
  })
})

describe('TAPD requests', () => {
  it('retries rate limits and server errors, then gives up', async () => {
    let count = 0
    const { client } = server({ '/users/info': () => ++count < 3 ? new Response(null, { status: 429 }) : ok({ nick: 'ann' }) })
    await expect(client.user(signal)).resolves.toMatchObject({ nick: 'ann' })
    const busy = server({ '/users/info': () => new Response(null, { status: 429 }) })
    await expect(busy.client.user(signal)).rejects.toMatchObject({ code: 'request-failed', message: expect.stringContaining('限流') })
    expect(busy.fetcher).toHaveBeenCalledTimes(3)
  })

  it('maps HTTP and envelope failures without leaking the token or the body', async () => {
    for (const [status, code] of [[401, 'auth-failed'], [403, 'forbidden'], [500, 'request-failed']] as const) {
      const { client } = server({ '/users/info': () => new Response(token, { status }) })
      const failure = await client.user(signal).catch((error: unknown) => error)
      expect(failure).toMatchObject({ code })
      expect(String(failure instanceof Error ? failure.message : '')).not.toContain(token)
    }
    const echo = server({ '/users/info': () => Response.json({ status: 0, info: `bad token ${token}`, data: null }) })
    const failure = await echo.client.user(signal).catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: 'request-failed', message: 'TAPD 未能完成请求（bad token ***）' })
    const denied = server({ '/users/info': () => Response.json({ status: 403, data: '', info: 'no permission', meta: { request_id: 'r-1' } }, { status: 403 }) })
    await expect(denied.client.user(signal)).rejects.toMatchObject({ code: 'forbidden', message: '这个令牌没有权限访问该项目或接口（no permission，request_id r-1）' })
    const invalid = server({ '/users/info': () => Response.json({ status: 422, data: '', info: 'workspace_id is required' }, { status: 422 }) })
    await expect(invalid.client.user(signal)).rejects.toMatchObject({ code: 'request-failed', message: 'TAPD 未能完成请求（HTTP 422，workspace_id is required）' })
    const html = server({ '/users/info': () => new Response('<html>login</html>') })
    await expect(html.client.user(signal)).rejects.toMatchObject({ code: 'request-failed' })
  })

  it('rejects oversized replies and numeric IDs', async () => {
    const large = server({ '/users/info': () => new Response('x', { headers: { 'content-length': '9999999' } }) })
    await expect(large.client.user(signal)).rejects.toMatchObject({ code: 'response-too-large' })
    const numeric = server({ ...routes, '/stories': () => ok([{ Story: { id: 1120003271, name: 'x' } }]) })
    await expect(numeric.client.issue(ws, 'story', storyId, signal)).rejects.toMatchObject({ code: 'request-failed' })
  })
})

describe('TAPD writeback', () => {
  const form = (call: { init: RequestInit | undefined } | undefined) => Object.fromEntries(call?.init?.body instanceof URLSearchParams ? call.init.body : [])
  // all_transitions as documented: one rule per move between status keys, including staying put.
  const workflow = {
    ...routes,
    '/workflows/all_transitions': () => ok([
      { Name: 'planning-planning', StepPrevious: 'planning', StepNext: 'planning' },
      { Name: 'planning-developing', StepPrevious: 'planning', StepNext: 'developing' },
      { Name: 'planning-status_3', StepPrevious: 'planning', StepNext: 'status_3' },
      { Name: 'planning-status_7', StepPrevious: 'planning', StepNext: 'status_7' },
      { Name: 'developing-planning', StepPrevious: 'developing', StepNext: 'planning' }
    ])
  }

  it('lists the moves the workflow allows from the current status, named and sorted into categories', async () => {
    const { calls, client } = server({ ...workflow, '/stories': () => ok([story(storyId, { status: 'planning', workitem_type_id: '1120003271000000001' })]) })
    const result = await tapdSource(() => client).transitions?.({ workspace: ws }, { kind: 'token', payload: { token } }, `story-${storyId}`, signal)
    expect(result).toEqual({
      status: '规划中', statusCategory: 'todo',
      options: [
        { id: 'developing', name: '实现中', category: 'doing' },
        { id: 'status_3', name: '已上线', category: 'done' },
        { id: 'status_7', name: 'status_7', category: 'unknown' }
      ]
    })
    // The story's category picks its workflow.
    for (const path of ['/workflows/all_transitions', '/workflows/status_map']) {
      expect(Object.fromEntries(calls.find((call) => call.path === path)?.params ?? [])).toEqual({ workspace_id: ws, system: 'story', workitem_type_id: '1120003271000000001' })
    }
  })

  it('offers the other fixed statuses for a task', async () => {
    const { calls, client } = server({ ...routes, '/tasks': () => ok([{ Task: { id: '42', name: 'T', status: 'progressing' } }]) })
    expect(await client.transitions(ws, 'task', '42', signal)).toEqual({
      status: '进行中', statusCategory: 'doing',
      options: [{ id: 'open', name: '未开始', category: 'todo' }, { id: 'done', name: '已完成', category: 'done' }]
    })
    expect(calls.some((call) => call.path.startsWith('/workflows'))).toBe(false)
  })

  it('moves a bug by its status key and reports where it landed', async () => {
    const { calls, client } = server({
      ...routes,
      '/workflows/all_transitions': () => ok([{ Name: 'new-resolved', StepPrevious: 'new', StepNext: 'resolved' }]),
      '/workflows/status_map': () => ok({ new: '新', resolved: '已解决' }),
      '/workflows/last_steps': () => ok({ resolved: '已解决' }),
      '/bugs': (params) => params.get('id') ? ok([{ Bug: { id: '11', title: 'Crash', status: 'new' } }]) : ok({ Bug: { id: '11', title: 'Crash', status: 'resolved' } })
    })
    expect(await client.transition(ws, 'bug', '11', 'resolved', signal)).toEqual({ status: '已解决', statusCategory: 'done' })
    const write = calls.find((call) => call.init?.method === 'POST')
    expect(write?.path).toBe('/bugs')
    expect([...write?.params ?? []]).toEqual([])
    expect(form(write)).toEqual({ workspace_id: ws, id: '11', status: 'resolved', current_user: 'ann' })
    expect(write?.init).toMatchObject({ redirect: 'error', headers: { Authorization: `Bearer ${token}` } })
  })

  it('reads the status back when the update does not return it', async () => {
    let updated = false
    const { client } = server({
      ...routes,
      '/tasks': (params) => params.get('id') ? ok([{ Task: { id: '42', name: 'T', status: updated ? 'done' : 'open' } }]) : (updated = true, ok(null))
    })
    expect(await client.transition(ws, 'task', '42', 'done', signal)).toEqual({ status: '已完成', statusCategory: 'done' })
  })

  it('refuses a move the workflow does not allow now, without writing', async () => {
    const { calls, client } = server({ ...workflow, '/stories': () => ok([story(storyId, { status: 'developing' })]) })
    for (const target of ['status_3', 'developing', 'x'.repeat(600)]) {
      await expect(client.transition(ws, 'story', storyId, target, signal)).rejects.toMatchObject({ code: 'request-failed', message: expect.stringContaining('不能流转') })
    }
    expect(calls.some((call) => call.init?.method === 'POST')).toBe(false)
  })

  it('posts a comment as HTML and returns the id comment sync reads back', async () => {
    const { calls, client } = server({
      ...routes,
      '/stories': () => ok([story(storyId)]),
      '/comments': (params) => params.get('entry_id')
        ? ok([{ Comment: { id: '1120003271000000501', description: '<p>Done</p>', author: 'ann', created: '2026-11-24 10:00:00' } }])
        : ok({ Comment: { id: '1120003271000000501', description: '<p>Done</p>', author: 'ann', entry_type: 'stories', entry_id: storyId, created: '2026-11-24 10:00:00' } })
    })
    const source = tapdSource(() => client)
    const posted = await source.comment?.({ workspace: ws }, { kind: 'token', payload: { token } }, `story-${storyId}`, { markdown: '修好了，见 [PR #3](https://github.com/a/b/pull/3)。\n\n- 改了 `login.ts`\n- 加了测试', writeId: crypto.randomUUID() }, signal)
    const synced = await client.commentChanges(ws, 'story', storyId, signal, { checkpoint: { createdAt: 0, ids: [] }, continuation: null })
    expect(posted).toEqual({ id: synced.comments[0]?.id, url: `https://www.tapd.cn/${ws}/prong/stories/view/${storyId}` })
    const write = calls.find((call) => call.init?.method === 'POST')
    expect(form(write)).toEqual({
      workspace_id: ws, entry_type: 'stories', entry_id: storyId, author: 'ann',
      description: '<p>修好了，见 <a href="https://github.com/a/b/pull/3">PR #3</a>。</p><ul><li>改了 <code>login.ts</code></li><li>加了测试</li></ul>'
    })
  })

  it('posts bug comments as bug comments and reports a missing item', async () => {
    const { calls, client } = server({ ...routes, '/bugs': () => ok([]), '/comments': () => ok({ Comment: { id: '1' } }) })
    await expect(client.comment(ws, 'bug', '11', 'hi', signal)).rejects.toMatchObject({ code: 'not-found' })
    expect(calls.some((call) => call.init?.method === 'POST')).toBe(false)
    const bug = server({ ...routes, '/bugs': () => ok([{ Bug: { id: '11', title: 'Crash', status: 'new' } }]), '/comments': () => ok({ Comment: { id: '9' } }) })
    expect(await bug.client.comment(ws, 'bug', '11', 'hi', signal)).toEqual({ id: '9', url: `https://www.tapd.cn/${ws}/bugtrace/bugs/view/11` })
    expect(form(bug.calls.find((call) => call.init?.method === 'POST'))).toMatchObject({ entry_type: 'bug', description: '<p>hi</p>' })
  })

  it('asks for a token with write permission when TAPD refuses the write', async () => {
    // What TAPD answers an account without the project permission (reported by tapd-in-dsh).
    const refuse = () => Response.json({ status: 403, data: '', info: "user 1 doesn't have permission comments::add of workspace 20003271" }, { status: 403 })
    const { client } = server({ ...routes, '/stories': () => ok([story(storyId)]), '/comments': refuse })
    const failure = await client.comment(ws, 'story', storyId, 'hi', signal).catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: 'forbidden', message: expect.stringMatching(/写入权限.*添加评论.*重新登录/) })
    expect(String(failure instanceof Error ? failure.message : '')).not.toContain(token)
    const story403 = server({ ...routes, '/tasks': (params) => params.get('id') ? ok([{ Task: { id: '42', status: 'open' } }]) : Response.json({ status: 403, info: 'no', data: '' }) })
    await expect(story403.client.transition(ws, 'task', '42', 'done', signal)).rejects.toMatchObject({ code: 'forbidden', message: expect.stringContaining('编辑任务') })
  })

  it('does not resend a write after a server error', async () => {
    const { fetcher, client } = server({ ...routes, '/stories': () => ok([story(storyId)]), '/comments': () => new Response(null, { status: 502 }) })
    await expect(client.comment(ws, 'story', storyId, 'hi', signal)).rejects.toMatchObject({ code: 'request-failed' })
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
  })
})

describe('Markdown to TAPD HTML', () => {
  it('keeps paragraphs, line breaks, lists, links and code, escaping everything else', async () => {
    const { markdownToHtml } = await import('./tapd-html.js')
    expect(markdownToHtml('第一行\n第二行\n\n## 结果\n1. 一\n2. **二** <b>\n\n> 引用')).toBe(
      '<p>第一行<br>第二行</p><h2>结果</h2><ol><li>一</li><li><strong>二</strong> &lt;b&gt;</li></ol><blockquote><p>引用</p></blockquote>')
    expect(markdownToHtml('```ts\nif (a < b) "x"\n```\n见 https://x.test/a?b=1&c=2。')).toBe(
      '<pre><code>if (a &lt; b) &quot;x&quot;</code></pre><p>见 <a href="https://x.test/a?b=1&amp;c=2">https://x.test/a?b=1&amp;c=2</a>。</p>')
    expect(markdownToHtml('[x](javascript:alert(1)) <img src=x onerror=alert(1)>')).toBe('<p>[x](javascript:alert(1)) &lt;img src=x onerror=alert(1)&gt;</p>')
    expect(markdownToHtml('`<a href="x">`')).toBe('<p><code>&lt;a href=&quot;x&quot;&gt;</code></p>')
  })
})
