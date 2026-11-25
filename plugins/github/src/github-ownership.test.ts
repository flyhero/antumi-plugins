import { describe, expect, it } from 'vitest'
import { PluginManifest } from '@antumi/plugin-sdk'
import manifest from '../manifest.json' with { type: 'json' }
import { GitHubClient } from './github-client.js'
import { githubProvider } from './github-provider.js'

const signal = new AbortController().signal
const credential = { kind: 'token', payload: { token: 'secret' } } as const
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers })
const ann = { login: 'ann', id: 11 }
const bob = { login: 'bob', id: 22 }
const me = { login: 'qingfei', id: 1001 }
const row = (overrides: Record<string, unknown> = {}) => ({
  number: 7, title: 'Fix login', html_url: 'https://github.com/acme/widgets/issues/7', state: 'open', state_reason: null, comments: 0,
  user: ann, assignees: [], repository_url: 'https://api.github.com/repos/acme/widgets', ...overrides
})

// A GitHub with one issue, signed in as user; search finds that issue.
function github(current: Record<string, unknown>, user: () => Response = () => json(me)) {
  const paths: string[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const { pathname } = new URL(String(input))
    paths.push(pathname)
    expect(init?.method ?? 'GET').toBe('GET')
    expect(init?.signal).toBeDefined()
    if (pathname === '/user') return user()
    return pathname === '/search/issues' ? json({ items: [current] }) : json(current)
  }
  return { provider: githubProvider(() => new GitHubClient({ token: 'secret' }, fetchImpl)), paths }
}
const facts = (current: Record<string, unknown>, user?: () => Response) => github(current, user).provider.transitions({}, credential, 'acme/widgets#7', signal)

describe('GitHub ownership facts', () => {
  it('reports who the token is and everyone an issue is assigned to, by numeric id', async () => {
    const { provider, paths } = github(row({ assignees: [me, bob] }))
    expect(await provider.transitions({}, credential, 'acme/widgets#7', signal)).toMatchObject({
      status: 'open',
      viewer: { id: '1001', name: 'qingfei' },
      assignees: [{ id: '1001', name: 'qingfei' }, { id: '22', name: 'bob' }],
      reporter: { id: '11', name: 'ann' },
      type: { id: 'issue', name: 'Issue' },
      scope: { id: 'acme/widgets', name: 'acme/widgets' }
    })
    expect(paths).toEqual(['/repos/acme/widgets/issues/7', '/user'])
  })

  it('reports an issue no one is assigned to as having no assignees', async () => {
    expect((await facts(row())).assignees).toEqual([])
  })

  it('counts the author of a pull request as its assignee, ahead of anyone assigned', async () => {
    const pull = { pull_request: { merged_at: null }, user: me }
    expect(await facts(row(pull))).toMatchObject({
      assignees: [{ id: '1001', name: 'qingfei' }], reporter: { id: '1001', name: 'qingfei' }, type: { id: 'pull-request', name: 'Pull Request' }
    })
    expect((await facts(row({ ...pull, assignees: [me, bob] }))).assignees).toEqual([{ id: '1001', name: 'qingfei' }, { id: '22', name: 'bob' }])
    expect((await facts(row({ ...pull, user: ann, assignees: [me] }))).assignees).toEqual([{ id: '11', name: 'ann' }, { id: '1001', name: 'qingfei' }])
  })

  it('leaves out what GitHub does not tell rather than guess', async () => {
    const bare = await facts(row({ user: undefined, assignees: undefined }))
    expect(bare).not.toHaveProperty('assignees')
    expect(bare).not.toHaveProperty('reporter')
    expect(bare).not.toHaveProperty('statusId')
    // An author who is gone is no reporter; one without an id cannot be matched to the viewer.
    expect((await facts(row({ user: null }))).reporter).toBeNull()
    expect(await facts(row({ assignees: [{ login: 'bob' }] }))).not.toHaveProperty('assignees')
    expect(await facts(row({ pull_request: {}, user: { login: 'ann' }, assignees: [me] }))).not.toHaveProperty('assignees')
  })

  it('leaves the viewer out for a token with no user, and fails on any other error', async () => {
    const app = await facts(row({ assignees: [me] }), () => json({ message: 'Resource not accessible by integration' }, 403))
    expect(app).not.toHaveProperty('viewer')
    expect(app.assignees).toEqual([{ id: '1001', name: 'qingfei' }])
    await expect(facts(row(), () => json({ message: 'API rate limit exceeded' }, 403, { 'x-ratelimit-remaining': '0' }))).rejects.toMatchObject({ code: 'request-failed' })
    await expect(facts(row(), () => json({ message: 'Server Error' }, 500))).rejects.toMatchObject({ code: 'request-failed' })
    await expect(facts(row(), () => json({ message: 'Bad credentials' }, 401))).rejects.toMatchObject({ code: 'auth-failed' })
  })

  it('says what type an issue is and which repository it is in on list and fetch', async () => {
    const issue = { type: 'Issue', typeId: 'issue', scope: { id: 'acme/widgets', name: 'acme/widgets' } }
    const issues = github(row()).provider
    expect(await issues.list({ query: 'is:issue' }, credential, signal)).toMatchObject([issue])
    expect(await issues.fetch({}, credential, 'acme/widgets#7', signal)).toMatchObject(issue)
    const pull = { type: 'Pull Request', typeId: 'pull-request', scope: { id: 'acme/widgets', name: 'acme/widgets' } }
    const pulls = github(row({ pull_request: { merged_at: null } })).provider
    expect(await pulls.list({ query: 'is:pr' }, credential, signal)).toMatchObject([pull])
    expect(await pulls.fetch({}, credential, 'acme/widgets#7', signal)).toMatchObject(pull)
  })
})

describe('GitHub writeback types', () => {
  const [source] = PluginManifest.parse(manifest).contributes.sources ?? []
  const values = (stage: unknown) => (typeof stage === 'object' && stage !== null && 'presets' in stage && Array.isArray(stage.presets) ? stage.presets.map((preset) => String(preset.value)) : null)

  it('offers no status that closes the issue when handing in for review', () => {
    const issue = source?.writebackTypes?.find((type) => type.id === 'issue')
    expect(issue).toMatchObject({ label: 'Issue', mode: 'on' })
    for (const rules of [source?.writebackRules, issue?.rules]) {
      expect(values(rules?.review)).toEqual(['In review'])
      expect(values(rules?.done)).toEqual(['Done|completed'])
    }
    expect(issue?.rules).toEqual(source?.writebackRules)
  })

  it('leaves pull requests alone unless the user makes a lane for them', () => {
    expect(source?.writebackTypes?.find((type) => type.id === 'pull-request')).toEqual({
      id: 'pull-request', label: 'Pull Request', mode: 'off', rules: { start: false, review: false, done: false }
    })
  })
})
