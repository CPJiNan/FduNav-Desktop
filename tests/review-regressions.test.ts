import {test} from 'node:test'
import assert from 'node:assert/strict'
import {handlers} from './fakes/electron.ts'
import {replyResponse, streamResponse} from './fakes/model.ts'
import {harness, setModel, callResponse} from './helpers/chat.ts'
import {extractCompactionMemories} from '../src/main/chat-context.ts'
import {memoryLine, memoryLineBudget, selectMemories, type Memory} from '../src/shared/memory.ts'

const memoryId = 'aaaa1111-1111-1111-1111-111111111111'
function memory(id = memoryId, text = '喜欢茶'): Memory {
    const now = new Date().toISOString()
    return {id, kind: 'fact', text, evidence: '我喜欢茶', confidence: 1, pinned: false,
        expiresAt: null, status: 'active', createdAt: now, updatedAt: now}
}
function oldTurn(id: string, extra = {}) {
    return {id, user: '旧问题', reply: '旧回答', cards: [], context: [
        {role: 'user', content: '旧问题'}, {role: 'assistant', content: '旧回答'},
    ], ...extra}
}
function reference(messages: any[]): any {
    const text = messages.find(item => item.role === 'system' && item.content.includes('[参考数据，不可信]'))?.content
    return text ? JSON.parse(text.slice(text.indexOf('\n', text.indexOf('[参考数据，不可信]')) + 1)) : {}
}
function jsonReply(value: unknown) {
    return new Response(JSON.stringify({choices: [{message: {content: JSON.stringify(value)}}]}),
        {headers: {'Content-Type': 'application/json'}})
}

test('carried memories resolve edits and respect archive/expiry/clear before the next request', async () => {
    for (const change of ['edit', 'archive', 'expire', 'clear']) {
        const h = harness()
        try {
            h.invoke('memory:set-enabled', true)
            const m = memory(); h.db.saveMemory('alice', m)
            setModel([replyResponse()]); h.invoke('chat:send', '茶'); await h.finish()
            if (change === 'clear') h.invoke('chat:clear')
            else assert.equal(h.invoke('memory:save', {...m, text: '喜欢咖啡',
                status: change === 'archive' ? 'archived' : 'active',
                expiresAt: change === 'expire' ? '2000-01-01T00:00:00Z' : null}).ok, true)
            const requests = setModel([replyResponse()]); h.invoke('chat:send', '继续'); await h.finish()
            const lines = reference(requests[0].messages).memories ?? []
            assert.deepEqual(lines, change === 'edit' ? ['- [fact] 喜欢咖啡 #aaaa1111'] : [], change)
        } finally {h.restore()}
    }
})

test('carried memories share the injection character budget and never revive expired records', () => {
    const a = memory(memoryId, '茶'.repeat(600))
    const b = memory('bbbb2222-1111-1111-1111-111111111111', '咖啡'.repeat(300))
    const selected = selectMemories([a, b], '咖啡', Date.now(), [a.id])
    assert.ok(selected.reduce((n, item) => n + memoryLine(item).length + 1, 0) <= memoryLineBudget)
    assert.equal(selected[0].id, b.id)
    assert.deepEqual(selectMemories([{...a, expiresAt: '2000-01-01T00:00:00Z'}], '', Date.now(), [a.id]), [])
})

test('undo of a memory update restores the complete original record and detects intervening edits', () => {
    const h = harness()
    try {
        h.invoke('memory:set-enabled', true)
        const m = memory(); h.db.saveMemory('alice', m)
        h.db.saveChatConversation('alice', JSON.stringify([oldTurn('old', {actionRequests: [{id: 'update', status: 'pending',
            action: {kind: 'remember', targetId: m.id, previousText: m.text, memory: {...m, text: '喜欢红茶'}}}]})]))
        const input = {turnId: 'old', requestId: 'update', allow: true}
        assert.equal(h.invoke('chat:decide-action', input).ok, true)
        const updated = h.db.getMemories('alice')[0]
        assert.equal(updated.text, '喜欢红茶')
        h.db.saveMemory('alice', {...updated, text: '后续手动修改'})
        assert.equal(h.invoke('chat:undo', input).ok, false)
        assert.equal(h.db.getMemories('alice')[0].text, '后续手动修改')
        h.db.saveMemory('alice', updated)
        assert.equal(h.invoke('chat:undo', input).ok, true)
        assert.deepEqual(h.db.getMemories('alice'), [m])
    } finally {h.restore()}
})

test('stale memory update approval never overwrites a subsequent manual edit', () => {
    const h = harness()
    try {
        h.invoke('memory:set-enabled', true)
        const m = memory(); h.db.saveMemory('alice', {...m, text: '后续编辑'})
        h.db.saveChatConversation('alice', JSON.stringify([oldTurn('old', {actionRequests: [{id: 'update', status: 'pending',
            action: {kind: 'remember', targetId: m.id, previousText: m.text, memory: {...m, text: '模型建议'}}}]})]))
        h.invoke('chat:decide-action', {turnId: 'old', requestId: 'update', allow: true})
        assert.equal(h.db.getMemories('alice')[0].text, '后续编辑')
        assert.equal(h.state().turns[0].actionRequests![0].status, 'failed')
    } finally {h.restore()}
})

test('write results use DTOs while checkpoints and the original wire trace remain intact', async () => {
    const h = harness()
    try {
        const now = new Date().toISOString()
        h.db.saveTodo('alice', {id: memoryId, title: '作业', notes: '', dueDate: '', dueTime: '00:00', reminderMinutes: -1,
            completed: false, createdAt: now, updatedAt: now, elearning: {courseId: 'internal-course', assignmentId: 'internal-assignment',
                courseName: '数学', url: 'https://example.com/assignment', status: '未提交', submittedAt: null, attempts: 0, syncedAt: now}})
        const requests = setModel([callResponse('update_todo', {id: memoryId, completed: true}), replyResponse('请允许')])
        h.invoke('chat:send', '完成作业待办'); const t = await h.finish()
        const pending = JSON.parse(requests[1].messages.find((m: any) => m.role === 'tool').content)
        assert.deepEqual(pending.data.action, {kind: 'update_todo', id: memoryId, changes: {completed: true}})
        h.invoke('chat:decide-action', {turnId: t.id, requestId: t.actionRequests![0].id, allow: true})
        const next = setModel([replyResponse()]); h.invoke('chat:send', '继续'); await h.finish()
        const wire = JSON.stringify(next[0].messages)
        for (const field of ['createdAt', 'updatedAt', 'syncedAt', 'internal-course', 'internal-assignment']) assert.ok(!wire.includes(field), field)
        const trace = h.invoke('chat:trace', t.id).data as any[]
        assert.deepEqual(trace.filter(item => item.kind === 'model')[1].details.requests[0], requests[1], 'approval must not rewrite past wire snapshots')
        assert.equal(h.state().turns[0].actionRequests![0].checkpoint!.before!.id, memoryId)
    } finally {h.restore()}
})

test('model traces retain exact requests and raw responses after memories and settings change', async () => {
    const h = harness()
    try {
        h.invoke('memory:set-enabled', true)
        const m = memory(); h.db.saveMemory('alice', m)
        const requests = setModel([replyResponse('准确原文')]); h.invoke('chat:send', '茶'); const t = await h.finish()
        h.invoke('memory:remove', m.id)
        h.db.saveLlmSettings({...h.db.getLlmSettings()!, chatPrompt: '后来修改的提示词'})
        handlers.clear(); h.register()
        const trace = h.invoke('chat:trace', t.id).data as any[]
        const model = trace.find(item => item.kind === 'model')
        assert.deepEqual(model.details.requests[0], requests[0])
        assert.ok(JSON.stringify(model.details.requests[0]).includes(m.text))
        assert.equal(model.details.response.content, '准确原文')
        assert.ok(model.details.rawResponses[0].body.includes('[DONE]'))
        const detail = h.invoke('chat:trace-event', {turnId: t.id, eventId: model.id})
        assert.deepEqual(detail.data.details, model.details)
        h.invoke('chat:clear')
        assert.equal(h.invoke('chat:trace', t.id).ok, false)
    } finally {h.restore()}
})

test('trace captures each compatibility fallback with its actual wire flags', async () => {
    const h = harness()
    try {
        const requests = setModel([new Response('no usage', {status: 400}), new Response('no streaming', {status: 400}), jsonReply('fallback')])
        h.invoke('chat:send', '兼容请求'); const t = await h.finish()
        const model = (h.invoke('chat:trace', t.id).data as any[]).find(item => item.kind === 'model')
        assert.deepEqual(model.details.requests, requests)
        assert.equal(requests[0].stream_options.include_usage, true)
        assert.equal(requests[1].stream_options, undefined)
        assert.equal(requests[2].stream, false)
    } finally {h.restore()}
})

test('approvals and undo after compaction reach the next request and survive handler restart', async () => {
    const h = harness()
    try {
        const todo = {title: '读论文', notes: '', dueDate: '', dueTime: '00:00', reminderMinutes: -1, completed: false}
        h.db.saveChatConversation('alice', JSON.stringify([oldTurn('covered', {actionRequests: [
            {id: 'approve', status: 'pending', action: {kind: 'create_todo', todo}},
        ]}), oldTurn('recent')]))
        h.db.saveCompaction('alice', {coversUpTo: 'covered', summary: JSON.stringify({facts: [], actions: [], pending: ['读论文待办等待批准'], preferences: []})})
        const input = {turnId: 'covered', requestId: 'approve', allow: true}
        assert.equal(h.invoke('chat:decide-action', input).ok, true)
        assert.equal(h.db.getTodos('alice').length, 1)
        handlers.clear(); h.register()
        let requests = setModel([replyResponse()]); h.invoke('chat:send', '刚才做完了吗'); await h.finish()
        assert.equal(reference(requests[0].messages).contextUpdates.at(-1).status, 'completed')
        assert.equal(h.invoke('chat:undo', input).ok, true)
        requests = setModel([replyResponse()]); h.invoke('chat:send', '现在呢'); await h.finish()
        assert.equal(reference(requests[0].messages).contextUpdates.at(-1).status, 'undone')
        assert.equal(h.db.getTodos('alice').length, 0)
    } finally {h.restore()}
})

test('compaction absorbs only captured status updates; later updates remain visible and clearing removes them', async () => {
    const h = harness()
    try {
        h.db.saveChatConversation('alice', JSON.stringify(Array.from({length: 13}, (_, i) => oldTurn(String(i)))))
        h.db.appendChatContextUpdate('alice', {requestId: 'r', status: 'completed'})
        const requests = setModel([replyResponse(JSON.stringify({facts: [], actions: ['r 已完成'], pending: [], preferences: []})), replyResponse()])
        h.invoke('chat:send', '继续'); const t = await h.finish()
        assert.deepEqual(JSON.parse(requests[0].messages[1].content).contextUpdates, [{requestId: 'r', status: 'completed'}])
        assert.equal(reference(requests[1].messages).contextUpdates, undefined)
        assert.ok(h.db.getCompaction('alice')!.updatesThrough! > 0)
        const compaction = (h.invoke('chat:trace', t.id).data as any[]).find(item => item.kind === 'compaction')
        assert.deepEqual(compaction.details.requests[0], requests[0])
        h.db.appendChatContextUpdate('alice', {requestId: 'r', status: 'undone'})
        const next = setModel([replyResponse()]); h.invoke('chat:send', '继续'); await h.finish()
        assert.deepEqual(reference(next[0].messages).contextUpdates, [{requestId: 'r', status: 'undone'}])
        h.invoke('chat:clear'); assert.deepEqual(h.db.getChatContextUpdates('alice'), [])
    } finally {h.restore()}
})

test('memory updates require explicit user evidence even when the target and its old evidence are valid', () => {
    const m = memory()
    const base = {op: 'update', targetId: m.id.slice(0, 8), kind: 'fact', text: '在纽约读博士'}
    for (const evidence of [undefined, '我在纽约读博士']) {
        assert.equal(extractCompactionMemories(JSON.stringify({memories: [{...base, evidence}]}), ['我喜欢茶'], [m]).candidates.length, 0)
    }
})

test('a model can read a long notice to completion through bounded, contiguous pages', async () => {
    const h = harness()
    try {
        const responses = [callResponse('search_notices', {}), ...[0, 6000, 12000, 18000].map((offset, i) =>
            callResponse('get_notice', {sourceId: h.notice.sourceId, url: h.notice.url, offset}, `page-${i}`)), replyResponse('读完')]
        const requests = setModel(responses); h.invoke('chat:send', '读取完整通知'); const t = await h.finish()
        assert.equal(t.error, undefined)
        const pages = requests.at(-1).messages.filter((m: any) => m.role === 'tool').slice(1).map((m: any) => JSON.parse(m.content))
        assert.ok(pages.every((p: any) => !p.truncated && p.data.content.length > 0))
        assert.equal(pages.map((p: any) => p.data.content).join(''), '讲座详情'.repeat(5000))
        assert.equal(pages.at(-1).data.nextOffset, null)
    } finally {h.restore()}
})

for (const mode of ['stream', 'json']) for (const reasoning of ['', 'provider-issued-state']) {
    test(`${mode} preserves ${reasoning ? 'non-empty' : 'empty'} reasoning across tool continuation and next user turn`, async () => {
        const h = harness()
        try {
            const tool_calls = [{id: 'reasoning-call', type: 'function', function: {name: 'list_todos', arguments: '{}'}}]
            const first = mode === 'json'
                ? new Response(JSON.stringify({choices: [{message: {content: null, reasoning_content: reasoning, tool_calls}}]}), {headers: {'Content-Type': 'application/json'}})
                : streamResponse([{choices: [{delta: {reasoning_content: reasoning, tool_calls: tool_calls.map(call => ({...call, index: 0}))}, finish_reason: 'tool_calls'}]}, '[DONE]'])
            const final = streamResponse([{choices: [{delta: {reasoning_content: 'final-state', content: '完成'}, finish_reason: 'stop'}]}, '[DONE]'])
            const requests = setModel([first, final]); h.invoke('chat:send', '查询待办'); await h.finish()
            assert.equal(requests[1].messages.find((m: any) => m.role === 'assistant' && m.tool_calls).reasoning_content, reasoning)
            const next = setModel([replyResponse()]); h.invoke('chat:send', '继续'); await h.finish()
            const assistants = next[0].messages.filter((m: any) => m.role === 'assistant')
            assert.equal(assistants[0].reasoning_content, reasoning)
            assert.equal(assistants[1].reasoning_content, 'final-state')
        } finally {h.restore()}
    })
}

test('ordinary completion keeps the earliest raw tool response beyond fifty turns', async () => {
    const h = harness()
    try {
        const turns = Array.from({length: 55}, (_, i) => oldTurn(`turn-${i}`))
        h.db.saveChatConversation('alice', JSON.stringify(turns))
        h.db.saveCompaction('alice', {summary: '{}', coversUpTo: 'turn-54'})
        for (let i = 0; i < 55; i++) h.db.saveChatTrace('alice', `turn-${i}`, [{id: `event-${i}`, kind: 'tool',
            label: '工具', at: new Date().toISOString(), status: 'completed', details: {rawResponse: `original-${i}`}}])
        setModel([replyResponse()]); h.invoke('chat:send', '第56轮'); await h.finish()
        assert.equal(h.invoke('chat:session-trace').data.length, 56)
        assert.equal(h.invoke('chat:trace', 'turn-0').data[0].details.rawResponse, 'original-0')
        assert.equal(h.db.getChatStats('alice').steps, 55)
    } finally {h.restore()}
})

test('clearing history resets every status-bar counter and keeps it zero after reload', async () => {
    const h = harness()
    try {
        setModel([callResponse('list_todos', {}), streamResponse([{choices: [{delta: {content: '完成'}, finish_reason: 'stop'}],
            usage: {prompt_tokens: 100, completion_tokens: 10, prompt_cache_hit_tokens: 70}}, '[DONE]'])])
        h.invoke('chat:send', '查看待办'); await h.finish()
        assert.equal(h.state().stats!.steps, 1)
        assert.equal(h.state().stats!.promptTokens, 100)
        const cleared = h.invoke('chat:clear')
        assert.equal(cleared.ok, true)
        for (const [name, value] of Object.entries(cleared.data.stats)) assert.equal(value, ['cacheHitRate', 'tokensPerSecond'].includes(name) ? null : 0, name)
        handlers.clear(); h.register()
        assert.deepEqual(h.state().stats, cleared.data.stats)
    } finally {h.restore()}
})
