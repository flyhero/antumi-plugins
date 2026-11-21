import { describe, expect, it, vi } from 'vitest'
import { SourceError } from '@antumi/plugin-sdk'
import { McpSession, parseFrame, toolFailure } from './mcp-session.js'
import { MeegleClient } from './meegle-client.js'
import { buildMql, day, DEFAULT_FILTER, normalizeFilter } from './meegle-mql.js'
import { meegleSource } from './meegle-source.js'
import { itemId, parseSpace } from './meegle-url.js'

const signal = new AbortController().signal
const token = 'm-12345678-aaaa-bbbb-cccc-1234567890ab'
const space = { host: 'project.larksuite.com', simpleName: 'shop' }
const settings = { space: 'https://project.larksuite.com/shop', types: 'story,issue', filter: DEFAULT_FILTER }

type Tool = (args: Record<string, unknown>) => unknown
// A Meegle MCP server: a session from initialize, then tool results as text content beside a log id.
function server(tools: Record<string, Tool>, options: { sse?: boolean } = {}) {
  const calls: { name: string, args: Record<string, unknown>, headers: Record<string, string> }[] = []
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body))
    const headers = Object.fromEntries(Object.entries(init?.headers ?? {}))
    if (body.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-03-26' } }, { headers: { 'mcp-session-id': 'session-1' } })
    if (body.method !== 'tools/call') return new Response(null, { status: 202 })
    calls.push({ name: body.params.name, args: body.params.arguments, headers })
    const tool = tools[body.params.name]
    if (!tool) throw new Error(`unexpected tool ${body.params.name}`)
    let result: unknown
    try { result = { content: [{ type: 'text', text: JSON.stringify(tool(body.params.arguments)) }, { type: 'text', text: 'log_id: 2026abc' }] } }
    catch (failure) { result = { isError: true, content: [{ type: 'text', text: String(failure instanceof Error ? failure.message : failure) }, { type: 'text', text: 'log_id: 2026err' }] } }
    const reply = JSON.stringify({ jsonrpc: '2.0', id: body.id, result })
    return options.sse ? new Response(`event: message\ndata: ${reply}\n\n`, { headers: { 'content-type': 'text/event-stream' } }) : new Response(reply)
  })
  return { fetcher, calls, session: new McpSession(space.host, token, fetcher, async () => {}) }
}

const field = (key: string, value: object) => ({ key, value })
const row = (id: number, name: string, extra: object[] = []) => ({ moql_field_list: [
  field('work_item_id', { long_value: id }), field('name', { string_value: name }),
  field('work_item_status', { key_label_value_list: [{ key: 'doing', label: 'In progress' }] }),
  field('priority', { key_label_value: { key: '1', label: 'P1' } }), field('updated_at', { string_value: '2026-11-20' }), ...extra
] })
const types = () => ({ list: [{ type_key: 'story', name: 'Story', api_name: 'story' }, { type_key: 'issue', name: 'Defect', api_name: 'issue' }, { type_key: '63f0a1', name: 'Review', api_name: 'review_process' }] })

describe('space address', () => {
  it('takes the site from the address and the space from its first segment', () => {
    expect(parseSpace('https://project.larksuite.com/shop/overview')).toEqual(space)
    expect(parseSpace(' https://www.meegle.com/meego/shop/story/detail/12?x=1 ')).toEqual({ host: 'meegle.com', simpleName: 'shop' })
    expect(parseSpace('https://project.feishu.cn/shop')).toEqual({ host: 'project.feishu.cn', simpleName: 'shop' })
    for (const url of ['http://project.feishu.cn/shop', 'https://evil.example/shop', 'https://project.feishu.cn.evil.example/shop', 'https://user@project.feishu.cn/shop', 'https://project.feishu.cn:8443/shop', 'https://project.feishu.cn/b/mcp', 'https://project.feishu.cn/', 'shop']) {
      expect(() => parseSpace(url), url).toThrow(SourceError)
    }
  })

  it('reads a work item ID from itself, #ID or its page', () => {
    expect(itemId(' 7092625364 ')).toBe('7092625364')
    expect(itemId('#12')).toBe('12')
    expect(itemId('https://project.larksuite.com/shop/story/detail/12?tab=1')).toBe('12')
    for (const key of ['story-12', '0', 'https://project.larksuite.com/shop/overview']) expect(() => itemId(key)).toThrow(SourceError)
  })
})

describe('MQL', () => {
  it('wraps the user condition with the space, the type and the columns the inbox reads', () => {
    expect(buildMql('shop', 'issue', DEFAULT_FILTER)).toBe('SELECT `work_item_id`, `name`, `work_item_status`, `priority`, `updated_at`, `archiving_status` FROM `shop`.`issue` WHERE array_contains(all_participate_persons(), current_login_user()) AND `archiving_status` = false ORDER BY `updated_at` DESC')
    expect(buildMql('sh`op', 'story', '`owner` = current_login_user()')).toContain('FROM `shop`.`story` WHERE `owner` = current_login_user() ORDER BY')
  })

  it('keeps the filter to a condition', () => {
    expect(normalizeFilter('  ')).toBe(DEFAULT_FILTER)
    expect(normalizeFilter(' array_contains(`current_status_operator`,\n current_login_user()) ')).toBe('array_contains(`current_status_operator`, current_login_user())')
    expect(normalizeFilter("`name` LIKE '%select from%'")).toBe("`name` LIKE '%select from%'")
    for (const filter of ['1=1 ORDER BY `name`', '1=1 LIMIT 5', 'x IN (SELECT y FROM z)', '1=1; DROP']) expect(() => normalizeFilter(filter), filter).toThrow(SourceError)
  })

  it('reads day-only dates', () => {
    expect(day('2026-11-20')).toBe(Date.UTC(2026, 10, 20))
    expect(day(null)).toBeNull()
    expect(day('soon')).toBeNull()
  })
})

describe('MCP session', () => {
  it('opens a session and sends the token in X-Mcp-Token on every call', async () => {
    const { session, calls, fetcher } = server({ search_user_info: () => [{ user_key: '7001', name_cn: '安' }] }, { sse: true })
    expect(await new MeegleClient(session).user(signal)).toBe('安')
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://project.larksuite.com/mcp_server/v1')
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error' })
    expect(calls[0]?.headers).toMatchObject({ 'X-Mcp-Token': token, 'Mcp-Session-Id': 'session-1' })
    expect(calls[0]?.headers).not.toHaveProperty('Authorization')
  })

  it('parses SSE frames and tool failures whose message holds commas', () => {
    expect(parseFrame('event: message\ndata: {"a":1}\n\ndata: {"a":2}\n')).toEqual({ a: 2 })
    expect(toolFailure('error=RPCError,message=busy, try later,retriable=true')).toEqual({ code: 'RPCError', message: 'busy, try later', retriable: true })
  })

  it('explains a rejected token and a disabled MCP switch without echoing the token', async () => {
    const rejected = new McpSession(space.host, token, vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 401 })))
    await expect(new MeegleClient(rejected).user(signal)).rejects.toMatchObject({ code: 'auth-failed', message: expect.stringContaining('https://project.larksuite.com/b/mcp') })
    const { session } = server({ search_user_info: () => { throw new Error(`error=MCPPersonalPreferenceDisabled,message=user has not enabled this MCP feature ${token},retriable=false`) } })
    const failure = new MeegleClient(session).user(signal)
    await expect(failure).rejects.toMatchObject({ code: 'auth-failed', message: expect.stringContaining('MCP 开关') })
    await expect(failure).rejects.not.toThrow(token)
  })

  it('retries a busy server and reopens an expired session', async () => {
    let busy = 1
    const { session, calls } = server({ search_user_info: () => { if (busy-- > 0) throw new Error('error=RPCError,message=error_code=1606 onDynamicOverload,retriable=true'); return [{ name_en: 'Ann' }] } })
    expect(await new MeegleClient(session).user(signal)).toBe('Ann')
    expect(calls).toHaveLength(2)

    let first = true
    const inner = server({ search_user_info: () => [{ name_en: 'Ann' }] })
    const expiring = vi.fn<typeof fetch>(async (url, init) => {
      if (JSON.parse(String(init?.body)).method === 'tools/call' && first) { first = false; return new Response(null, { status: 404 }) }
      return inner.fetcher(url, init)
    })
    expect(await new MeegleClient(new McpSession(space.host, token, expiring, async () => {})).user(signal)).toBe('Ann')
    expect(expiring.mock.calls.filter(([, init]) => JSON.parse(String(init?.body)).method === 'initialize')).toHaveLength(2)
  })

  it('maps a missing permission and gives up on a server that stays busy', async () => {
    const { session } = server({ search_user_info: () => { throw new Error('error=ErrWorkItemNoPermission,message=no permission,retriable=false') } })
    await expect(new MeegleClient(session).user(signal)).rejects.toMatchObject({ code: 'forbidden', message: expect.stringContaining('2026err') })
    const busy = server({ search_user_info: () => { throw new Error('error=RPCError,message=busy,retriable=true') } })
    await expect(new MeegleClient(busy.session).user(signal)).rejects.toMatchObject({ code: 'request-failed' })
    expect(busy.calls).toHaveLength(3)
  })
})

describe('sync', () => {
  it('pages each type through the MQL session and merges newest first', async () => {
    const page1 = Array.from({ length: 50 }, (_, index) => row(1000 + index, `Story ${index}`))
    const { session, calls } = server({
      list_workitem_types: types,
      search_by_mql: (args) => {
        if (String(args.mql ?? '').includes('`issue`')) return { list: [{ count: 1 }], data: { 1: [row(7, 'Crash', [field('updated_at', { string_value: '2026-11-21' })])] }, session_id: 's2' }
        if (args.session_id) return { list: null, session_id: null, data: { 1: [row(2000, 'Story late')] } }
        return { list: [{ count: 51, group_infos: [{ group_id: '1' }] }], data: { 1: page1 }, session_id: 's1' }
      }
    })
    const issues = await new MeegleClient(session).list(space, { types: ['story', 'issue'], filter: DEFAULT_FILTER }, signal)
    expect(issues).toHaveLength(52)
    expect(issues[0]).toEqual({ key: '7', title: 'Crash', url: 'https://project.larksuite.com/shop/issue/detail/7', status: 'In progress', statusCategory: 'unknown', type: 'Defect', priority: 'P1', updatedAt: Date.UTC(2026, 10, 21) })
    expect(calls.map((call) => call.name)).toEqual(['list_workitem_types', 'search_by_mql', 'search_by_mql', 'search_by_mql'])
    expect(calls[2]?.args).toEqual({ project_key: 'shop', session_id: 's1', group_pagination_list: [{ group_id: '1', page_num: 2 }] })
  })

  it('links custom types by their route name and marks archived items done', async () => {
    const { session } = server({ list_workitem_types: types, search_by_mql: () => ({ list: [{ count: 1 }], data: { 1: [row(9, 'Review', [field('archiving_status', { bool_value: true })])] } }) })
    expect(await new MeegleClient(session).list(space, { types: ['63f0a1'], filter: 'work_item_id > 0' }, signal)).toMatchObject([{ url: 'https://project.larksuite.com/shop/review_process/detail/9', statusCategory: 'done', type: 'Review' }])
  })

  it('names the available types when one is unknown, and handles an empty result', async () => {
    const { session } = server({ list_workitem_types: types, search_by_mql: () => ({ list: null, data: {}, session_id: 's' }) })
    const client = new MeegleClient(session)
    await expect(client.list(space, { types: ['bug'], filter: DEFAULT_FILTER }, signal)).rejects.toMatchObject({ code: 'invalid-settings', message: expect.stringContaining('story、issue、63f0a1') })
    expect(await client.list(space, { types: ['story'], filter: DEFAULT_FILTER }, signal)).toEqual([])
  })
})

describe('detail', () => {
  const attribute = {
    work_item_name: 'Fix login', work_item_type: { key: 'issue', name: 'Defect', api_name: 'issue' }, owned_project: { key: '63ab', simple_name: 'shop' },
    work_item_status: { key: 'doing', name: 'In progress' }, update_time: '2026-11-20T10:39:58+08:00', create_time: '2026-11-01T09:00:00+08:00',
    role_members: [{ key: 'reporter', name: 'Reporter', members: [{ key: '7002', name: 'Bob' }] }]
  }

  it('merges field pages into a snapshot with people, fields and recent comments', async () => {
    const { session, calls } = server({
      get_workitem_brief: (args) => args.page_token
        ? { work_item_attribute: attribute, work_item_fields: [field('business', { label: 'Payments' })], pagination: { has_more: false } }
        : { work_item_attribute: attribute, work_item_current_node: [{ name: 'Fixing' }], pagination: { has_more: true, next_page_token: 'business' },
          work_item_fields: [{ key: 'description', name: 'Description', value: 'Steps\n\n![shot](https://x/y.png)<!--file_token-->' }, { key: 'priority', value: { label: 'P0' } }, { key: 'current_status_operator', value: [{ key: '7001', name_en: 'Ann' }] }] },
      list_workitem_comments: () => ({ comments: [{ content: 'Seen it @Ann<!-- mention:{"id":"7001"} -->', creator: { name: 'Bob' }, created_at: '2026-11-02 10:00:00' }] })
    })
    const issue = await new MeegleClient(session).issue(space, '12', signal)
    expect(issue).toMatchObject({ key: '12', title: 'Fix login', url: 'https://project.larksuite.com/shop/issue/detail/12', status: 'In progress', type: 'Defect', priority: 'P0', updatedAt: Date.parse('2026-11-20T10:39:58+08:00') })
    for (const text of ['当前负责人：Ann', 'Reporter：Bob', '当前节点：Fixing', '![shot](https://x/y.png)', '- business：Payments', '### Bob · 2026-11-02 10:00:00', 'Seen it @Ann']) expect(issue.markdown).toContain(text)
    expect(issue.markdown).not.toContain('<!--')
    expect(calls[0]?.args).toEqual({ project_key: 'shop', work_item_id: '12', fields: ['_all'], page_size: 200 })
    expect(calls[1]?.args).toMatchObject({ page_token: 'business' })
  })

  it('keeps the text when comments fail and reports a missing item', async () => {
    const { session } = server({ get_workitem_brief: () => ({ work_item_attribute: attribute, work_item_fields: [] }), list_workitem_comments: () => { throw new Error('error=RPCError,message=x,retriable=false') } })
    expect((await new MeegleClient(session).issue(space, '12', signal)).markdown).toContain('（评论未能获取）')
    const missing = server({ get_workitem_brief: () => { throw new Error('error=WorkItemNotFound,message=gone,retriable=false') } })
    await expect(new MeegleClient(missing.session).issue(space, '12', signal)).rejects.toMatchObject({ code: 'not-found' })
  })
})

describe('source', () => {
  it('normalizes settings from the space address', () => {
    const source = meegleSource()
    expect(source.normalizeSettings({ space: 'https://project.larksuite.com/shop/overview' })).toEqual(settings)
    expect(source.normalizeSettings({ space: 'https://meegle.com/shop', types: ' issue, issue ,63f0a1', filter: '`owner` = current_login_user()' })).toEqual({ space: 'https://meegle.com/shop', types: 'issue,63f0a1', filter: '`owner` = current_login_user()' })
    expect(() => source.normalizeSettings({ space: 'https://project.feishu.cn/shop', types: 'a b' })).toThrow(SourceError)
    expect(() => source.normalizeSettings({ space: 'https://project.feishu.cn/shop', filter: '1=1 LIMIT 5' })).toThrow(SourceError)
  })

  it('logs in with a token checked on the space site and keeps it there', async () => {
    const { session } = server({ search_user_info: () => [{ name_en: 'Ann' }] })
    const hosts: string[] = []
    const source = meegleSource((host) => { hosts.push(host); return new MeegleClient(session) })
    const answers = ['not a token', ` ${token} `]
    const prompts: string[] = []
    const result = await source.login({ prompt: async (prompt) => { prompts.push(prompt.error ?? ''); return answers.shift() ?? '' }, notify: () => {} }, settings, signal)
    expect(result).toEqual({ credential: { kind: 'token', payload: { token, host: 'project.larksuite.com' } }, account: 'Ann' })
    expect(prompts[1]).toContain('m-')
    expect(hosts).toEqual(['project.larksuite.com'])
    const moved = { ...settings, space: 'https://project.feishu.cn/shop' }
    await expect(source.list(moved, result.credential, signal)).rejects.toMatchObject({ code: 'not-configured' })
  })
})
