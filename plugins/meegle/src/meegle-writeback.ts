import { z } from 'zod'

// What the write tools answer is known only from meegle-cli's docs and third-party notes, so every
// shape here is read loosely and kept in this file.

const Id = z.union([z.string(), z.number()])
const Transition = z.object({
  id: Id.optional(), transition_id: Id.optional(),
  state_name: z.string().optional(), name: z.string().optional(),
  state_key: z.string().optional(), key: z.string().optional()
}).passthrough()
const Node = z.object({
  node_key: z.string().optional(), key: z.string().optional(), id: Id.optional(),
  name: z.string().optional(), node_name: z.string().optional(),
  status: z.union([z.string(), z.number()]).optional(), node_status: z.union([z.string(), z.number()]).optional()
}).passthrough()

export type StateMove = { transition: string, name: string, key: string }
export type NodeMove = { node: string, name: string }

// A list either bare or under one of the keys these tools have been seen to use.
function listOf(value: unknown, keys: readonly string[]): unknown[] {
  if (Array.isArray(value)) return value
  if (!value || typeof value !== 'object') return []
  const record = new Map(Object.entries(value))
  for (const key of keys) {
    const found = record.get(key)
    if (Array.isArray(found)) return found
    if (found && typeof found === 'object') { const inner = listOf(found, keys); if (inner.length) return inner }
  }
  return []
}

const text = (value: string | number | undefined) => value === undefined ? '' : String(value).trim()

// get_transitable_states: `[{id, state_name, state_key}]`, sometimes under `data`.
export function stateMoves(reply: unknown): StateMove[] {
  return listOf(reply, ['data', 'list', 'transitions', 'states', 'items']).flatMap((item) => {
    const parsed = Transition.safeParse(item)
    if (!parsed.success) return []
    const transition = text(parsed.data.transition_id ?? parsed.data.id)
    const name = (parsed.data.state_name || parsed.data.name || '').trim()
    return transition && name ? [{ transition, name, key: parsed.data.state_key || parsed.data.key || '' }] : []
  })
}

// get_node_detail: nodes with a node_key and a status, `doing` for the ones in progress.
export function currentNodes(reply: unknown, names: readonly string[]): NodeMove[] {
  return listOf(reply, ['nodes', 'node_list', 'list', 'data', 'items']).flatMap((item) => {
    const parsed = Node.safeParse(item)
    if (!parsed.success) return []
    const node = text(parsed.data.node_key ?? parsed.data.key ?? parsed.data.id)
    const name = (parsed.data.name || parsed.data.node_name || '').trim()
    const status = text(parsed.data.status ?? parsed.data.node_status).toLowerCase()
    const doing = status ? status === 'doing' || status === '2' || status === '进行中' : names.includes(name)
    return node && name && doing ? [{ node, name }] : []
  })
}

// add_comment's answer, if it names the comment: a bare ID, an object or a sentence holding one.
export function commentId(reply: unknown, depth = 0): string | null {
  if (typeof reply === 'number') return Number.isSafeInteger(reply) && reply > 0 ? String(reply) : null
  if (typeof reply === 'string') {
    const trimmed = reply.trim()
    if (/^[1-9][0-9]{0,24}$/.test(trimmed)) return trimmed
    return /comment_?id\W{0,3}([1-9][0-9]{0,24})/i.exec(trimmed)?.[1] ?? null
  }
  if (!reply || typeof reply !== 'object' || Array.isArray(reply) || depth > 2) return null
  const record = new Map(Object.entries(reply))
  for (const key of ['comment_id', 'commentId', 'id', 'data', 'comment']) {
    const found = commentId(record.get(key), depth + 1)
    if (found) return found
  }
  return null
}

// Meegle's editor reads GFM, so Markdown goes as it is. HTML comments carry the editor's metadata
// (@mentions among them), so the ones outside code are dropped rather than trusted.
export function commentMarkdown(markdown: string): string {
  const parts = markdown.replace(/\r\n?/g, '\n').split(/(^(?:```|~~~)[^\n]*\n[\s\S]*?^(?:```|~~~)[ \t]*$)/m)
  return parts.map((part, index) => index % 2 ? part : part.split(/(`[^`\n]+`)/).map((piece, inner) =>
    inner % 2 ? piece : piece.replace(/<!--[\s\S]*?(?:-->|$)/g, '')).join('')).join('').trim()
}

// The same text as Meegle stores it, for finding the comment just posted.
export const sameText = (a: string, b: string) => a.replace(/<!--[\s\S]*?-->/g, '').replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim()
