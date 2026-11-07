import {test} from 'node:test'
import assert from 'node:assert/strict'
import {streamLlmWithTools} from '../src/main/llm-stream.ts'

const connection = {baseUrl: 'https://example.com/v1', model: 'model', apiKey: 'test-key'}
import {streamResponse, replyResponse} from './fakes/model.ts'
test('SSE assembles UTF8 text and indexed tool argument fragments; accepts usage-only tail', async () => {
    let text = '', used: unknown
    const response = streamResponse([
        {choices: [{delta: {content: '查询数学。', tool_calls: [{index: 0, id: 'c1', type: 'function', function: {name: 'list_', arguments: '{"query":'}}]}}]},
        {choices: [{delta: {tool_calls: [{index: 0, function: {name: 'todos', arguments: '"数学"}'}}]}, finish_reason: 'tool_calls'}]},
        {choices: [], usage: {prompt_tokens: 12, completion_tokens: 6}}, '[DONE]',
    ], 1)
    const result = await streamLlmWithTools(connection, [], [], new AbortController().signal, {request: async () => response,
        onDelta: value => {text += value}, onUsage: value => {used = value}})
    assert.equal(text, '查询数学。'); assert.equal(result.tool_calls?.[0].function.name, 'list_todos')
    assert.deepEqual(JSON.parse(result.tool_calls![0].function.arguments), {query: '数学'})
    assert.deepEqual(used, {promptTokens: 12, completionTokens: 6})
})
test('retries 429/5xx before output only; bounded retries and null usage', async () => {
    let calls = 0, usage: unknown
    const result = await streamLlmWithTools(connection, [], [], new AbortController().signal, {delays: [0, 0],
        request: async () => ++calls < 3 ? new Response('', {status: calls === 1 ? 429 : 503}) : replyResponse(),
        onUsage: value => {usage = value}})
    assert.equal(calls, 3); assert.ok(result.content); assert.deepEqual(usage, {promptTokens: null, completionTokens: null})
    calls = 0
    await assert.rejects(streamLlmWithTools(connection, [], [], new AbortController().signal, {delays: [0, 0], request: async () => {calls++; return new Response('', {status: 500})}}))
    assert.equal(calls, 3)
})
test('does not retry 401; falls back once when include_usage is rejected', async () => {
    let calls = 0
    await assert.rejects(streamLlmWithTools(connection, [], [], new AbortController().signal, {request: async () => {calls++; return new Response('', {status: 401})}}))
    assert.equal(calls, 1)
    const bodies: Record<string, unknown>[] = []
    await streamLlmWithTools(connection, [], [], new AbortController().signal, {request: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body))); return bodies.length === 1 ? new Response('', {status: 400}) : replyResponse()
    }})
    assert.ok(bodies[0].stream_options); assert.equal(bodies[1].stream_options, undefined)
})
test('partial stream is not replayed and does not return executable tool calls', async () => {
    let calls = 0
    await assert.rejects(streamLlmWithTools(connection, [], [], new AbortController().signal, {request: async () => {
        calls++; return streamResponse([{choices: [{delta: {content: '部分', tool_calls: [{index: 0, id: 'x', function: {name: 'create_todo', arguments: '{'}}]}}]}])
    }}), /中断/)
    assert.equal(calls, 1)
})
test('duplicate IDs and bad indexes are rejected; non-streaming JSON compatibility works', async () => {
    await assert.rejects(streamLlmWithTools(connection, [], [], new AbortController().signal, {request: async () => streamResponse([
        {choices: [{delta: {tool_calls: [{index: 9, id: 'bad'}]}}]}, '[DONE]'
    ])}), /索引/)
    const result = await streamLlmWithTools(connection, [], [], new AbortController().signal, {request: async () => Response.json({choices: [{message: {content: 'JSON'}}]})})
    assert.equal(result.content, 'JSON')
})
test('cancellation stops retry wait immediately', async () => {
    const controller = new AbortController()
    let calls = 0
    const run = streamLlmWithTools(connection, [], [], controller.signal, {request: async () => {calls++; return new Response('', {status: 503})},
        onRetry: () => controller.abort('user')})
    await assert.rejects(run); assert.equal(calls, 1)
})

test('idle timeout covers stalled response body; regular chunks allow a longer total duration', async () => {
    const hanging = new Response(new ReadableStream({start(controller) {controller.enqueue(new TextEncoder().encode(': heartbeat\n\n'))}}),
        {headers: {'Content-Type': 'text/event-stream'}})
    await assert.rejects(streamLlmWithTools(connection, [], [], new AbortController().signal, {idleMs: 15, request: async () => hanging}), {name: 'TimeoutError'})
    const stream = new ReadableStream({async start(controller) {
        for (let i = 0; i < 4; i++) {
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({choices: [{delta: {content: '好'}}]})}\n\n`))
            await new Promise(resolve => setTimeout(resolve, 20))
        }
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'))
        controller.close()
    }})
    const result = await streamLlmWithTools(connection, [], [], new AbortController().signal, {idleMs: 50,
        request: async () => new Response(stream, {headers: {'Content-Type': 'text/event-stream'}})})
    assert.equal(result.content, '好好好好')
})

test('non-streaming endpoint fallback is explicit and bounded', async () => {
    const bodies: any[] = []
    const response = await streamLlmWithTools(connection, [], [], new AbortController().signal, {request: async (_url, init) => {
        const body = JSON.parse(String(init?.body)); bodies.push(body)
        return body.stream ? new Response('', {status: 400}) : Response.json({choices: [{message: {content: '兼容回复'}, finish_reason: 'stop'}]})
    }})
    assert.equal(response.content, '兼容回复'); assert.equal(bodies.length, 3); assert.equal(bodies.at(-1).stream, false)
})

test('SSE permits bare CR and multiline data while rejecting incomplete tool indexes', async () => {
    const body = 'data: {"choices":\rdata: [{"delta":{"content":"CR"},"finish_reason":"stop"}]}\r\rdata: [DONE]\r\r'
    const result = await streamLlmWithTools(connection, [], [], new AbortController().signal,
        {request: async () => new Response(body, {headers: {'Content-Type': 'text/event-stream'}})})
    assert.equal(result.content, 'CR')
    await assert.rejects(streamLlmWithTools(connection, [], [], new AbortController().signal, {request: async () => streamResponse([
        {choices: [{delta: {tool_calls: [{index: 1, id: 'missing-zero', type: 'function', function: {name: 'list_todos', arguments: '{}'}}]}, finish_reason: 'tool_calls'}]}, '[DONE]'
    ])}), /缺少索引/)
})
