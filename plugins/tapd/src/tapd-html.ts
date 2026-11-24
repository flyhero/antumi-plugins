// Comments go to TAPD as HTML. Only the Markdown an agent's summary uses is understood; anything else
// stays as escaped text, so nothing in it can become markup TAPD would render.

const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

const INLINE = /`([^`\n]+)`|!?\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"，。；：！？])|\*\*([^*\n]+)\*\*/g

function inline(text: string): string {
  let html = ''
  let last = 0
  for (const match of text.matchAll(INLINE)) {
    html += escape(text.slice(last, match.index))
    const [whole, code, label, href, bare, bold] = match
    if (code !== undefined) html += `<code>${escape(code)}</code>`
    else if (label !== undefined && href !== undefined) html += `<a href="${escape(href)}">${escape(label)}</a>`
    else if (bare !== undefined) html += `<a href="${escape(bare)}">${escape(bare)}</a>`
    else if (bold !== undefined) html += `<strong>${inline(bold)}</strong>`
    last = match.index + whole.length
  }
  return html + escape(text.slice(last))
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/
const BULLET = /^\s*[-*+]\s+(.*)$/
const NUMBERED = /^\s*\d{1,9}[.)]\s+(.*)$/
const QUOTE = /^ {0,3}>\s?(.*)$/

export function markdownToHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  const blocks: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ''
    const fence = FENCE.exec(line)
    if (fence?.[1]) {
      const marker = fence[1]
      const code: string[] = []
      for (i++; i < lines.length && !(lines[i] ?? '').trimStart().startsWith(marker); i++) code.push(lines[i] ?? '')
      i++
      blocks.push(`<pre><code>${escape(code.join('\n'))}</code></pre>`)
      continue
    }
    if (!line.trim()) { i++; continue }
    const heading = HEADING.exec(line)
    if (heading?.[1]) {
      blocks.push(`<h${heading[1].length}>${inline(heading[2] ?? '')}</h${heading[1].length}>`)
      i++
      continue
    }
    const list = BULLET.test(line) ? { tag: 'ul', item: BULLET } : NUMBERED.test(line) ? { tag: 'ol', item: NUMBERED } : null
    if (list) {
      const items: string[] = []
      for (; i < lines.length; i++) {
        const item = list.item.exec(lines[i] ?? '')
        if (item) { items.push(inline(item[1] ?? '')); continue }
        // An indented line carries on the item above it.
        const more = lines[i] ?? ''
        if (!more.trim() || !/^\s/.test(more) || !items.length) break
        items[items.length - 1] += `<br>${inline(more.trim())}`
      }
      blocks.push(`<${list.tag}>${items.map((item) => `<li>${item}</li>`).join('')}</${list.tag}>`)
      continue
    }
    if (QUOTE.test(line)) {
      const quoted: string[] = []
      for (; i < lines.length && QUOTE.test(lines[i] ?? ''); i++) quoted.push(QUOTE.exec(lines[i] ?? '')?.[1] ?? '')
      blocks.push(`<blockquote>${markdownToHtml(quoted.join('\n'))}</blockquote>`)
      continue
    }
    const paragraph: string[] = []
    for (; i < lines.length; i++) {
      const next = lines[i] ?? ''
      if (!next.trim() || FENCE.test(next) || HEADING.test(next) || BULLET.test(next) || NUMBERED.test(next) || QUOTE.test(next)) break
      paragraph.push(inline(next.trim()))
    }
    blocks.push(`<p>${paragraph.join('<br>')}</p>`)
  }
  return blocks.join('')
}
