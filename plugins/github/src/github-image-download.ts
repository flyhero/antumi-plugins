import { MAX_ATTACHMENT_BYTES } from '@antumi/plugin-sdk'
import { SourceError } from './source-error.js'

const CDN_HOSTS = new Set(['user-images.githubusercontent.com', 'private-user-images.githubusercontent.com', 'raw.githubusercontent.com', 'camo.githubusercontent.com', 'media.githubusercontent.com'])
const REDIRECTS = new Set([301, 302, 303, 307, 308])

function imageUrl(value: string): URL {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) throw new SourceError('forbidden', 'Unsupported image address')
  if (url.hostname === 'github.com') {
    const blob = /^\/([^/]+\/[^/]+)\/(?:blob|raw)\/(.+)$/.exec(url.pathname)
    if (blob) return imageUrl(`https://raw.githubusercontent.com/${blob[1]}/${blob[2]}${url.search}`)
    if (/^\/user-attachments\/assets\/[^/]+$/.test(url.pathname) || /^\/[^/]+\/[^/]+\/assets\/[^/]+\/[^/]+$/.test(url.pathname)) return url
  }
  if (CDN_HOSTS.has(url.hostname)) return url
  throw new SourceError('forbidden', 'Only GitHub-hosted images can be downloaded')
}

function rasterImage(bytes: Uint8Array): boolean {
  const prefix = Buffer.from(bytes.subarray(0, 12))
  return prefix.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    || /^(GIF87a|GIF89a)/.test(prefix.toString('ascii'))
    || (prefix.toString('ascii', 0, 4) === 'RIFF' && prefix.toString('ascii', 8, 12) === 'WEBP')
}

export async function downloadGitHubImage(value: string, token: string, signal: AbortSignal, fetchImpl: typeof fetch = fetch): Promise<Uint8Array> {
  let url = imageUrl(value)
  const abort = AbortSignal.any([signal, AbortSignal.timeout(30_000)])
  for (let hop = 0; hop <= 5; hop++) {
    abort.throwIfAborted()
    let response: Response
    try {
      response = await fetchImpl(url.href, {
        headers: { Accept: 'image/png,image/jpeg,image/gif,image/webp', 'User-Agent': 'Antumi', ...(url.hostname === 'github.com' ? { Authorization: `Bearer ${token}` } : {}) },
        redirect: 'manual', signal: abort
      })
    } catch {
      abort.throwIfAborted()
      throw new SourceError('request-failed', 'Could not download a GitHub image')
    }
    if (REDIRECTS.has(response.status)) {
      const location = response.headers.get('location')
      await response.body?.cancel()
      if (!location || hop === 5) throw new SourceError('request-failed', 'GitHub image redirected too many times')
      url = imageUrl(new URL(location, url).href)
      continue
    }
    if (!response.ok) {
      await response.body?.cancel()
      throw new SourceError('request-failed', `GitHub image download failed (${response.status})`)
    }
    const mime = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
    if (mime && !['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/octet-stream'].includes(mime)) {
      await response.body?.cancel()
      throw new SourceError('request-failed', 'GitHub attachment is not a supported image')
    }
    if (Number(response.headers.get('content-length')) > MAX_ATTACHMENT_BYTES) {
      await response.body?.cancel()
      throw new SourceError('response-too-large', 'GitHub image exceeds the attachment size limit')
    }
    const reader = response.body?.getReader()
    if (!reader) throw new SourceError('request-failed', 'GitHub image was empty')
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        const { done, value: chunk } = await reader.read()
        abort.throwIfAborted()
        if (done) break
        size += chunk.byteLength
        if (size > MAX_ATTACHMENT_BYTES) throw new SourceError('response-too-large', 'GitHub image exceeds the attachment size limit')
        chunks.push(chunk)
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
    const bytes = Buffer.concat(chunks)
    if (!rasterImage(bytes)) throw new SourceError('request-failed', 'GitHub attachment is not a supported image')
    return bytes
  }
  throw new SourceError('request-failed', 'Could not download a GitHub image')
}
