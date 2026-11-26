import type { SourceUser } from '@antumi/plugin-sdk'

// Names and participation do not establish ownership; every member must have a stable ID.
export function people(value: unknown): SourceUser[] | undefined {
  if (!Array.isArray(value)) return undefined
  const found = new Map<string, SourceUser>()
  for (const item of value) {
    const fields = item && typeof item === 'object' ? new Map(Object.entries(item)) : new Map<string, unknown>()
    const raw = typeof item === 'string' ? item : fields.get('user_key') ?? fields.get('key') ?? fields.get('id')
    if (typeof raw !== 'string' || !raw.trim() || raw.length > 500) return undefined
    const name = fields.get('name_cn') ?? fields.get('name') ?? fields.get('name_en') ?? raw
    found.set(raw, { id: raw, name: (typeof name === 'string' ? name : raw).slice(0, 200) })
  }
  return found.size <= 50 ? [...found.values()] : undefined
}
