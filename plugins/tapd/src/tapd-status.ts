import type { SourceIssue } from '@antumi/plugin-sdk'
import type { ItemKind } from './tapd-url.js'

// Tasks have a fixed workflow; stories and bugs name their statuses per project.
export const TASK_STATUSES: Readonly<Record<string, string>> = { open: '未开始', progressing: '进行中', done: '已完成' }
export const TASK_LAST_STEPS: ReadonlySet<string> = new Set(['done'])

// Keys of TAPD's built-in workflows, used when the project does not say which statuses end it.
const DONE = new Set(['done', 'closed', 'resolved', 'verified', 'rejected', 'cancelled', 'canceled'])
const DOING = new Set(['developing', 'progressing', 'in_progress', 'testing', 'fixing'])
const TODO = new Set(['planning', 'new', 'open', 'reopened', 'assigned', 'unconfirmed', 'audited'])

const PRIORITIES: Readonly<Record<string, string>> = {
  urgent: '紧急', high: '高', medium: '中', middle: '中', low: '低', insignificant: '无关紧要', 'nice to have': '无关紧要'
}

export function category(status: string, lastSteps: ReadonlySet<string> | null): SourceIssue['statusCategory'] {
  if (lastSteps ? lastSteps.has(status) : DONE.has(status)) return 'done'
  if (DOING.has(status)) return 'doing'
  if (TODO.has(status)) return 'todo'
  return 'unknown'
}

export const typeName: Readonly<Record<ItemKind, string>> = { story: '需求', bug: '缺陷', task: '任务' }

export function priorityName(label: string, value: string): string | null {
  const text = (label || value).trim()
  if (!text || text === '0' || text === '--') return null
  return (PRIORITIES[text.toLowerCase()] ?? text).slice(0, 100)
}
