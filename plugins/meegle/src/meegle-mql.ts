import { z } from 'zod'
import { SourceError } from '@antumi/plugin-sdk'

export const DEFAULT_FILTER = 'array_contains(all_participate_persons(), current_login_user()) AND `archiving_status` = false'

const identifier = (value: string) => `\`${value.replace(/`/g, '')}\``

// The user writes the condition alone: the plugin picks the space, the type and the columns it reads.
export function normalizeFilter(value: string | undefined): string {
  const filter = (value ?? '').replace(/\s+/g, ' ').trim() || DEFAULT_FILTER
  const outside = filter.replace(/'(?:[^']|'')*'|`[^`]*`/g, '')
  if (/;|\b(select|from|order\s+by|limit)\b/i.test(outside)) throw new SourceError('invalid-settings', '筛选条件只写 WHERE 后面的部分，不要包含 SELECT、FROM、ORDER BY 或 LIMIT')
  if (filter.length > 2000) throw new SourceError('invalid-settings', '筛选条件太长')
  return filter
}

export function buildMql(space: string, type: string, filter: string): string {
  return [
    'SELECT `work_item_id`, `name`, `work_item_status`, `priority`, `updated_at`, `archiving_status`',
    `FROM ${identifier(space)}.${identifier(type)}`,
    `WHERE ${filter}`,
    'ORDER BY `updated_at` DESC'
  ].join(' ')
}

const Label = z.object({ key: z.string().optional(), label: z.string().optional() }).passthrough()
const Value = z.object({
  long_value: z.union([z.number(), z.string()]).optional(),
  double_value: z.number().optional(),
  string_value: z.string().optional(),
  bool_value: z.boolean().optional(),
  key_label_value: Label.optional(),
  key_label_value_list: z.array(Label).optional()
}).passthrough()
const Row = z.object({ moql_field_list: z.array(z.object({ key: z.string(), value: Value.nullish() }).passthrough()).nullish() }).passthrough()
export const MqlPage = z.object({
  session_id: z.string().nullish(),
  list: z.array(z.object({ count: z.number().optional(), group_infos: z.array(z.object({ group_id: z.string() }).passthrough()).nullish() }).passthrough()).nullish(),
  data: z.record(z.string(), z.array(Row)).nullish()
}).passthrough()
export type MqlPage = z.infer<typeof MqlPage>

export type MqlItem = { id: string, name: string, status: string | null, priority: string | null, updatedOn: string | null, archived: boolean }

function text(value: z.infer<typeof Value> | null | undefined): string | null {
  if (!value) return null
  if (value.string_value !== undefined) return value.string_value
  if (value.long_value !== undefined) return String(value.long_value)
  if (value.double_value !== undefined) return String(value.double_value)
  if (value.key_label_value) return value.key_label_value.label ?? value.key_label_value.key ?? null
  if (value.key_label_value_list) return value.key_label_value_list.map((item) => item.label ?? item.key).filter(Boolean).join('、') || null
  if (value.bool_value !== undefined) return String(value.bool_value)
  return null
}

export function rows(page: MqlPage): MqlItem[] {
  const items: MqlItem[] = []
  for (const group of Object.values(page.data ?? {})) {
    for (const row of group) {
      const fields = new Map((row.moql_field_list ?? []).map((field) => [field.key, field.value]))
      const id = text(fields.get('work_item_id'))
      if (!id || !/^[1-9][0-9]{0,18}$/.test(id)) throw new SourceError('request-failed', '飞书项目返回了无效的工作项 ID')
      const archived = fields.get('archiving_status')
      items.push({
        id, name: text(fields.get('name')) ?? `#${id}`,
        status: text(fields.get('work_item_status')), priority: text(fields.get('priority')),
        updatedOn: text(fields.get('updated_at')),
        archived: archived?.bool_value === true || archived?.string_value === 'true' || archived?.long_value === 1
      })
    }
  }
  return items
}

// MQL dates carry the day alone, read as UTC midnight; the detail has the exact time.
export function day(value: string | null): number | null {
  const match = value && /^(\d{4})-(\d{2})-(\d{2})/.exec(value)
  if (!match) return null
  const time = Date.parse(`${match[1]}-${match[2]}-${match[3]}T00:00:00Z`)
  return Number.isFinite(time) ? time : null
}
