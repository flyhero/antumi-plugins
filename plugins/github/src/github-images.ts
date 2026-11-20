import { createHash } from 'node:crypto'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { fromHtml } from 'hast-util-from-html'
import type { Nodes as MarkdownNode } from 'mdast'
import type { Nodes as HtmlNode } from 'hast'

export type GitHubImage = { id: string; url: string; name: string }
type ImageLink = { url: string; name: string; canonical?: string }
const MAX_REFERENCES = 100

function htmlImages(html: string): ImageLink[] {
  const images: ImageLink[] = []
  const visit = (node: HtmlNode): void => {
    if (images.length >= MAX_REFERENCES) return
    if (node.type === 'element' && node.tagName === 'img' && typeof node.properties.src === 'string') {
      const canonical = node.properties.dataCanonicalSrc
      images.push({ url: node.properties.src, name: typeof node.properties.alt === 'string' ? node.properties.alt : '', ...(typeof canonical === 'string' ? { canonical } : {}) })
    }
    if ('children' in node) node.children.forEach(visit)
  }
  visit(fromHtml(html, { fragment: true }))
  return images
}

function markdownImages(markdown: string): ImageLink[] {
  const root = fromMarkdown(markdown)
  const definitions = new Map<string, string>()
  const collect = (node: MarkdownNode): void => {
    if (node.type === 'definition' && !definitions.has(node.identifier)) definitions.set(node.identifier, node.url)
    if ('children' in node) node.children.forEach(collect)
  }
  collect(root)
  const images: ImageLink[] = []
  const visit = (node: MarkdownNode): void => {
    if (images.length >= MAX_REFERENCES) return
    if (node.type === 'image') images.push({ url: node.url, name: node.alt ?? '' })
    if (node.type === 'imageReference') {
      const url = definitions.get(node.identifier)
      if (url) images.push({ url, name: node.alt ?? '' })
    }
    if (node.type === 'html') images.push(...htmlImages(node.value).slice(0, MAX_REFERENCES - images.length))
    if ('children' in node) node.children.forEach(visit)
  }
  visit(root)
  return images
}

// Rendered HTML carries GitHub's proxy/signed image URLs; the raw source gives them stable IDs.
export function githubImages(markdown: string, base: string, html?: string | null): GitHubImage[] {
  const raw = markdownImages(markdown.slice(0, 50_000))
  const links = html == null ? raw : htmlImages(html)
  const images = new Map<string, GitHubImage>()
  for (const [index, link] of links.entries()) {
    try {
      const url = new URL(link.url, base)
      if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) continue
      url.hash = ''
      const canonical = new URL(link.canonical ?? (raw.length === links.length ? raw[index]?.url : undefined) ?? link.url, base)
      canonical.hash = ''
      if (canonical.hostname === 'private-user-images.githubusercontent.com') canonical.search = ''
      const id = createHash('sha256').update(canonical.href).digest('hex')
      let name = link.name.trim() || (raw.length === links.length ? raw[index]?.name.trim() : '') || decodeURIComponent(canonical.pathname.split('/').at(-1) ?? '') || 'GitHub image'
      name = name.replace(/[\r\n\t]/g, ' ').slice(0, 120)
      if (!images.has(id)) images.set(id, { id, url: url.href, name })
    } catch { /* An invalid image link does not prevent importing its text. */ }
  }
  return [...images.values()]
}
