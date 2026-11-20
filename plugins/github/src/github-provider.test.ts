import { describe, expect, it, vi } from 'vitest'
import { MAX_ATTACHMENT_BYTES, MAX_TASK_IMAGES, MAX_SOURCE_IMAGE_BYTES, MAX_SNAPSHOT_LENGTH, type LoginPrompt, type SourceIssue } from '@antumi/plugin-sdk'
import type { GitHubApi, GitHubCredentials, GitHubIssue } from './github-client.js'
import { DEFAULT_GITHUB_QUERY, githubProvider } from './github-provider.js'
import { SourceError } from './source-error.js'
import { githubImages } from './github-images.js'

const signal = new AbortController().signal
const summary: SourceIssue = {
  key: 'acme/widgets#7',
  title: 'Fix login',
  url: 'https://github.com/acme/widgets/issues/7',
  status: 'open',
  statusCategory: 'todo',
  type: 'Issue',
  priority: 'P1',
  updatedAt: 1
}
const issue: GitHubIssue = {
  ...summary,
  repository: 'acme/widgets',
  author: 'ann',
  body: 'The login form fails.',
  labels: ['P1', 'bug'],
  comments: [{ author: 'bob', created: Date.parse('2026-09-21T08:00:00Z'), body: 'Reproduced.' }],
  commentTotal: 3
}

function fakeApi(validToken: string, seen: GitHubCredentials[], queries: string[] = []): (credentials: GitHubCredentials) => GitHubApi {
  return (credentials) => ({
    myself: async () => {
      seen.push(credentials)
      if (credentials.token !== validToken) throw new SourceError('auth-failed', 'GitHub answered 401')
      return { login: 'qingfei' }
    },
    search: async (query) => (queries.push(query), [summary]),
    issue: async () => issue
  })
}

describe('githubProvider', () => {
  it('asks only for a token and retries authentication failures', async () => {
    const seen: GitHubCredentials[] = []
    const prompts: LoginPrompt[] = []
    const answers = ['bad', 'good']
    const provider = githubProvider(fakeApi('good', seen))
    const result = await provider.login(
      { prompt: async (prompt) => (prompts.push(prompt), answers.shift() ?? ''), notify: () => {} },
      {},
      signal
    )
    expect(result).toEqual({ credential: { kind: 'token', payload: { token: 'good' } }, account: 'qingfei' })
    expect(prompts.map((prompt) => prompt.kind)).toEqual(['secret', 'secret'])
    expect(prompts[1]?.error).toBe('Personal access token 不对，请重新输入')
    expect(seen).toEqual([{ token: 'bad' }, { token: 'good' }])
  })

  it('takes a search query that defaults to open work assigned to the user, and reads its environment credential', () => {
    const provider = githubProvider(fakeApi('good', []))
    expect(provider.normalizeSettings({ query: '  org:acme\n  label:bug  ', ignored: 'value' })).toEqual({ query: 'org:acme label:bug' })
    expect(provider.normalizeSettings({ query: ' \n ' })).toEqual({ query: DEFAULT_GITHUB_QUERY })
    expect(provider.normalizeSettings({})).toEqual({ query: DEFAULT_GITHUB_QUERY })
    expect(provider.envCredential?.({ ANTUMI_GITHUB_TOKEN: 'token' })).toEqual({ kind: 'token', payload: { token: 'token' } })
    expect(provider.envCredential?.({})).toBeNull()
  })

  it('lists work and builds an untrusted markdown snapshot on fetch', async () => {
    const queries: string[] = []
    const provider = githubProvider(fakeApi('good', [], queries))
    const credential = { kind: 'token', payload: { token: 'good' } }
    expect(await provider.list({ query: 'org:acme is:issue' }, credential, signal)).toEqual([summary])
    expect(await provider.list({}, credential, signal)).toEqual([summary])
    expect(queries).toEqual(['org:acme is:issue', DEFAULT_GITHUB_QUERY])
    const detail = await provider.fetch({}, credential, 'acme/widgets#7', signal)
    expect(detail).toMatchObject(summary)
    expect(detail.markdown).toContain('仓库：acme/widgets')
    expect(detail.markdown).toContain('作者：ann')
    expect(detail.markdown).toContain('The login form fails.')
    expect(detail.markdown).toContain('这里是最近 1 条，更早的 2 条在 GitHub 上')
    expect(detail.markdown).toContain('**bob**')
  })

  it('defers image downloads when Antumi asks for text and keeps partial failures readable', async () => {
    const body = '![first](https://github.com/user-attachments/assets/first) ![second](https://github.com/user-attachments/assets/second)'
    const pictured = { ...issue, body, images: githubImages(body, issue.url) }
    const download = vi.fn(async (url: string) => {
      if (url.endsWith('second')) throw new Error('no access')
      return new Uint8Array([1, 2, 3])
    })
    const provider = githubProvider(() => ({ ...fakeApi('good', [])({ token: 'good' }), issue: async () => pictured, download }))
    const credential = { kind: 'token', payload: { token: 'good' } }
    const text = await provider.fetch({}, credential, issue.key, signal, { images: false })
    expect(text).toMatchObject({ images: [], imagesDeferred: 2 })
    expect(download).not.toHaveBeenCalled()
    const full = await provider.fetch({}, credential, issue.key, signal)
    expect(full.images).toEqual([{ name: 'first', bytes: new Uint8Array([1, 2, 3]) }])
    expect(full.markdown).toContain(body)
    expect(full.markdown).toContain('另有 1 张图片未能下载')
    expect(download).toHaveBeenCalledTimes(2)
  })

  it('bounds image counts and the total bytes carried over the plugin protocol', async () => {
    const images = Array.from({ length: MAX_TASK_IMAGES + 2 }, (_, index) => ({ id: String(index), name: String(index), url: `https://user-images.githubusercontent.com/${index}.png` }))
    const download = vi.fn(async () => new Uint8Array([1]))
    const api = { ...fakeApi('good', [])({ token: 'good' }), issue: async () => ({ ...issue, images }), download }
    const provider = githubProvider(() => api)
    const credential = { kind: 'token', payload: { token: 'good' } }
    const full = await provider.fetch({}, credential, issue.key, signal)
    expect(full.images).toHaveLength(MAX_TASK_IMAGES)
    expect(download).toHaveBeenCalledTimes(MAX_TASK_IMAGES)
    expect(full.markdown).toContain('另有 2 张图片未能下载')
    const large = githubProvider(() => ({ ...api, download: async () => new Uint8Array(MAX_ATTACHMENT_BYTES) }))
    const bounded = await large.fetch({}, credential, issue.key, signal)
    expect(bounded.images.reduce((size, image) => size + image.bytes.length, 0)).toBe(MAX_SOURCE_IMAGE_BYTES)
    expect(bounded.images).toHaveLength(5)
  })

  it('does not swallow cancellation or exceed the snapshot limit with image outcome notes', async () => {
    const controller = new AbortController()
    const images = githubImages('![](https://github.com/user-attachments/assets/a)', issue.url)
    const api = { ...fakeApi('good', [])({ token: 'good' }), issue: async () => ({ ...issue, body: 'x'.repeat(MAX_SNAPSHOT_LENGTH), images }) }
    const cancelled = githubProvider(() => ({ ...api, download: async () => { controller.abort(); throw new Error('cancelled') } }))
    const credential = { kind: 'token', payload: { token: 'good' } }
    await expect(cancelled.fetch({}, credential, issue.key, controller.signal)).rejects.toBeDefined()
    const failed = await githubProvider(() => ({ ...api, download: async () => { throw new Error('404') } })).fetch({}, credential, issue.key, signal)
    expect(failed.markdown.length).toBeLessThanOrEqual(MAX_SNAPSHOT_LENGTH)
    expect(failed.markdown).toContain('另有 1 张图片未能下载')
  })
})
