import { describe, expect, it, vi } from 'vitest'
import { MAX_ATTACHMENT_BYTES } from '@antumi/plugin-sdk'
import { downloadGitHubImage } from './github-image-download.js'

const asset = 'https://github.com/user-attachments/assets/abc'
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0])
const signal = new AbortController().signal

describe('GitHub image download', () => {
  it('authenticates attachment requests and drops the token on CDN redirects', async () => {
    const calls: { url: string; authorization: string | null; redirect: string | undefined; signal: AbortSignal | null | undefined }[] = []
    const fetcher: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), authorization: new Headers(init?.headers).get('authorization'), redirect: init?.redirect, signal: init?.signal })
      return calls.length === 1 ? new Response(null, { status: 302, headers: { location: 'https://private-user-images.githubusercontent.com/1/a.png?jwt=signed' } }) : new Response(png, { headers: { 'content-type': 'image/png' } })
    }
    expect(await downloadGitHubImage(asset, 'secret', signal, fetcher)).toEqual(Buffer.from(png))
    expect(calls.map((call) => call.authorization)).toEqual(['Bearer secret', null])
    expect(calls.every((call) => call.redirect === 'manual' && call.signal)).toBe(true)
  })

  it.each(['https://example.com/a.png', 'https://127.0.0.1/a.png', 'http://github.com/user-attachments/assets/a', 'https://github.com.evil.test/a.png', 'https://user:secret@github.com/user-attachments/assets/a', 'https://github.com:8443/user-attachments/assets/a', 'https://github.com/login'])('never fetches an unsupported image address: %s', async (url) => {
    const fetcher = vi.fn<typeof fetch>()
    await expect(downloadGitHubImage(url, 'secret', signal, fetcher)).rejects.toBeDefined()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('checks each redirect before sending a request, and bounds redirect loops', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 307, headers: { location: 'http://127.0.0.1/private' } }))
    await expect(downloadGitHubImage(asset, 'secret', signal, fetcher)).rejects.toBeDefined()
    expect(fetcher).toHaveBeenCalledTimes(1)
    const loop = vi.fn<typeof fetch>(async () => new Response(null, { status: 302, headers: { location: asset } }))
    await expect(downloadGitHubImage(asset, 'secret', signal, loop)).rejects.toMatchObject({ code: 'request-failed' })
    expect(loop).toHaveBeenCalledTimes(6)
  })

  it('normalizes repository blob images and never sends their downloads the token', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(png))
    await downloadGitHubImage('https://github.com/a/b/blob/main/shot.png', 'secret', signal, fetcher)
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://raw.githubusercontent.com/a/b/main/shot.png')
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).has('authorization')).toBe(false)
  })

  it('rejects oversized declarations and streams without buffering the full response', async () => {
    const cancel = vi.fn()
    const declared = new ReadableStream<Uint8Array>({ cancel })
    await expect(downloadGitHubImage(asset, 'secret', signal, async () => new Response(declared, { headers: { 'content-length': String(MAX_ATTACHMENT_BYTES + 1) } }))).rejects.toMatchObject({ code: 'response-too-large' })
    expect(cancel).toHaveBeenCalled()
    const streamed = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)) }, cancel })
    await expect(downloadGitHubImage(asset, 'secret', signal, async () => new Response(streamed))).rejects.toMatchObject({ code: 'response-too-large' })
    expect(cancel).toHaveBeenCalledTimes(2)
  })

  it('rejects login pages, SVG, non-image bytes and HTTP failures', async () => {
    for (const response of [new Response('<html>sign in</html>', { headers: { 'content-type': 'text/html' } }), new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml' } }), new Response('not an image', { headers: { 'content-type': 'image/png' } }), new Response(null, { status: 404 })]) {
      await expect(downloadGitHubImage(asset, 'secret', signal, async () => response)).rejects.toMatchObject({ code: 'request-failed' })
    }
  })

  it('honors cancellation and does not include private image URLs in network errors', async () => {
    const cancelled = AbortSignal.abort()
    const fetcher = vi.fn<typeof fetch>()
    await expect(downloadGitHubImage(asset, 'secret', cancelled, fetcher)).rejects.toBeDefined()
    expect(fetcher).not.toHaveBeenCalled()
    await expect(downloadGitHubImage('https://private-user-images.githubusercontent.com/1/a.png?jwt=secret', 'token', signal, async () => { throw new Error('failed url jwt=secret') })).rejects.toMatchObject({ message: 'Could not download a GitHub image' })
  })
})
