import { MAX_ATTACHMENT_BYTES, MAX_TASK_IMAGES } from '@antumi/plugin-sdk'
import { JiraClient, normalizeSite, type JiraApi, type JiraAttachment, type JiraCredentials, type JiraIssue } from './jira-client.js'
import { issueSnapshot, isImageAttachment, type ImageOutcome } from './jira-snapshot.js'
import { markdownToAdf } from './markdown-adf.js'
import { SourceError } from '@antumi/plugin-sdk'
import type { SourceCredential, SourcePlugin, SourceSettings } from '@antumi/plugin-sdk'

export const DEFAULT_JIRA_JQL = 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC'

const TOKEN_PAGE = 'https://id.atlassian.com/manage-profile/security/api-tokens'
const LOGIN_ATTEMPTS = 3
// Images come along with an issue, within limits that keep an import quick and bounded.
const IMAGE_CONCURRENCY = 3
const IMAGE_TIMEOUT_MS = 30_000
const IMAGE_TOTAL_BYTES = 50 * 1024 * 1024
// Clients remember whether a token needs the api.atlassian.com gateway; keep a few around.
const CLIENT_CACHE_SIZE = 8

async function inBatches<T>(items: readonly T[], size: number, run: (item: T) => Promise<void>): Promise<void> {
  for (let at = 0; at < items.length; at += size) {
    await Promise.all(items.slice(at, at + size).map(run))
  }
}

// Which image attachments to fetch, in the issue's order, within the limits.
function wantedImages(issue: JiraIssue): { wanted: JiraAttachment[]; outcomes: Map<string, ImageOutcome> } {
  const outcomes = new Map<string, ImageOutcome>()
  const wanted: JiraAttachment[] = []
  let budget = IMAGE_TOTAL_BYTES
  for (const file of issue.attachments.filter(isImageAttachment)) {
    const fits = wanted.length < MAX_TASK_IMAGES && file.size <= MAX_ATTACHMENT_BYTES && file.size <= budget
    outcomes.set(file.id, fits ? 'failed' : 'skipped')
    if (fits) {
      wanted.push(file)
      budget -= file.size
    }
  }
  return { wanted, outcomes }
}

// Fetches the wanted images and says what became of each.
async function downloadImages(api: JiraApi, issue: JiraIssue, signal: AbortSignal) {
  const { wanted, outcomes } = wantedImages(issue)
  const fetched = new Map<string, Uint8Array>()
  await inBatches(wanted, IMAGE_CONCURRENCY, async (file) => {
    try {
      const bytes = await api.download(file.id, MAX_ATTACHMENT_BYTES, AbortSignal.any([signal, AbortSignal.timeout(IMAGE_TIMEOUT_MS)]))
      fetched.set(file.id, bytes)
      outcomes.set(file.id, 'saved')
    } catch (error) {
      // A token without read:attachment:jira gets 403 here; the issue still imports.
      console.error(`[antumi-jira] image ${file.filename} of ${issue.key} not fetched:`, error instanceof Error ? error.message : error)
    }
  })
  const images = wanted.flatMap((file) => {
    const bytes = fetched.get(file.id)
    return bytes ? [{ name: file.filename, bytes }] : []
  })
  return { images, outcomes }
}

function writable(api: JiraApi): Required<Pick<JiraApi, 'transitions' | 'transition' | 'addComment'>> {
  const { transitions, transition, addComment } = api
  if (!transitions || !transition || !addComment) throw new SourceError('request-failed', '这个 Jira 连接不支持回写。')
  return { transitions: transitions.bind(api), transition: transition.bind(api), addComment: addComment.bind(api) }
}

function jiraCredentials(settings: SourceSettings, credential: SourceCredential): JiraCredentials {
  const { email, token } = credential.payload
  if (credential.kind !== 'basic' || !email || !token) {
    throw new SourceError('not-configured', 'the saved Jira credential is incomplete; sign in again')
  }
  return { site: settings.site ?? '', email, token }
}

// Jira Cloud (and Server with an email-style login) through an email + API token.
export function jiraProvider(connect: (credentials: JiraCredentials) => JiraApi = (c) => new JiraClient(c)): SourcePlugin {
  const clients = new Map<string, JiraApi>()
  const client = (credentials: JiraCredentials): JiraApi => {
    const id = JSON.stringify(credentials)
    const cached = clients.get(id)
    if (cached) {
      return cached
    }
    if (clients.size >= CLIENT_CACHE_SIZE) {
      clients.clear()
    }
    const created = connect(credentials)
    clients.set(id, created)
    return created
  }

  return {
    id: 'jira',
    normalizeSettings: (values) => ({ site: normalizeSite(values.site ?? ''), jql: values.jql?.trim() || DEFAULT_JIRA_JQL }),
    normalizeKey: (key) => key.trim().toUpperCase(),
    envCredential: (env) => {
      const email = env.ANTUMI_JIRA_EMAIL
      const token = env.ANTUMI_JIRA_TOKEN
      return email && token ? { kind: 'basic', payload: { email, token } } : null
    },

    async login(session, settings, signal) {
      let email = ''
      let error: string | undefined
      for (let attempt = 1; ; attempt += 1) {
        email = (
          await session.prompt({
            translations: { en: { label: 'Sign-in email', ...(error ? { error: 'Email or API token is invalid. Try again' } : {}) } },
            kind: 'text',
            label: '登录邮箱',
            placeholder: 'you@company.com',
            defaultValue: email || undefined,
            error
          })
        ).trim()
        const token = (
          await session.prompt({
            translations: { en: { hint: 'Read permission is enough for syncing; changing status and posting comments need write permission (write:jira-work for a scoped token). Your token stays on this computer and is never shared with Agents.' } },
            kind: 'secret',
            label: 'API token',
            hint: '同步只需要读权限；在 Antumi 里改状态、发评论需要写权限（带权限范围的 token 要有 write:jira-work）。token 只保存在本机，不会交给 Agent。',
            link: { url: TOKEN_PAGE, label: '在 Atlassian 账号设置里创建', translations: { en: { label: 'Create in Atlassian account settings' } } }
          })
        ).trim()
        try {
          const { displayName } = await client({ site: settings.site ?? '', email, token }).myself(signal)
          return { credential: { kind: 'basic', payload: { email, token } }, account: displayName }
        } catch (failure) {
          if (!(failure instanceof SourceError) || failure.code !== 'auth-failed' || attempt >= LOGIN_ATTEMPTS) {
            throw failure
          }
          error = '邮箱或 API token 不对，请重新输入'
        }
      }
    },

    comments: (settings, credential, key, signal, options) => {
      const api = client(jiraCredentials(settings, credential))
      if (!api.commentChanges) throw new SourceError('request-failed', 'Comment sync is unavailable')
      return api.commentChanges(key, signal, options)
    },
    // An image a comment listed, by its attachment id; Antumi checks that the bytes are an image.
    async image(settings, credential, _key, id, signal) {
      const bytes = await client(jiraCredentials(settings, credential)).download(id, MAX_ATTACHMENT_BYTES, AbortSignal.any([signal, AbortSignal.timeout(IMAGE_TIMEOUT_MS)]))
      return { name: '', bytes }
    },

    transitions: (settings, credential, key, signal) => writable(client(jiraCredentials(settings, credential))).transitions(key, signal),
    transition: (settings, credential, key, id, signal) => writable(client(jiraCredentials(settings, credential))).transition(key, id, signal),
    // Jira has no client-supplied comment id, so writeId has nowhere to go.
    async comment(settings, credential, key, { markdown }, signal) {
      const body = markdownToAdf(markdown)
      if (!body.content.length) throw new SourceError('request-failed', '评论内容为空，没有发送。')
      return writable(client(jiraCredentials(settings, credential))).addComment(key, body, signal)
    },

    list: (settings, credential, signal) => client(jiraCredentials(settings, credential)).search(settings.jql ?? DEFAULT_JIRA_JQL, signal),

    // The raw fields ride along; core keeps only what the issue schema names. Asked for the text
    // alone, it downloads no image and counts the ones a later fetch will bring.
    async fetch(settings, credential, key, signal, options) {
      const api = client(jiraCredentials(settings, credential))
      const issue = await api.issue(key, signal)
      if (options?.images === false) {
        const { wanted, outcomes } = wantedImages(issue)
        for (const file of wanted) outcomes.set(file.id, 'deferred')
        return { ...issue, markdown: issueSnapshot(issue, outcomes), images: [], imagesDeferred: wanted.length }
      }
      const { images, outcomes } = await downloadImages(api, issue, signal)
      return { ...issue, markdown: issueSnapshot(issue, outcomes), images }
    }
  }
}
