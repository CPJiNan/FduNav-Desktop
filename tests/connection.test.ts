import {test} from 'node:test'
import assert from 'node:assert/strict'
import {completeLlm} from '../src/main/llm-connection.ts'
const connection = {baseUrl: 'https://example.com/v1', model: 'test', apiKey: ''}

test('non-streaming calls retry transient service errors and preserve valid output', async () => {
    let calls = 0
    const result = await completeLlm(connection, [], new AbortController().signal, async () => ++calls === 1
        ? new Response('', {status: 503}) : Response.json({choices: [{message: {content: '有效摘要'}}]}))
    assert.equal(calls, 2); assert.equal(result, '有效摘要')
})
test('non-streaming calls do not retry authentication or malformed JSON', async () => {
    let calls = 0
    await assert.rejects(completeLlm(connection, [], new AbortController().signal, async () => {calls++; return new Response('', {status: 401})}), /401/)
    assert.equal(calls, 1); calls = 0
    await assert.rejects(completeLlm(connection, [], new AbortController().signal, async () => {calls++; return new Response('{invalid')}), /JSON/)
    assert.equal(calls, 1)
})
