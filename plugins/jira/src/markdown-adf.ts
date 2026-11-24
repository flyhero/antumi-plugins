// Markdown to Atlassian Document Format, for comments Antumi posts. Covers what an agent's summary
// uses (paragraphs, headings, lists, quotes, code, emphasis, links); anything else stays as text,
// which is always valid ADF.
type Emphasis = 'strong' | 'em' | 'strike'
type Mark = { type: Emphasis | 'code' } | { type: 'link'; attrs: { href: string } }
type Text = { type: 'text'; text: string; marks?: Mark[] }
type Inline = Text | { type: 'hardBreak' }
type Paragraph = { type: 'paragraph'; content: Inline[] }
type ListItem = { type: 'listItem'; content: Block[] }
type Block =
  | Paragraph
  | { type: 'heading'; attrs: { level: number }; content: Inline[] }
  | { type: 'bulletList'; content: ListItem[] }
  | { type: 'orderedList'; attrs: { order: number }; content: ListItem[] }
  | { type: 'codeBlock'; attrs?: { language: string }; content: Text[] }
  | { type: 'blockquote'; content: Block[] }
  | { type: 'rule' }
export type AdfDocument = { type: 'doc'; version: 1; content: Block[] }

// Deeper nesting than this becomes plain text: the parser recurses, and Jira caps list depth.
const MAX_BLOCK_DEPTH = 6
const MAX_INLINE_DEPTH = 8

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/
const HEADING = /^ {0,3}(#{1,6})(?:\s+(.*?))?\s*$/
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/
const QUOTE = /^ {0,3}> ?/
const LIST_ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])(?:[ \t]+(.*))?$/

const isBlank = (line: string) => line.trim() === ''
const indentOf = (line: string) => /^ */.exec(line.replace(/\t/g, '    '))?.[0].length ?? 0

// Lines that end a paragraph: agents often start a list right under a line of text.
function startsBlock(line: string): boolean {
  return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || LIST_ITEM.test(line)
}

// Strips up to `width` columns of leading spaces.
function dedent(line: string, width: number): string {
  const expanded = line.replace(/^\t+/, (tabs) => '    '.repeat(tabs.length))
  return expanded.slice(Math.min(width, indentOf(expanded)))
}

function parseBlocks(lines: readonly string[], depth: number): Block[] {
  const blocks: Block[] = []
  let at = 0
  while (at < lines.length) {
    const line = lines[at] ?? ''
    if (isBlank(line)) {
      at += 1
      continue
    }
    const fence = FENCE.exec(line)
    if (fence) {
      const marker = fence[1] ?? '```'
      const close = new RegExp(`^ {0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}\\s*$`)
      const code: string[] = []
      at += 1
      while (at < lines.length && !close.test(lines[at] ?? '')) {
        code.push(lines[at] ?? '')
        at += 1
      }
      at += 1
      const text = code.join('\n')
      blocks.push({ type: 'codeBlock', ...(fence[2] ? { attrs: { language: fence[2] } } : {}), content: text ? [{ type: 'text', text }] : [] })
      continue
    }
    const heading = HEADING.exec(line)
    if (heading && depth < MAX_BLOCK_DEPTH) {
      at += 1
      const content = parseInline((heading[2] ?? '').replace(/\s+#+$/, ''))
      if (content.length) blocks.push({ type: 'heading', attrs: { level: heading[1]?.length ?? 1 }, content })
      continue
    }
    if (RULE.test(line)) {
      at += 1
      blocks.push({ type: 'rule' })
      continue
    }
    if (QUOTE.test(line) && depth < MAX_BLOCK_DEPTH) {
      const quoted: string[] = []
      while (at < lines.length && QUOTE.test(lines[at] ?? '')) {
        quoted.push((lines[at] ?? '').replace(QUOTE, ''))
        at += 1
      }
      const content = nestedContent(parseBlocks(quoted, depth + 1))
      if (content.length) blocks.push({ type: 'blockquote', content })
      continue
    }
    if (LIST_ITEM.test(line) && depth < MAX_BLOCK_DEPTH) {
      at = parseList(lines, at, depth, blocks)
      continue
    }
    const paragraph: string[] = [line]
    at += 1
    while (at < lines.length && !isBlank(lines[at] ?? '') && !startsBlock(lines[at] ?? '')) {
      paragraph.push(lines[at] ?? '')
      at += 1
    }
    const content = parseInline(paragraph.map((text) => text.trim()).join('\n'))
    if (content.length) blocks.push({ type: 'paragraph', content })
  }
  return blocks
}

// Quotes and list items in ADF hold paragraphs, lists and code only: headings become bold, inner
// quotes open up, rules go.
function nestedContent(blocks: readonly Block[]): Block[] {
  return blocks.flatMap((block): Block[] => {
    switch (block.type) {
      case 'heading':
        return [{ type: 'paragraph', content: block.content.map((node) => (node.type === 'text' ? withMark(node, { type: 'strong' }) : node)) }]
      case 'blockquote':
        return nestedContent(block.content)
      case 'rule':
        return []
      default:
        return [block]
    }
  })
}

// One list: items whose marker sits at the first item's indent and is of the same kind.
function parseList(lines: readonly string[], start: number, depth: number, blocks: Block[]): number {
  const first = LIST_ITEM.exec(lines[start] ?? '')
  const ordered = /\d/.test(first?.[2] ?? '')
  const indent = first?.[1]?.length ?? 0
  const items: ListItem[] = []
  let at = start
  const sameList = (line: string) => {
    const match = LIST_ITEM.exec(line)
    return match && (match[1]?.length ?? 0) === indent && /\d/.test(match[2] ?? '') === ordered ? match : null
  }
  while (at < lines.length) {
    // Blank lines between items keep one list.
    let next = at
    while (next < lines.length && isBlank(lines[next] ?? '')) next += 1
    const match = sameList(lines[next] ?? '')
    if (!match) break
    at = next
    // Continuation lines are indented past the marker; a nested list may sit two spaces in.
    const width = Math.min(indent + (match[2]?.length ?? 1) + 1, indent + 2)
    const body: string[] = [match[3] ?? '']
    at += 1
    while (at < lines.length) {
      const next = lines[at] ?? ''
      if (isBlank(next)) {
        const following = lines.slice(at + 1).find((rest) => !isBlank(rest))
        if (following === undefined || indentOf(following) < width) break
        body.push('')
      } else if (indentOf(next) >= width) {
        body.push(dedent(next, width))
      } else if (startsBlock(next)) {
        break
      } else {
        body.push(next.trim())
      }
      at += 1
    }
    const content = nestedContent(parseBlocks(body, depth + 1))
    // ADF wants a list item to open with a paragraph.
    items.push({ type: 'listItem', content: content[0]?.type === 'paragraph' ? content : [{ type: 'paragraph', content: [] }, ...content] })
  }
  const order = Number.parseInt(first?.[2] ?? '1', 10)
  blocks.push(ordered ? { type: 'orderedList', attrs: { order: Number.isFinite(order) ? order : 1 }, content: items } : { type: 'bulletList', content: items })
  return at
}

function withMark(node: Text, mark: Mark): Text {
  const marks = node.marks ?? []
  // ADF allows code only alongside a link.
  if (marks.some((existing) => existing.type === mark.type)) return node
  if (mark.type === 'code') return { ...node, marks: [...marks.filter((existing) => existing.type === 'link'), mark] }
  if (marks.some((existing) => existing.type === 'code') && mark.type !== 'link') return node
  return { ...node, marks: [...marks, mark] }
}

// Only links Jira will render and a reader can follow; anything else stays text.
function safeHref(href: string): string | null {
  try {
    const url = new URL(href)
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? url.href : null
  } catch {
    return null
  }
}

const ESCAPABLE = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/
const BARE_URL = /^https?:\/\/[^\s<>"'`，。；：！？、（）【】《》「」『』]+/
const EMPHASIS: readonly (readonly [string, Emphasis])[] = [['**', 'strong'], ['__', 'strong'], ['~~', 'strike'], ['*', 'em'], ['_', 'em']]

// Where a [label] ends, skipping escapes and nested brackets; -1 when it does not.
function closingBracket(text: string, open: number): number {
  let depth = 0
  for (let at = open; at < text.length; at += 1) {
    const char = text[at]
    if (char === '\\') at += 1
    else if (char === '[') depth += 1
    else if (char === ']' && --depth === 0) return at
  }
  return -1
}

// [label](href) or ![alt](href) at `at`, as the label's text and where the link ends.
function linkAt(text: string, at: number): { label: string; href: string; end: number } | null {
  const open = text[at] === '!' ? at + 1 : at
  if (text[open] !== '[') return null
  const close = closingBracket(text, open)
  if (close < 0 || text[close + 1] !== '(') return null
  const target = /^\(\s*(?:<([^<>\n]*)>|([^\s()]+))(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/.exec(text.slice(close + 1))
  if (!target) return null
  return { label: text.slice(open + 1, close), href: target[1] ?? target[2] ?? '', end: close + 1 + target[0].length }
}

// The run that closes an emphasis opened at `from`, not preceded by a space.
function closingDelimiter(text: string, delimiter: string, from: number): number {
  for (let at = text.indexOf(delimiter, from); at >= 0; at = text.indexOf(delimiter, at + 1)) {
    const before = text[at - 1] ?? ''
    const after = text[at + delimiter.length] ?? ''
    if (at === from || /\s/.test(before) || text[at - 1] === '\\') continue
    // A single * is not the start of **; snake_case is not emphasis.
    if (delimiter.length === 1 && (after === delimiter[0] || before === delimiter[0])) continue
    if (delimiter[0] === '_' && /[\p{L}\p{N}]/u.test(after)) continue
    return at
  }
  return -1
}

function parseInline(text: string, depth: number = 0, inLink: boolean = false): Inline[] {
  const nodes: Inline[] = []
  let plain = ''
  const flush = () => {
    if (plain) nodes.push({ type: 'text', text: plain })
    plain = ''
  }
  const push = (inner: Inline[], mark: Mark) => {
    flush()
    nodes.push(...inner.map((node) => (node.type === 'text' ? withMark(node, mark) : node)))
  }
  let at = 0
  while (at < text.length) {
    const char = text[at] ?? ''
    const rest = text.slice(at)
    if (char === '\n') {
      // Every newline is a break here, so Markdown's own markers for one (a trailing \ or two spaces) go.
      plain = plain.replace(/(?:\\| +)$/, '')
      flush()
      nodes.push({ type: 'hardBreak' })
      at += 1
      continue
    }
    if (char === '\\' && ESCAPABLE.test(text[at + 1] ?? '')) {
      plain += text[at + 1]
      at += 2
      continue
    }
    if (char === '`') {
      const run = /^`+/.exec(rest)?.[0] ?? '`'
      const close = text.indexOf(run, at + run.length)
      if (close > at) {
        let code = text.slice(at + run.length, close).replace(/\n/g, ' ')
        if (/^ .* $/.test(code) && code.trim()) code = code.slice(1, -1)
        if (code) push([{ type: 'text', text: code }], { type: 'code' })
        at = close + run.length
        continue
      }
      plain += run
      at += run.length
      continue
    }
    if (!inLink && depth < MAX_INLINE_DEPTH && (char === '[' || (char === '!' && text[at + 1] === '['))) {
      const link = linkAt(text, at)
      const href = link ? safeHref(link.href) : null
      if (link && href) {
        const label = parseInline(link.label, depth + 1, true)
        push(label.length ? label : [{ type: 'text', text: href }], { type: 'link', attrs: { href } })
        at = link.end
        continue
      }
    }
    if (!inLink && char === '<') {
      const auto = /^<(https?:\/\/[^\s<>]+|mailto:[^\s<>]+)>/.exec(rest)
      const href = auto?.[1] ? safeHref(auto[1]) : null
      if (auto && href) {
        push([{ type: 'text', text: auto[1] ?? href }], { type: 'link', attrs: { href } })
        at += auto[0].length
        continue
      }
    }
    if (!inLink && char === 'h' && !/[\p{L}\p{N}]/u.test(text[at - 1] ?? '')) {
      const bare = BARE_URL.exec(rest)?.[0].replace(/[.,;:!?)\]]+$/, '')
      const href = bare ? safeHref(bare) : null
      if (bare && href) {
        push([{ type: 'text', text: bare }], { type: 'link', attrs: { href } })
        at += bare.length
        continue
      }
    }
    if (depth < MAX_INLINE_DEPTH && (char === '*' || char === '_' || char === '~')) {
      const emphasis = EMPHASIS.find(([delimiter]) => rest.startsWith(delimiter))
      const [delimiter = '', type = 'em'] = emphasis ?? []
      const opens = emphasis && !/\s/.test(text[at + delimiter.length] ?? ' ') && !(delimiter[0] === '_' && /[\p{L}\p{N}]/u.test(text[at - 1] ?? ''))
      const close = opens ? closingDelimiter(text, delimiter, at + delimiter.length) : -1
      if (close > at + delimiter.length) {
        push(parseInline(text.slice(at + delimiter.length, close), depth + 1, inLink), { type })
        at = close + delimiter.length
        continue
      }
      // A run that opens nothing stays as written, so ** does not get re-read as two *.
      const run = /^([*_~])\1*/.exec(rest)?.[0] ?? char
      plain += run
      at += run.length
      continue
    }
    plain += char
    at += 1
  }
  flush()
  return mergeText(nodes)
}

const sameMarks = (a: Text, b: Text) => JSON.stringify(a.marks ?? []) === JSON.stringify(b.marks ?? [])

function mergeText(nodes: readonly Inline[]): Inline[] {
  const merged: Inline[] = []
  for (const node of nodes) {
    const last = merged.at(-1)
    if (node.type === 'text' && !node.text) continue
    if (node.type === 'text' && last?.type === 'text' && sameMarks(last, node)) merged[merged.length - 1] = { ...last, text: last.text + node.text }
    else merged.push(node)
  }
  // Breaks at the edges of a paragraph are blank lines Jira would show.
  while (merged[0]?.type === 'hardBreak') merged.shift()
  while (merged.at(-1)?.type === 'hardBreak') merged.pop()
  return merged
}

export function markdownToAdf(markdown: string): AdfDocument {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  return { type: 'doc', version: 1, content: parseBlocks(lines, 0) }
}
