import type {ChatTool, Connection, ToolCall, ToolChatMessage} from './llm-connection'
import {abortError} from './abortable'

export interface LlmUsage {promptTokens: number | null; completionTokens: number | null; cacheHitTokens: number | null; cacheMissTokens: number | null}
export interface StreamOptions {
    request?: typeof fetch
    idleMs?: number
    delays?: number[]
    onPartialResponse?: (response: unknown) => void
    onDelta?: (content: string) => void
    onRetry?: (attempt: number, delayMs: number, reason: string) => void
    onUsage?: (usage: LlmUsage, elapsedMs: number) => void
}
class HttpError extends Error {
    constructor(public status: number) {super(`模型服务请求失败（HTTP ${status}）。`)}
}
/** User-facing reason for an incomplete response; avoids blaming tool calls that were never made. */
function finishMessage(reason: string | null): string {
    if (reason === 'length') return '回答达到长度上限，已截断，可以让我分段继续。'
    if (reason === 'content_filter') return '模型因内容策略中断了回答。'
    return '模型输出未正常结束，已保留前半段回答，可以重试。'
}
export function readUsage(value: unknown): LlmUsage {
    const v = value && typeof value === 'object' ? value as Record<string, unknown> : {}
    const count = (key: string) => typeof v[key] === 'number' && Number.isSafeInteger(v[key]) && (v[key] as number) >= 0 ? v[key] as number : null
    return {promptTokens: count('prompt_tokens'), completionTokens: count('completion_tokens'),
        cacheHitTokens: count('prompt_cache_hit_tokens'), cacheMissTokens: count('prompt_cache_miss_tokens')}
}
export function validateAssistant(content: unknown, calls: unknown): Extract<ToolChatMessage, {role: 'assistant'}> {
    if (content !== null && content !== undefined && typeof content !== 'string') throw new Error('模型文本格式无效。')
    if (typeof content === 'string' && content.length > 64000) throw new Error('模型回复过长，请缩小问题范围。')
    if (calls !== undefined && (!Array.isArray(calls) || calls.length > 8 || calls.some(call =>
        !call || typeof call.id !== 'string' || !call.id || call.id.length > 200 || call.type !== 'function' ||
        typeof call.function?.name !== 'string' || !call.function.name || call.function.name.length > 100 ||
        typeof call.function?.arguments !== 'string' || call.function.arguments.length > 16000) ||
        new Set(calls.map(call => call.id)).size !== calls.length)) throw new Error('模型返回了无效的工具调用。')
    if (!(typeof content === 'string' && content.trim()) && !(Array.isArray(calls) && calls.length)) throw new Error('模型未返回有效回复。')
    return {role: 'assistant', content: typeof content === 'string' ? content : null,
        ...(Array.isArray(calls) && calls.length ? {tool_calls: calls as ToolCall[]} : {})}
}
function wait(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        signal.throwIfAborted()
        const abort = () => {clearTimeout(timer); reject(abortError(signal.reason))}
        const timer = setTimeout(() => {signal.removeEventListener('abort', abort); resolve()}, ms)
        signal.addEventListener('abort', abort, {once: true})
    })
}

/** Retries only before a successful HTTP response. Partial streams are never replayed. */
export async function streamLlmWithTools(connection: Connection, messages: ToolChatMessage[], tools: ChatTool[],
                                        enabledSignal: AbortSignal, options: StreamOptions = {}) {
    const started = performance.now()
    let usage: LlmUsage = {promptTokens: null, completionTokens: null, cacheHitTokens: null, cacheMissTokens: null}
    let idle: ReturnType<typeof setTimeout> | undefined
    let controller = new AbortController()
    const resetIdle = () => {
        clearTimeout(idle)
        idle = setTimeout(() => controller.abort(new DOMException('模型响应空闲超时。', 'TimeoutError')), options.idleMs ?? 60000)
    }
    const delays = options.delays ?? [1000, 3000]
    const request = options.request ?? fetch
    let response: Response | undefined
    let includeUsage = true
    let streaming = true
    let attempts = 0
    try {
        for (;;) {
            enabledSignal.throwIfAborted()
            controller = new AbortController()
            const signal = AbortSignal.any([enabledSignal, controller.signal])
            resetIdle()
            try {
                response = await request(`${connection.baseUrl}/chat/completions`, {
                    method: 'POST', redirect: 'error', signal,
                    headers: {'Content-Type': 'application/json', Accept: 'text/event-stream, application/json',
                        ...(connection.apiKey ? {Authorization: `Bearer ${connection.apiKey}`} : {})},
                    body: JSON.stringify({model: connection.model, messages, stream: streaming,
                        ...(streaming && includeUsage ? {stream_options: {include_usage: true}} : {}),
                        ...(tools.length ? {tools, tool_choice: 'auto'} : {})}),
                })
                if (!response.ok) {
                    await response.body?.cancel().catch(() => {})
                    // Some compatible providers reject include_usage. One compatibility retry, no side effect has run.
                    if ([400, 415, 422].includes(response.status) && streaming && includeUsage) {
                        includeUsage = false
                        options.onRetry?.(attempts + 1, 0, '端点不接受 stream_options，移除后重试。')
                        continue
                    }
                    if ([400, 415, 422].includes(response.status) && streaming) {
                        streaming = false
                        options.onRetry?.(attempts + 1, 0, '端点拒绝流式请求，降级为完整 JSON 响应。')
                        continue
                    }
                    throw new HttpError(response.status)
                }
                break
            } catch (error) {
                enabledSignal.throwIfAborted()
                if (controller.signal.aborted) throw abortError(controller.signal.reason)
                const transient = error instanceof TypeError || (error instanceof HttpError && (error.status === 429 || error.status >= 500))
                if (!transient || attempts >= delays.length) throw error
                clearTimeout(idle)
                const delay = delays[attempts++]
                options.onRetry?.(attempts, delay, error instanceof Error ? error.message : '网络错误')
                await wait(delay, enabledSignal)
            }
        }
        if (!response?.body) throw new Error('接口未返回响应内容。')
        const signal = AbortSignal.any([enabledSignal, controller.signal])
        const reader = response.body.getReader()
        const stopReading = () => {void reader.cancel(signal.reason).catch(() => {})}
        signal.addEventListener('abort', stopReading, {once: true})
        const decoder = new TextDecoder()
        let buffer = '', size = 0, content = '', doneEvent = false, finishReason: string | null = null
        const calls = new Map<number, ToolCall>()
        const json = response.headers.get('content-type')?.includes('application/json')
        const consume = (data: string) => {
            if (data === '[DONE]') {doneEvent = true; return}
            if (doneEvent) throw new Error('模型在结束标记后继续返回内容。')
            const chunk = JSON.parse(data)
            if (chunk.error) throw new Error('模型流返回错误。')
            if (chunk.usage) usage = readUsage(chunk.usage)
            const choice = chunk.choices?.[0]
            if (!choice) return
            if (choice.finish_reason) finishReason = choice.finish_reason
            const delta = choice.delta
            if (typeof delta?.content === 'string') {
                content += delta.content
                if (content.length > 64000) throw new Error('模型回复过长。')
                options.onDelta?.(delta.content)
            }
            if (delta?.tool_calls !== undefined) {
                if (!Array.isArray(delta.tool_calls)) throw new Error('工具调用分片格式无效。')
                for (const part of delta.tool_calls) {
                    if (!Number.isInteger(part.index) || part.index < 0 || part.index >= 8) throw new Error('工具调用分片索引无效。')
                    const call = calls.get(part.index) ?? {id: '', type: 'function', function: {name: '', arguments: ''}}
                    if (part.type !== undefined && part.type !== 'function') throw new Error('工具调用类型无效。')
                    for (const field of ['id'] as const) if (part[field] !== undefined) {
                        if (typeof part[field] !== 'string') throw new Error('工具调用 ID 无效。')
                        call[field] += part[field]
                    }
                    for (const field of ['name', 'arguments'] as const) if (part.function?.[field] !== undefined) {
                        if (typeof part.function[field] !== 'string') throw new Error('工具调用参数分片无效。')
                        call.function[field] += part.function[field]
                    }
                    if (call.function.arguments.length > 16000 || call.id.length > 200 || call.function.name.length > 100) throw new Error('工具调用分片过长。')
                    calls.set(part.index, call)
                }
            }
        }
        const dataLines: string[] = []
        // SSE permits LF, CRLF and bare CR. Preserve a CR at a chunk boundary until its next byte arrives.
        const drain = () => {
            for (;;) {
                const index = buffer.search(/[\r\n]/)
                if (index < 0 || (buffer[index] === '\r' && index === buffer.length - 1)) break
                const line = buffer.slice(0, index)
                const length = buffer[index] === '\r' && buffer[index + 1] === '\n' ? 2 : 1
                buffer = buffer.slice(index + length)
                if (!line) {
                    if (dataLines.length) consume(dataLines.join('\n'))
                    dataLines.length = 0
                } else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''))
            }
        }

        try {
            while (true) {
                signal.throwIfAborted()
                const {done, value} = await reader.read()
                if (done) break
                resetIdle()
                size += value.byteLength
                if (size > 1024 * 1024) throw new Error('接口响应超过 1 MiB 限制。')
                buffer += decoder.decode(value, {stream: true})
                if (!json) drain()
                if (doneEvent) break
            }
            signal.throwIfAborted()
            buffer += decoder.decode()
            if (json) {
                const payload = JSON.parse(buffer)
                if (payload.error) throw new Error('模型服务返回错误。')
                usage = readUsage(payload.usage)
                const reason = payload.choices?.[0]?.finish_reason
                if (reason && !['stop', 'tool_calls'].includes(reason)) throw new Error(finishMessage(reason))
                const message = payload.choices?.[0]?.message
                const result = validateAssistant(message?.content, message?.tool_calls)
                if (result.content) options.onDelta?.(result.content)
                return result
            }
            drain()
            // A final data frame without a trailing blank line is accepted only when it contains [DONE].
            if (buffer.trim() === 'data: [DONE]' || dataLines.join('\n') === '[DONE]') doneEvent = true
            if (!doneEvent || !['stop', 'tool_calls'].includes(finishReason ?? '')) {
                throw new Error(doneEvent ? finishMessage(finishReason) : '连接中断，已保留前半段回答，可以重试。')
            }
            const ordered = [...calls.entries()].sort(([a], [b]) => a - b)
            if (ordered.some(([index], position) => index !== position)) throw new Error('工具调用分片缺少索引。')
            return validateAssistant(content || null, ordered.map(([, call]) => call))
        } catch (error) {
            options.onPartialResponse?.({content, tool_calls: [...calls.values()], finishReason, responseTail: buffer.slice(-2000)})
            if (signal.aborted) throw abortError(signal.reason)
            throw error
        } finally {
            signal.removeEventListener('abort', stopReading)
            await reader.cancel().catch(() => {})
            reader.releaseLock()
        }
    } finally {
        clearTimeout(idle)
        options.onUsage?.(usage, performance.now() - started)
    }
}
