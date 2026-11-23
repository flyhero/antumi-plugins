import { z } from 'zod'
import { SourceError } from '@antumi/plugin-sdk'
import { configPage } from './meegle-url.js'

const PROTOCOL_VERSION = '2025-03-26'
const MAX_REPLY = 5 * 1024 * 1024
const RETRY_DELAYS = [1_000, 3_000]

const Content = z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough())
const Reply = z.object({
  error: z.object({ code: z.number().optional(), message: z.string().optional() }).passthrough().optional(),
  result: z.object({ content: Content.optional(), isError: z.boolean().optional() }).passthrough().optional()
}).passthrough()

type Sleep = (ms: number, signal: AbortSignal) => Promise<void>
const sleep: Sleep = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms)
  signal.addEventListener('abort', () => { clearTimeout(timer); reject(new SourceError('request-failed', '请求已取消')) }, { once: true })
})

class Retry extends Error {}

// A field or option label the space does not have, named when the server says which.
export class UnknownField extends SourceError {
  constructor(readonly field: string | undefined, message: string) { super('invalid-settings', message) }
}

// A reply is plain JSON or an SSE stream whose last data line holds the result.
export function parseFrame(body: string): unknown {
  let last: unknown
  for (const line of body.split('\n')) {
    const text = line.replace(/\r$/, '').replace(/^data:\s*/, '').trim()
    if (!text.startsWith('{')) continue
    try { last = JSON.parse(text) } catch { /* a partial line */ }
  }
  if (last === undefined) throw new SourceError('request-failed', '飞书项目返回了无法识别的数据')
  return last
}

// Tool failures read `error=<Code>,message=<text>,retriable=<bool>`; the message may hold commas.
export function toolFailure(text: string): { code: string, message: string, retriable: boolean } {
  const code = /error=([A-Za-z0-9_]+)/.exec(text)?.[1] ?? ''
  const end = text.lastIndexOf(',retriable=')
  const start = text.indexOf('message=')
  const message = start >= 0 ? text.slice(start + 'message='.length, end > start ? end : undefined) : text
  return { code, message: message.trim(), retriable: end >= 0 && text.slice(end + ',retriable='.length).trim().startsWith('true') }
}

const isLogId = (text: string) => /^log_?id:/.test(text.trim())

export class McpSession {
  private session: string | undefined
  private nextId = 1

  constructor(private readonly host: string, private readonly token: string, private readonly fetchImpl: typeof fetch = fetch, private readonly wait: Sleep = sleep) {}

  async call(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      try {
        if (!this.session) await this.open(signal)
        return await this.tool(name, args, signal)
      } catch (failure) {
        if (!(failure instanceof Retry) || attempt >= RETRY_DELAYS.length) throw failure instanceof Retry ? new SourceError('request-failed', failure.message) : failure
        await this.wait(RETRY_DELAYS[attempt] ?? 0, signal)
      }
    }
  }

  private async open(signal: AbortSignal): Promise<void> {
    const { response } = await this.post({ jsonrpc: '2.0', id: this.nextId++, method: 'initialize', params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'antumi-plugin-meegle', version: '0.1.0' } } }, signal)
    const session = response.headers.get('mcp-session-id')
    if (!session) throw new SourceError('request-failed', '飞书项目没有建立 MCP 会话')
    this.session = session
    await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' }, signal).catch(() => undefined)
  }

  private async tool(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    const { body } = await this.post({ jsonrpc: '2.0', id: this.nextId++, method: 'tools/call', params: { name, arguments: args } }, signal)
    const reply = Reply.safeParse(parseFrame(body))
    if (!reply.success) throw new SourceError('request-failed', '飞书项目返回了无法识别的数据')
    if (reply.data.error) throw new SourceError('request-failed', this.scrub(`飞书项目拒绝了 ${name} 调用：${reply.data.error.message ?? reply.data.error.code ?? ''}`))
    const texts = (reply.data.result?.content ?? []).map((part) => part.text ?? '')
    const logId = texts.map((text) => /log_?id:\s*(\S+)/.exec(text)?.[1]).find(Boolean)
    if (reply.data.result?.isError) throw this.failure(texts.find((text) => !isLogId(text)) ?? '', logId)
    for (const text of texts) {
      const trimmed = text.trim()
      if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) continue
      try { return JSON.parse(trimmed) } catch { /* the log id may be appended to the payload */ }
      try { return JSON.parse(trimmed.replace(/\s*log_?id:\s*\S+\s*$/, '')) } catch { /* not this block */ }
    }
    throw new SourceError('request-failed', `飞书项目的 ${name} 没有返回可读的结果`)
  }

  private failure(text: string, logId: string | undefined): Error {
    const { code, message, retriable } = toolFailure(text)
    const trace = logId ? `（log_id ${logId}）` : ''
    if (code === 'MCPPersonalPreferenceDisabled') return new SourceError('auth-failed', `飞书项目的 MCP 功能没有开启：请在 ${configPage(this.host)} 打开个人偏好里的 MCP 开关`)
    if (retriable || code === 'RPCError' && message.includes('1606')) return new Retry(this.scrub(`飞书项目暂时繁忙：${code}${trace}`))
    const detail = this.scrub(`${code ? `${code}：` : ''}${message}`.slice(0, 300))
    if (/NoPermission|Forbidden/i.test(code)) return new SourceError('forbidden', `没有权限：${detail}${trace}`)
    if (/NotFound/i.test(code)) return new SourceError('not-found', `找不到：${detail}${trace}`)
    if (/attr(ibute)? ?(value)?label not found|attribute not found|3010/i.test(message)) {
      const field = /\blabel:([A-Za-z0-9_]+)/.exec(message)?.[1]
      return new UnknownField(field, `${field ? `空间里没有字段「${field}」，请检查筛选条件` : '查询里有空间不认识的字段或选项，请检查筛选条件'}：${detail}${trace}`)
    }
    return new SourceError('request-failed', `飞书项目返回错误 ${detail}${trace}`)
  }

  private scrub(text: string): string {
    return this.token ? text.split(this.token).join('***') : text
  }

  private async post(payload: unknown, signal: AbortSignal): Promise<{ response: Response, body: string }> {
    let response: Response
    try {
      response = await this.fetchImpl(`https://${this.host}/mcp_server/v1`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'X-Mcp-Token': this.token, ...(this.session ? { 'Mcp-Session-Id': this.session } : {}) },
        body: JSON.stringify(payload)
      })
    } catch {
      if (signal.aborted) throw new SourceError('request-failed', '请求已取消')
      throw new SourceError('request-failed', `无法连接 ${this.host}，请检查网络和代理`)
    }
    if (response.status === 404 && this.session) {
      await response.body?.cancel()
      this.session = undefined
      throw new Retry('飞书项目的 MCP 会话已失效')
    }
    if (response.status === 429 || response.status >= 500) {
      await response.body?.cancel()
      throw new Retry(`飞书项目暂时不可用（HTTP ${response.status}）`)
    }
    if (!response.ok) {
      await response.body?.cancel()
      if (response.status === 401) throw new SourceError('auth-failed', `MCP Token 无效或已被重置，请在 ${configPage(this.host)} 重新复制`)
      if (response.status === 403) throw new SourceError('forbidden', '飞书项目拒绝访问，请检查 MCP 配置页里的数据权限')
      throw new SourceError('request-failed', `飞书项目请求失败（HTTP ${response.status}）`)
    }
    return { response, body: await this.text(response) }
  }

  private async text(response: Response): Promise<string> {
    if (Number(response.headers.get('content-length')) > MAX_REPLY) {
      await response.body?.cancel()
      throw new SourceError('response-too-large', '飞书项目返回内容过大')
    }
    const reader = response.body?.getReader()
    if (!reader) return ''
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > MAX_REPLY) { await reader.cancel(); throw new SourceError('response-too-large', '飞书项目返回内容过大') }
        chunks.push(value)
      }
    } finally { reader.releaseLock() }
    return Buffer.concat(chunks).toString('utf8')
  }
}
