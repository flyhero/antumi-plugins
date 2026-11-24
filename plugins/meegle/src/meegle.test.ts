import { describe, expect, it, vi } from 'vitest'
import { SourceError } from '@antumi/plugin-sdk'
import { McpSession, parseFrame, parseJson, toolFailure } from './mcp-session.js'
import { MeegleClient } from './meegle-client.js'
import { buildMql, day, DEFAULT_FILTER, normalizeFilter } from './meegle-mql.js'
import { meegleSource } from './meegle-source.js'
import { itemId, parseSpace } from './meegle-url.js'
import { commentMarkdown } from './meegle-writeback.js'

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
    // A string is sent as the tool's own text, the way a write may answer.
    try { const out = tool(body.params.arguments); result = { content: [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out) }, { type: 'text', text: 'log_id: 2026abc' }] } }
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
    expect(buildMql('shop', 'issue', DEFAULT_FILTER)).toBe('SELECT `work_item_id`, `name`, `work_item_status`, `updated_at`, `priority` FROM `shop`.`issue` WHERE array_contains(all_participate_persons(), current_login_user()) ORDER BY `updated_at` DESC')
    expect(buildMql('shop', 'issue', DEFAULT_FILTER, [])).toContain('SELECT `work_item_id`, `name`, `work_item_status`, `updated_at` FROM')
    expect(buildMql('sh`op', 'story', '`owner` = current_login_user()')).toContain('FROM `shop`.`story` WHERE `owner` = current_login_user() ORDER BY')
  })

  it('keeps the filter to a condition', () => {
    expect(normalizeFilter('  ')).toBe(DEFAULT_FILTER)
    expect(normalizeFilter('array_contains(all_participate_persons(), current_login_user()) AND `archiving_status` = false')).toBe(DEFAULT_FILTER)
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

  it('links custom types by their route name', async () => {
    const { session } = server({ list_workitem_types: types, search_by_mql: () => ({ list: [{ count: 1 }], data: { 1: [row(9, 'Review')] } }) })
    expect(await new MeegleClient(session).list(space, { types: ['63f0a1'], filter: 'work_item_id > 0' }, signal)).toMatchObject([{ url: 'https://project.larksuite.com/shop/review_process/detail/9', statusCategory: 'unknown', type: 'Review' }])
  })

  // The server's words when a space lacks a field (a Meegle space without `archiving_status`, 2026-11-23).
  const missing = (label: string) => `error=ErrMetadataError,message=metadata error,attribute not found (Code: 3003) | Context: attr label not found, projectKey:6afe, typeKey:story, labelRequestUUID:${label}, label:${label}. no similar field exists among its 57 fields,retriable=false`

  it('drops an optional column the space lacks and names a missing field in the filter', async () => {
    const { session, calls } = server({ list_workitem_types: types, search_by_mql: (args) => {
      if (String(args.mql).includes('`priority`')) throw new Error(missing('priority'))
      return { list: [{ count: 1 }], data: { 1: [row(3, 'No priority')] } }
    } })
    expect(await new MeegleClient(session).list(space, { types: ['story'], filter: DEFAULT_FILTER }, signal)).toMatchObject([{ key: '3' }])
    expect(calls.map((call) => String(call.args.mql ?? ''))[2]).not.toContain('priority')

    const strict = server({ list_workitem_types: types, search_by_mql: () => { throw new Error(missing('archiving_status')) } })
    await expect(new MeegleClient(strict.session).list(space, { types: ['story'], filter: '`archiving_status` = false' }, signal))
      .rejects.toMatchObject({ code: 'invalid-settings', message: expect.stringContaining('空间里没有字段「archiving_status」') })
    expect(strict.calls).toHaveLength(2)
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

describe('writeback', () => {
  const credential = { kind: 'token' as const, payload: { token, host: space.host } }
  const attribute = (extra: object = {}) => ({
    work_item_name: 'Fix login', work_item_type: { key: 'issue', name: 'Defect', api_name: 'issue' }, owned_project: { key: '63ab', simple_name: 'shop' },
    work_item_status: { key: 'OPEN', name: '待处理' }, ...extra
  })
  const brief = (status = { key: 'OPEN', name: '待处理' }, nodes: object[] = []) => () => ({ work_item_attribute: attribute({ work_item_status: status }), work_item_current_node: nodes, work_item_fields: [], pagination: { has_more: true, next_page_token: 'p2' } })
  const me = () => [{ user_key: '7001', name_cn: '安' }]
  const states = () => [
    { id: 24640610, state_name: '待处理', state_key: 'OPEN' },
    { id: 24640619, state_name: '处理中', state_key: 'IN PROGRESS' },
    { id: '24640620', state_name: '已完成', state_key: 'DONE' }
  ]
  const source = (session: McpSession) => meegleSource(() => new MeegleClient(session))

  it('lists the next states of a state flow, leaving out the current one', async () => {
    const { session, calls } = server({ get_workitem_brief: brief(), search_user_info: me, get_transitable_states: states })
    expect(await source(session).transitions?.(settings, credential, '#12', signal)).toEqual({
      status: '待处理', statusCategory: 'unknown',
      options: [{ id: 'state:24640619', name: '处理中', category: 'unknown' }, { id: 'state:24640620', name: '已完成', category: 'unknown' }]
    })
    expect(calls.map((call) => call.name)).toEqual(['get_workitem_brief', 'search_user_info', 'get_transitable_states'])
    expect(calls[2]?.args).toEqual({ project_key: '63ab', work_item_id: '12', work_item_type: 'issue', user_key: '7001' })
  })

  it('reads transitions wrapped in data and calls an aborted item done', async () => {
    const { session } = server({
      get_workitem_brief: () => ({ work_item_attribute: attribute({ is_aborted: true, work_item_status: { key: 'CLOSED', name: '已关闭' } }) }),
      search_user_info: me, get_transitable_states: () => ({ data: [{ id: 5, state_name: '重新打开', state_key: 'REOPEN' }] })
    })
    expect(await source(session).transitions?.(settings, credential, '12', signal)).toEqual({ status: '已关闭', statusCategory: 'done', options: [{ id: 'state:5', name: '重新打开', category: 'unknown' }] })
  })

  it('moves a state flow by a listed transition and reads the status back', async () => {
    let status = { key: 'OPEN', name: '待处理' }
    const { session, calls } = server({
      get_workitem_brief: () => brief(status)(), search_user_info: me, get_transitable_states: states,
      transition_state: (args) => { status = { key: 'IN PROGRESS', name: '处理中' }; return args.transition_id === '24640619' ? 'success' : 'bad' }
    })
    expect(await source(session).transition?.(settings, credential, '12', 'state:24640619', signal)).toEqual({ status: '处理中', statusCategory: 'unknown' })
    expect(calls.find((call) => call.name === 'transition_state')?.args).toEqual({ project_key: '63ab', work_item_id: '12', transition_id: '24640619' })
    expect(calls.filter((call) => call.name === 'get_workitem_brief').every((call) => !call.args.page_token)).toBe(true)
  })

  it('refuses an id the issue cannot take now', async () => {
    const { session, calls } = server({ get_workitem_brief: brief(), search_user_info: me, get_transitable_states: states, transition_state: () => 'success' })
    for (const id of ['state:24640610', 'state:999', 'node:dev', 'whatever']) {
      await expect(source(session).transition?.(settings, credential, '12', id, signal)).rejects.toMatchObject({ code: 'request-failed', message: expect.stringContaining('不能流转') })
    }
    expect(calls.some((call) => call.name === 'transition_state')).toBe(false)
  })

  it('offers completing the nodes in progress for a node flow', async () => {
    const { session, calls } = server({
      get_workitem_brief: brief({ key: 'started', name: '进行中' }, [{ name: '开发' }]),
      get_node_detail: () => ({ nodes: [{ node_key: 'state_dev', name: '开发', status: 'doing' }, { node_key: 'state_test', name: '测试', status: 'not_started' }] }),
      transition_node: () => ({})
    })
    const plugin = source(session)
    expect(await plugin.transitions?.(settings, credential, '12', signal)).toEqual({
      status: '进行中', statusCategory: 'unknown', options: [{ id: 'node:state_dev', name: '「开发」已完成', action: '完成节点「开发」', category: 'unknown' }]
    })
    expect(calls[1]?.args).toMatchObject({ project_key: '63ab', work_item_id: '12', node_id_list: ['开发'] })
    await plugin.transition?.(settings, credential, '12', 'node:state_dev', signal)
    expect(calls.find((call) => call.name === 'transition_node')?.args).toEqual({ project_key: '63ab', work_item_id: '12', node_id: 'state_dev', action: 'confirm' })
  })

  it('posts Markdown as it is and returns the comment ID comment listings use', async () => {
    const { session, calls } = server({ get_workitem_brief: brief(), add_comment: () => '{"comment_id":7301234567890123456}' })
    const result = await source(session).comment?.(settings, credential, '12', { markdown: 'Done.\r\n\r\n- [PR](https://x/1)\n- `a<!--b-->`\n\n```\n<!-- kept -->\n```\n<!-- mention:{"id":"7001"} -->', writeId: 'w-1' }, signal)
    expect(result).toEqual({ id: '7301234567890123456', url: 'https://project.larksuite.com/shop/issue/detail/12' })
    expect(calls[1]?.args).toEqual({ project_key: '63ab', work_item_id: '12', content: 'Done.\n\n- [PR](https://x/1)\n- `a<!--b-->`\n\n```\n<!-- kept -->\n```' })
  })

  it('finds the comment it posted when add_comment does not name it', async () => {
    const { session, calls } = server({
      get_workitem_brief: brief(), add_comment: () => 'success',
      list_workitem_comments: () => ({ comments: [{ id: 41, content: 'Done', created_at: 1 }, { id: 42, content: ' Done ', created_at: 2 }, { id: 43, content: 'Other', created_at: 3 }] })
    })
    expect(await source(session).comment?.(settings, credential, '12', { markdown: 'Done', writeId: 'w-1' }, signal)).toMatchObject({ id: '42' })
    expect(calls.map((call) => call.name)).toEqual(['get_workitem_brief', 'add_comment', 'list_workitem_comments'])
  })

  it('asks for a token with write permission and never retries a write', async () => {
    const denied = server({ get_workitem_brief: brief(), add_comment: () => { throw new Error('error=ErrWorkItemNoPermission,message=No Permission,retriable=false') } })
    const failure = source(denied.session).comment?.(settings, credential, '12', { markdown: 'Done', writeId: 'w-1' }, signal)
    await expect(failure).rejects.toMatchObject({ code: 'forbidden', message: expect.stringContaining('允许创建或修改数据信息') })
    await expect(failure).rejects.not.toThrow(token)

    const rejected = new McpSession(space.host, token, vi.fn<typeof fetch>(async (url, init) => JSON.parse(String(init?.body)).params?.name === 'add_comment' ? new Response('{}', { status: 403 }) : denied.fetcher(url, init)), async () => {})
    await expect(new MeegleClient(rejected).comment(space, '12', 'Done', 'w-1', signal)).rejects.toMatchObject({ code: 'forbidden', message: expect.stringContaining('重新登录') })

    const busy = server({ get_workitem_brief: brief(), add_comment: () => { throw new Error('error=RPCError,message=busy,retriable=true') } })
    await expect(source(busy.session).comment?.(settings, credential, '12', { markdown: 'Done', writeId: 'w-1' }, signal)).rejects.toMatchObject({ code: 'request-failed' })
    expect(busy.calls.filter((call) => call.name === 'add_comment')).toHaveLength(1)

    // An expired session never read the request, so the write goes once more on a new one.
    let expired = true
    const inner = server({ get_workitem_brief: brief(), add_comment: () => ({ comment_id: 9 }) })
    const expiring = vi.fn<typeof fetch>(async (url, init) => {
      if (JSON.parse(String(init?.body)).params?.name === 'add_comment' && expired) { expired = false; return new Response(null, { status: 404 }) }
      return inner.fetcher(url, init)
    })
    expect(await new MeegleClient(new McpSession(space.host, token, expiring, async () => {})).comment(space, '12', 'Done', 'w-1', signal)).toMatchObject({ id: '9' })
    expect(inner.calls.filter((call) => call.name === 'add_comment')).toHaveLength(1)
  })

  it('reports a missing item and an empty comment', async () => {
    const missing = server({ get_workitem_brief: () => { throw new Error('error=WorkItemNotFound,message=gone,retriable=false') } })
    await expect(source(missing.session).transitions?.(settings, credential, '12', signal)).rejects.toMatchObject({ code: 'not-found' })
    const { session, calls } = server({ get_workitem_brief: brief() })
    await expect(source(session).comment?.(settings, credential, '12', { markdown: '<!-- only -->', writeId: 'w-1' }, signal)).rejects.toMatchObject({ code: 'request-failed' })
    expect(calls).toHaveLength(0)
  })

  it('keeps integers too large for a double as their digits', () => {
    expect(parseJson('{"id":7301234567890123456,"n":12}')).toEqual({ id: '7301234567890123456', n: 12 })
    expect(commentMarkdown('a <!-- open')).toBe('a')
  })
})
