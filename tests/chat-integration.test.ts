import {test} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {handlers} from './fakes/electron.ts'
import {streamResponse, replyResponse} from './fakes/model.ts'
import {registerChatHandlers} from '../src/main/chat.ts'
import {AppDatabase} from '../src/main/database.ts'
import {TodoService} from '../src/main/todo-service.ts'
import {emptyLlmSettings} from '../src/shared/llm.ts'
import {LlmSettingsService} from '../src/main/llm-settings.ts'
import type {ChatState, ChatTurn} from '../src/shared/chat.ts'
import type {ChatTraceEvent} from '../src/shared/agent.ts'
import {memoryShortId} from '../src/shared/memory.ts'

function callResponse(name: string, args: unknown, id = 'call-1') {
    return streamResponse([{choices: [{delta: {tool_calls: [{index: 0, id, type: 'function', function: {name, arguments: JSON.stringify(args)}}]}, finish_reason: 'tool_calls'}]}, '[DONE]'])
}
function harness() {
    handlers.clear()
    const db = new AppDatabase(':memory:')
    let user = 'alice'
    db.saveAccount({username: user, cookies: new Uint8Array(), target: '', last_login: 'now'})
    db.saveLlmSettings({...emptyLlmSettings(), baseUrl: 'https://example.com/v1', model: 'test-model', encryptedApiKey: null})
    db.setLlmEnabled(true)
    const accounts = {getState: () => ({status: 'signed-in', username: user})}
    const llm = new LlmSettingsService(db, {available: async () => true, encrypt: async () => new Uint8Array(), decrypt: async () => ''})
    const service = new TodoService(db)
    const calendar = {save: (_user: string, input: any) => {const value = {...input, id: randomUUID()}; db.saveCalendarEvent(_user, value); return value},
        remove: (_user: string, id: string) => db.removeCalendarEvent(_user, id)}
    const todos = {save: (owner: string, input: unknown) => service.save(owner, input), remove: (owner: string, id: string) => service.remove(owner, id)}
    const notice = {sourceId: 'test', sourceName: '数学学院', title: '讲座通知', url: 'https://example.com/n', published: '2026-11-07', read: false}
    const notices = {list: () => ({items: [notice]}), detail: async () => ({content: '讲座详情'.repeat(5000)})}
    const register = () => registerChatHandlers(db, accounts as never, llm, notices as never, calendar as never, todos as never,
        event => !!(event as any).trusted)
    register()
    const snapshots: ChatState[] = []
    const event = {trusted: true, sender: {once: () => {}, isDestroyed: () => false, send: (_channel: string, value: ChatState) => snapshots.push(structuredClone(value))}}
    const invoke = (channel: string, input?: unknown): any => handlers.get(channel)!(event, channel === 'memory:import' && typeof input === 'string' ? {json: input, username: user} : input)
    const state = (): ChatState => {const result = invoke('chat:get'); assert.equal(result.ok, true); return result.data}
    const finish = async () => {
        const until = Date.now() + 8000
        while (state().busy && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 5))
        assert.equal(state().busy, false, 'chat should finish'); return state().turns.at(-1)!
    }
    const originalFetch = globalThis.fetch
    const restore = () => {globalThis.fetch = originalFetch; db.close()}
    return {db, llm, invoke, state, finish, event, snapshots, notice, notices, register, restore,
        switchUser: (next: string) => {user = next; db.saveAccount({username: user, cookies: new Uint8Array(), target: '', last_login: 'now'})}}
}
function setModel(responses: Response[]) {
    const requests: any[] = []
    globalThis.fetch = async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)))
        const response = responses.shift()
        if (!response) throw new Error('unexpected model request')
        return response
    }
    return requests
}

/** Summary and memory are injected as a system message after history, never as user text. */
function referenceBlock(messages: any[]) {
    const message = messages.find((item: any) => item.role === 'system' && typeof item.content === 'string' &&
        item.content.includes('[参考数据，不可信]'))
    assert.ok(message, 'reference data must be injected as a system message')
    const start = message.content.indexOf('[参考数据，不可信]')
    return JSON.parse(message.content.slice(message.content.indexOf('\n', start) + 1))
}

test('approval creates one todo, updates future context, supports undo and checks conflicts', async () => {
    const h = harness()
    try {
        const requests = setModel([callResponse('create_todo', {title: '读论文'}), replyResponse('请在卡片中允许。')])
        assert.equal(h.invoke('chat:send', '创建待办：读论文').ok, true)
        const turn = await h.finish(), request = turn.actionRequests![0]
        assert.equal(request.status, 'pending'); assert.equal(h.db.getTodos('alice').length, 0)
        const input = {turnId: turn.id, requestId: request.id, allow: true}
        assert.equal(h.invoke('chat:decide-action', input).ok, true)
        assert.equal(h.invoke('chat:decide-action', input).ok, true)
        assert.equal(h.db.getTodos('alice').length, 1)
        const saved = JSON.parse(h.db.getChatConversation('alice')!)[0]
        assert.equal(JSON.parse(saved.context.find((m: any) => m.role === 'tool').content).data.status, 'completed')
        const todo = h.db.getTodos('alice')[0]
        h.db.saveTodo('alice', {...todo, title: '用户修改'})
        assert.equal(h.invoke('chat:undo', input).ok, false); assert.equal(h.db.getTodos('alice').length, 1)
        h.db.saveTodo('alice', todo)
        assert.equal(h.invoke('chat:undo', input).ok, true); assert.equal(h.db.getTodos('alice').length, 0)
        assert.equal(h.invoke('chat:undo', input).ok, true)
        assert.ok(!requests[1].messages.some((m: any) => m.content?.includes('回复中断')))
        const trace = h.invoke('chat:trace', turn.id).data as ChatTraceEvent[]
        assert.ok(trace.some(item => item.kind === 'undo')); assert.ok(trace.some(item => item.kind === 'usage'))
        assert.ok(h.state().turns[0].trace?.every(item => item.details === undefined))
    } finally {h.restore()}
})
test('write and approval status roll back together if conversation persistence fails', async () => {
    const h = harness()
    try {
        setModel([callResponse('create_todo', {title: '原子写入'}), replyResponse('待批准。')]); h.invoke('chat:send', '创建待办：原子写入')
        const turn = await h.finish(), request = turn.actionRequests![0]
        const save = h.db.saveChatConversation.bind(h.db)
        let fail = true
        h.db.saveChatConversation = (user, data) => {if (fail) {fail = false; throw new Error('simulated disk failure')} save(user, data)}
        const result = h.invoke('chat:decide-action', {turnId: turn.id, requestId: request.id, allow: true})
        assert.equal(result.ok, true); assert.equal(h.db.getTodos('alice').length, 0)
        assert.equal(h.state().turns[0].actionRequests![0].status, 'failed')
    } finally {h.restore()}
})
test('trace preserves full original tool result and distinct truncated model response; clear removes trace', async () => {
    const h = harness()
    try {
        setModel([callResponse('search_notices', {}), callResponse('get_notice', {sourceId: h.notice.sourceId, url: h.notice.url}), replyResponse()])
        h.invoke('chat:send', '读取讲座通知'); const turn = await h.finish()
        const events = h.invoke('chat:trace', turn.id).data as ChatTraceEvent[]
        const tool = events.filter(item => item.kind === 'tool').at(-1)!.details as any
        assert.equal(tool.rawResponse.content.length, 20000); assert.equal(tool.modelResponse.truncated, true)
        h.switchUser('bob'); assert.equal(h.invoke('chat:trace', turn.id).ok, false); assert.equal(h.state().turns.length, 0)
        h.switchUser('alice'); assert.equal(h.invoke('chat:clear').ok, true); assert.equal(h.invoke('chat:trace', turn.id).ok, false)
    } finally {h.restore()}
})
test('budget exhaustion runs final summary without tools and never executes beyond 24 calls', async () => {
    const h = harness()
    try {
        const batch = (round: number) => streamResponse([{choices: [{delta: {tool_calls: Array.from({length: 8}, (_, i) => ({index: i,
            id: `${round}-${i}`, type: 'function', function: {name: 'list_todos', arguments: '{}'}}))}, finish_reason: 'tool_calls'}]}, '[DONE]'])
        const requests = setModel([batch(0), batch(1), batch(2), replyResponse('已用完工具预算，以上是已查到的信息。')])
        h.invoke('chat:send', '查询待办'); const turn = await h.finish()
        assert.equal(turn.error, undefined)
        assert.equal(turn.trace?.filter(item => item.kind === 'tool').length, 24)
        assert.equal(requests.at(-1).tools, undefined)
        const lastTool = requests.at(-1).messages.filter((m: any) => m.role === 'tool').at(-1)
        assert.equal(JSON.parse(lastTool.content).remaining.calls, 0)
    } finally {h.restore()}
})
test('memory approval requires exact user evidence; injection is opt-in and forget supports undo', async () => {
    const h = harness()
    try {
        const memory = {kind: 'preference', text: '用户偏好数学', evidence: '我喜欢数学', confidence: 1, pinned: true, expiresAt: ''}
        h.invoke('memory:set-enabled', true)
        setModel([callResponse('remember', memory), replyResponse('请允许保存。')]); h.invoke('chat:send', '请记住：我喜欢数学')
        let turn = await h.finish(); let request = turn.actionRequests![0]
        assert.equal(h.db.getMemories('alice').length, 0)
        h.invoke('chat:decide-action', {turnId: turn.id, requestId: request.id, allow: true})
        assert.equal(h.db.getMemories('alice').length, 1)
        const id = h.db.getMemories('alice')[0].id
        const requests = setModel([callResponse('forget', {id}), replyResponse('请允许删除。')]); h.invoke('chat:send', '忘记偏好')
        turn = await h.finish(); request = turn.actionRequests![0]
        assert.ok(JSON.stringify(requests[0].messages).includes('用户偏好数学'))
        h.invoke('chat:decide-action', {turnId: turn.id, requestId: request.id, allow: true}); assert.equal(h.db.getMemories('alice').length, 0)
        h.invoke('chat:undo', {turnId: turn.id, requestId: request.id}); assert.equal(h.db.getMemories('alice').length, 1)
        h.invoke('memory:set-enabled', false)
        const disabled = setModel([replyResponse()]); h.invoke('chat:send', '新的提问'); await h.finish()
        // Older conversation may already contain the memory; the separate injected memory block is absent.
        assert.ok(!disabled[0].messages.some((m: any) => m.content?.includes('[参考数据，不可信]') && m.content.includes('"memories":[{')))
    } finally {h.restore()}
})
test('invalid imports are atomic; valid imports dedupe, remap IDs and stay account-local', () => {
    const h = harness()
    try {
        const item = {kind: 'fact', text: '数学专业', confidence: 1, evidence: '用户说明', pinned: false, expiresAt: null, status: 'active'}
        assert.equal(h.invoke('memory:import', JSON.stringify({version: 1, memories: [item, {text: 'bad'}]})).ok, false)
        assert.equal(h.db.getMemories('alice').length, 0)
        const json = JSON.stringify({version: 1, memories: [{...item, id: 'foreign-id'}, item]})
        assert.equal(h.invoke('memory:import', json).ok, true); h.invoke('memory:import', json)
        assert.equal(h.db.getMemories('alice').length, 1); assert.notEqual(h.db.getMemories('alice')[0].id, 'foreign-id')
        h.switchUser('bob'); assert.equal(h.invoke('memory:get').data.items.length, 0)
        assert.equal(h.invoke('memory:import', {json, username: 'alice'}).ok, false)
        assert.equal((handlers.get('chat:get')!({trusted: false}) as {ok: boolean}).ok, false)
    } finally {h.restore()}
})
test('compaction retries twice, then keeps the last four turns and defers the next attempt', async () => {
    const h = harness()
    try {
        const turns = Array.from({length: 13}, (_, i) => ({id: String(i), user: 'u', reply: 'a', cards: [], context: [{role: 'user', content: 'u'}, {role: 'assistant', content: 'a'}]}))
        h.db.saveChatConversation('alice', JSON.stringify(turns))
        const requests = setModel([replyResponse('invalid summary'), replyResponse('invalid summary'),
            replyResponse('invalid summary'), replyResponse('继续回答')])
        h.invoke('chat:send', '继续')
        const turn = await h.finish()
        assert.equal(turn.error, undefined)
        assert.ok(turn.trace?.some(item => item.kind === 'compaction' && item.status === 'failed'))
        assert.equal(turn.trace?.filter(item => item.kind === 'retry').length, 2)
        assert.equal(requests.length, 4)
        // Dropped turns are covered so they are not billed again; the kept window is four turns.
        assert.equal(h.db.getCompaction('alice')?.coversUpTo, '8')
        assert.equal(requests[3].messages.filter((message: any) => message.content === 'a').length, 4)
        // Second failure keeps the same small window until it grows back to the threshold.
        const next = setModel([replyResponse('好的')])
        h.invoke('chat:send', '再问一句')
        await h.finish()
        assert.equal(next.length, 1, 'no compaction until the window grows back')
    } finally {h.restore()}
})
test('compaction logs retries and still succeeds on the third attempt', async () => {
    const h = harness()
    try {
        const turns = Array.from({length: 13}, (_, i) => ({id: String(i), user: 'u', reply: 'a', cards: [], context: [{role: 'user', content: 'u'}, {role: 'assistant', content: 'a'}]}))
        h.db.saveChatConversation('alice', JSON.stringify(turns))
        const summary = JSON.stringify({facts: [], actions: [], pending: [], preferences: []})
        const requests = setModel([replyResponse('invalid'), replyResponse('invalid'), replyResponse(summary), replyResponse('回答')])
        h.invoke('chat:send', '继续')
        const turn = await h.finish()
        assert.equal(requests.length, 4)
        assert.ok(turn.trace?.some(item => item.kind === 'compaction' && item.status === 'completed'))
        assert.equal(turn.trace?.filter(item => item.kind === 'retry').length, 2)
        assert.equal(h.db.getCompaction('alice')?.coversUpTo, '8')
    } finally {h.restore()}
})
test('approving an action keeps the compaction boundary', async () => {
    const h = harness()
    try {
        h.db.saveCompaction('alice', {summary: '{"facts":[],"actions":[],"pending":[],"preferences":[]}', coversUpTo: 'turn-1'})
        const turn = {
            id: 'turn-2', user: 'u', reply: '', cards: [], context: [],
            actionRequests: [{id: 'req-1', status: 'pending', action: {kind: 'create_todo', todo: {
                title: '买书', notes: '', dueDate: '', dueTime: '00:00', reminderMinutes: -1, completed: false}}}]
        }
        h.db.saveChatConversation('alice', JSON.stringify([turn]))
        const result = h.invoke('chat:decide-action', {turnId: 'turn-2', requestId: 'req-1', allow: false})
        assert.equal(result.ok, true)
        assert.equal(h.db.getCompaction('alice')?.coversUpTo, 'turn-1', 'approval must not reset compaction')
    } finally {h.restore()}
})
test('successful compaction injects a structured summary instead of escaped JSON text', async () => {
    const h = harness()
    try {
        const turns = Array.from({length: 13}, (_, i) => ({id: String(i), user: 'u', reply: 'a', cards: [], context: [{role: 'user', content: 'u'}, {role: 'assistant', content: 'a'}]}))
        h.db.saveChatConversation('alice', JSON.stringify(turns))
        const summary = JSON.stringify({facts: ['用户是本科生'], actions: [], pending: [], preferences: []})
        const requests = setModel([replyResponse(summary), replyResponse('继续回答')])
        h.invoke('chat:send', '继续')
        await h.finish()
        // Storage stays JSON text so existing rows remain readable.
        assert.equal(typeof h.db.getCompaction('alice')?.summary, 'string')
        const payload = referenceBlock(requests[1].messages)
        assert.equal(typeof payload.historySummary, 'object', 'summary must not be double-encoded')
        assert.deepEqual(payload.historySummary.facts, ['用户是本科生'])
    } finally {h.restore()}
})
test('compaction request takes the eight oldest turns and the next request carries summary plus newest four', async () => {
    const h = harness()
    try {
        const turns = Array.from({length: 13}, (_, i) => ({id: String(i), user: `问题${i}`, reply: `回答${i}`, cards: [],
            context: [{role: 'user', content: `问题${i}`}, {role: 'assistant', content: `回答${i}`}]}))
        h.db.saveChatConversation('alice', JSON.stringify(turns))
        const summary = JSON.stringify({facts: ['用户依次问过问题0到问题8'], actions: [], pending: [], preferences: []})
        const requests = setModel([replyResponse(summary), replyResponse('新一轮回答')])
        h.invoke('chat:send', '最新问题')
        await h.finish()

        // Compaction input: the turns older than the kept window (0..8).
        const compacted = JSON.parse(requests[0].messages[1].content).turns
        assert.deepEqual(compacted.map((turn: any) => turn.id), ['0', '1', '2', '3', '4', '5', '6', '7', '8'])

        // Outgoing request: system, newest four turns verbatim, reference system block, current user.
        const sent = requests[1].messages
        assert.equal(sent.length, 1 + 8 + 1 + 1)
        const referenceIndex = sent.findIndex((message: any) => message.role === 'system' &&
            typeof message.content === 'string' && message.content.includes('[参考数据，不可信]'))
        assert.equal(referenceIndex, 9, 'reference data goes after history and before the current user')
        const block = referenceBlock(sent)
        assert.deepEqual(block.historySummary.facts, ['用户依次问过问题0到问题8'])
        assert.equal(block.historySummary.actions.length, 0)
        assert.deepEqual(sent.slice(1, 9).filter((message: any) => message.role === 'user').map((message: any) => message.content),
            ['问题9', '问题10', '问题11', '问题12'])
        assert.ok(!sent.some((message: any, index: number) => index > 0 && message.role === 'user' &&
            sent[index - 1].role === 'user'), 'no adjacent user/user turns')
        assert.equal(sent.at(-1).content, '最新问题')
        assert.equal(sent.at(-1).role, 'user')
    } finally {h.restore()}
})
test('cancel aborts in-flight request; errors never become assistant context; account/settings changes stop work', async () => {
    const h = harness()
    try {
        const pending = () => {
            globalThis.fetch = async (_url, init) => new Promise((_resolve, reject) => {
                if (init!.signal!.aborted) reject(init!.signal!.reason)
                else init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), {once: true})
            })
        }
        pending(); h.invoke('chat:send', '等待'); await new Promise(resolve => setTimeout(resolve, 10)); h.invoke('chat:cancel')
        let turn = await h.finish(); assert.equal(turn.cancelReason, 'user')
        const saved = JSON.parse(h.db.getChatConversation('alice')!)[0]
        assert.ok(!saved.context.some((item: any) => item.role === 'assistant' && item.content === turn.error))
        pending(); h.invoke('chat:send', '再次等待'); await new Promise(resolve => setTimeout(resolve, 10)); h.llm.setEnabled(false)
        turn = await h.finish(); assert.equal(turn.cancelReason, 'settings_changed')
        h.llm.setEnabled(true); pending(); h.invoke('chat:send', '账号变化'); await new Promise(resolve => setTimeout(resolve, 10)); h.switchUser('bob')
        await new Promise(resolve => setTimeout(resolve, 300)); h.switchUser('alice')
        turn = await h.finish(); assert.equal(turn.cancelReason, 'account_changed')
    } finally {h.restore()}
})

test('explicit calendar request creates an event card approval and undo; missing times never create a request', async () => {
    const h = harness()
    try {
        const input = {title: '组会', startDate: '2026-11-10', endDate: '2026-11-10', allDay: false, startTime: '14:00', endTime: '15:00'}
        setModel([callResponse('create_event', input), replyResponse('请在卡片中允许创建组会日程。')]); h.invoke('chat:send', '11月10日14点到15点安排组会')
        let turn = await h.finish(); const request = turn.actionRequests![0]
        assert.equal(request.action.kind, 'create_event'); assert.equal(h.db.getCalendarEvents('alice').length, 0)
        h.invoke('chat:decide-action', {turnId: turn.id, requestId: request.id, allow: true})
        assert.equal(h.db.getCalendarEvents('alice').length, 1)
        h.invoke('chat:undo', {turnId: turn.id, requestId: request.id})
        assert.equal(h.db.getCalendarEvents('alice').length, 0)
        setModel([callResponse('create_event', {...input, startTime: undefined}), replyResponse('请告诉我开始时间。')]); h.invoke('chat:send', '安排组会')
        turn = await h.finish(); assert.equal(turn.actionRequests?.length ?? 0, 0)
        const events = h.invoke('chat:trace', turn.id).data as ChatTraceEvent[]
        assert.equal((events.find(item => item.kind === 'tool')!.details as any).modelResponse.code, 'invalid_args')
    } finally {h.restore()}
})
test('invented memory evidence is rejected even when model requests remember', async () => {
    const h = harness()
    try {
        h.invoke('memory:set-enabled', true)
        setModel([callResponse('remember', {kind: 'preference', text: '用户喜欢篮球', evidence: '我喜欢篮球', confidence: 1, pinned: false, expiresAt: ''}), replyResponse('需要你先确认。')])
        h.invoke('chat:send', '我喜欢数学'); const turn = await h.finish()
        assert.equal(turn.actionRequests?.length ?? 0, 0); assert.equal(h.db.getMemories('alice').length, 0)
    } finally {h.restore()}
})
test('successful compaction reuses the same model response for evidence-backed memory suggestions', async () => {
    const h = harness()
    try {
        h.invoke('memory:set-enabled', true)
        const turns = Array.from({length: 13}, (_, i) => ({id: String(i), user: i === 0 ? '我喜欢数学' : 'u', reply: 'a', cards: [],
            context: [{role: 'user', content: i === 0 ? '我喜欢数学' : 'u'}, {role: 'assistant', content: 'a'}]}))
        h.db.saveChatConversation('alice', JSON.stringify(turns))
        const summary = {facts: [], actions: [], pending: [], preferences: ['喜欢数学'], memories: [{kind: 'preference', text: '用户喜欢数学', evidence: '我喜欢数学', confidence: 1, expiresAt: null}]}
        const requests = setModel([replyResponse(JSON.stringify(summary)), replyResponse('继续')]); h.invoke('chat:send', '继续')
        const turn = await h.finish()
        assert.equal(turn.error, undefined); assert.equal(requests.length, 2)
        assert.equal(turn.actionRequests?.[0].action.kind, 'remember'); assert.equal(turn.actionRequests?.[0].status, 'pending')
        assert.equal(h.db.getMemories('alice').length, 0)
        assert.equal(h.db.getCompaction('alice')?.coversUpTo, '8')
    } finally {h.restore()}
})

test('cancelling a read-only adapter without signal support stops awaiting and prevents late cards', async () => {
    const h = harness()
    try {
        let release: ((value: {content: string}) => void) | undefined
        h.notices.detail = () => new Promise(resolve => {release = resolve})
        setModel([callResponse('search_notices', {}), callResponse('get_notice', {sourceId: h.notice.sourceId, url: h.notice.url})])
        h.invoke('chat:send', '读取通知')
        const until = Date.now() + 1000
        while (!release && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 5))
        assert.ok(release); h.invoke('chat:cancel'); const turn = await h.finish()
        assert.equal(turn.cancelReason, 'user')
        const cards = turn.cards.length
        release!({content: 'late response'})
        await new Promise(resolve => setTimeout(resolve, 5))
        assert.equal(h.state().turns.at(-1)!.cards.length, cards)
    } finally {h.restore()}
})

test('every IPC channel is registered once; duplicate registration fails loudly', () => {
    const h = harness()
    try {
        assert.ok(handlers.has('chat:session-trace'))
        assert.ok(handlers.has('chat:send'))
        assert.throws(() => h.register(), /second handler/, 'the fake must mirror Electron instead of overwriting')
    } finally {h.restore()}
})

test('the system prompt carries a date, so the prompt prefix stays stable between turns', async () => {
    const h = harness()
    try {
        const requests = setModel([replyResponse('第一次'), replyResponse('第二次')])
        h.invoke('chat:send', '第一问'); await h.finish()
        h.invoke('chat:send', '第二问'); await h.finish()
        const system = (index: number) => String(requests[index].messages[0].content)
        assert.equal(system(0), system(1), 'system prompt must not change between turns')
        const start = system(1).indexOf('{'), end = system(1).lastIndexOf('}')
        const meta = JSON.parse(system(1).slice(start, end + 1))
        assert.match(meta.today, /^\d{4}-\d{2}-\d{2}$/)
        assert.equal('currentTime' in meta, false)
        assert.match(system(1), /不可信数据/, 'the trust statement must not depend on an edited chat prompt')
    } finally {h.restore()}
})

test('memories are injected as compact system lines with short ids, not persisted records', async () => {
    const h = harness()
    try {
        h.invoke('memory:set-enabled', true)
        setModel([callResponse('remember', {kind: 'preference', text: '用户偏好数学', evidence: '我喜欢数学'}), replyResponse('请允许保存。')])
        h.invoke('chat:send', '请记住：我喜欢数学')
        const turn = await h.finish()
        h.invoke('chat:decide-action', {turnId: turn.id, requestId: turn.actionRequests![0].id, allow: true})
        const stored = h.db.getMemories('alice')[0]
        const requests = setModel([replyResponse('收到')])
        h.invoke('chat:send', '数学相关的问题'); await h.finish()
        const block = referenceBlock(requests[0].messages)
        assert.deepEqual(block.memories, [`- [preference] 用户偏好数学 #${stored.id.slice(0, 8)}`])
        const injected = JSON.stringify(block)
        assert.equal(injected.includes(stored.id), false, 'the full UUID must not be injected')
        assert.equal(injected.includes('createdAt') || injected.includes('"evidence"'), false)
    } finally {h.restore()}
})

test('a wrap-up round that still requests tools keeps the summary instead of failing the turn', async () => {
    const h = harness()
    try {
        const responses = Array.from({length: 8}, (_, round) => callResponse('list_todos', {}, `c-${round}`))
        responses.push(streamResponse([{choices: [{delta: {content: '已查到八条待办，预算用尽。'}}]},
            {choices: [{delta: {tool_calls: [{index: 0, id: 'ignored', type: 'function',
                function: {name: 'list_todos', arguments: '{}'}}]}, finish_reason: 'tool_calls'}]}, '[DONE]']))
        const requests = setModel(responses)
        h.invoke('chat:send', '一直查待办')
        const turn = await h.finish()
        assert.equal(turn.error, undefined)
        assert.equal(turn.truncated, true)
        assert.match(turn.reply, /预算用尽/)
        assert.equal(turn.trace?.filter(item => item.kind === 'tool').length, 8, 'ignored calls must not execute')
        const trace = h.invoke('chat:trace', turn.id).data as ChatTraceEvent[]
        assert.ok(trace.some(item => item.kind === 'error' && (item.details as any)?.truncated === true))
        assert.equal(requests.length, 9)
    } finally {h.restore()}
})

test('failed compaction with fewer than four turns records coverage and keeps working', async () => {
    const h = harness()
    try {
        const turns = [{id: 'big', user: '长上下文', reply: 'ok', cards: [],
            context: [{role: 'user', content: 'x'.repeat(61000)}, {role: 'assistant', content: 'ok'}]}]
        h.db.saveChatConversation('alice', JSON.stringify(turns))
        const requests = setModel([replyResponse('invalid'), replyResponse('invalid'), replyResponse('invalid'), replyResponse('继续回答')])
        h.invoke('chat:send', '继续')
        const turn = await h.finish()
        assert.equal(turn.error, undefined)
        assert.ok(turn.trace?.some(item => item.kind === 'compaction' && item.status === 'failed'))
        assert.equal(h.db.getCompaction('alice')?.coversUpTo, 'big', 'the failed range is covered, not left undefined')
        assert.equal(requests.length, 4)
    } finally {h.restore()}
})

test('the context budget follows provider-reported prompt tokens, not character counts', async () => {
    const h = harness()
    try {
        const withUsage = streamResponse([
            {choices: [{delta: {tool_calls: [{index: 0, id: 'c-1', type: 'function',
                function: {name: 'list_todos', arguments: '{}'}}]}, finish_reason: 'tool_calls'}]},
            {choices: [], usage: {prompt_tokens: 150000, completion_tokens: 5}},
            '[DONE]'])
        const requests = setModel([withUsage, replyResponse('上下文预算已用尽，以上是已查到的信息。')])
        h.invoke('chat:send', '查询待办')
        const turn = await h.finish()
        assert.equal(turn.error, undefined)
        assert.equal(requests[1].tools, undefined, 'a large reported prompt must trigger the wrap-up round')
        assert.ok(requests[1].messages.some((message: any) => typeof message.content === 'string' &&
            message.content.includes('预算已耗尽')))
    } finally {h.restore()}
})

test('large histories are compacted in bounded chunks with a chained summary', async () => {
    const h = harness()
    try {
        const turns = Array.from({length: 13}, (_, i) => ({id: String(i), user: `问题${i}`, reply: 'a', cards: [],
            context: [{role: 'user', content: `问题${i} ` + 'x'.repeat(10000)}, {role: 'assistant', content: 'a'}]}))
        h.db.saveChatConversation('alice', JSON.stringify(turns))
        const summary = (label: string) => JSON.stringify({facts: [label], actions: [], pending: [], preferences: []})
        const responses = ['一', '二', '三', '四', '五'].map(label => replyResponse(summary(label)))
        const requests = setModel([...responses, replyResponse('完成')])
        h.invoke('chat:send', '继续')
        const turn = await h.finish()
        assert.equal(turn.error, undefined)
        assert.equal(requests.length, 6, 'nine ~10k turns fold in five chunks, then the answer')
        for (const request of requests.slice(0, 5)) {
            assert.ok(JSON.stringify(request.messages[1]).length < 26000, 'each compaction request stays bounded')
        }
        const previous = (index: number) => JSON.parse(requests[index].messages[1].content).previousSummary
        assert.equal(previous(0), null)
        assert.match(String(previous(1)), /一/, 'later chunks fold the previous summary')
        assert.equal(h.db.getCompaction('alice')?.coversUpTo, '8')
    } finally {h.restore()}
})

test('trace details keep counts, not full prompts, while tool responses stay inspectable', async () => {
    const h = harness()
    try {
        setModel([callResponse('list_todos', {}), replyResponse('完成')])
        h.invoke('chat:send', '查询待办')
        const turn = await h.finish()
        const events = h.invoke('chat:trace', turn.id).data as ChatTraceEvent[]
        const context = events.find(item => item.kind === 'context')!
        const model = events.find(item => item.kind === 'model')!
        assert.equal('messages' in (context.details as object), false, 'context details must not embed the prompt')
        assert.ok((context.details as any).messageCount > 0)
        assert.equal('messages' in (model.details as object), false, 'model details must not embed the prompt')
        assert.ok((model.details as any).tools.includes('list_todos'), 'tool names must still be listed')
        assert.ok((model.details as any).chars > 0)
        const tool = events.find(item => item.kind === 'tool')!
        assert.ok((tool.details as any).rawResponse, 'raw tool response is still stored once per call')
    } finally {h.restore()}
})

test('streaming writes only the running-turn row and clears it when the turn finishes', async () => {
    const h = harness()
    try {
        h.db.saveChatConversation('alice', JSON.stringify([{id: 'old', user: '旧', reply: 'a', cards: [], context: []}]))
        let release: (() => void) | undefined
        globalThis.fetch = async () => new Promise<Response>(resolve => {release = () => resolve(replyResponse('完成'))})
        h.invoke('chat:send', '新问题')
        const until = Date.now() + 1000
        while (!release && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 5))
        const pending = h.db.getRunningTurn('alice')
        assert.ok(pending, 'the running turn must be persisted on its own')
        assert.deepEqual(JSON.parse(h.db.getChatConversation('alice')!).map((turn: any) => turn.id), ['old'],
            'the full conversation blob must not be rewritten while streaming')
        release!()
        const turn = await h.finish()
        assert.equal(pending!.turnId, turn.id)
        assert.equal(h.db.getRunningTurn('alice'), null)
        assert.deepEqual(JSON.parse(h.db.getChatConversation('alice')!).map((item: any) => item.id), ['old', turn.id])
    } finally {h.restore()}
})

test('an interrupted running turn is recovered and marked as interrupted on next load', () => {
    const h = harness()
    try {
        h.db.saveChatConversation('alice', JSON.stringify([{id: 'old', user: '旧', reply: 'a', cards: [], context: []}]))
        h.db.saveRunningTurn('alice', 'running-1', 1, JSON.stringify({id: 'running-1', user: '进行中', reply: '部分',
            cards: [], context: [], error: '回复中断；已完成的操作仍然有效，请查询后再继续。'}))
        const state = h.invoke('chat:get').data
        assert.deepEqual(state.turns.map((turn: any) => turn.id), ['old', 'running-1'])
        assert.match(state.turns[1].error, /回复中断/)
    } finally {h.restore()}
})

test('live pushes are deltas with only the running turn; the final push is full', async () => {
    const h = harness()
    try {
        h.db.saveChatConversation('alice', JSON.stringify([{id: 'old', user: '旧', reply: 'a', cards: [], context: []}]))
        setModel([replyResponse('新回复')])
        h.invoke('chat:send', '新问题')
        await h.finish()
        const deltas = h.snapshots.filter(state => (state as any).full === false)
        assert.ok(deltas.length > 0)
        assert.ok(deltas.every(state => state.turns.length === 1), 'deltas carry the running turn only')
        const full = h.snapshots.at(-1)!
        assert.equal((full as any).full, true)
        assert.ok(full.turns.length >= 2)
    } finally {h.restore()}
})

test('session trace lists metadata only and loads details per event on demand', async () => {
    const h = harness()
    try {
        setModel([callResponse('list_todos', {}), replyResponse('完成')])
        h.invoke('chat:send', '查询待办')
        await h.finish()
        const turns = h.invoke('chat:session-trace').data as any[]
        const tool = turns[0].events.find((item: any) => item.kind === 'tool')
        assert.equal('details' in tool, false, 'the list must not ship details')
        assert.equal(tool.hasDetails, true)
        const detail = h.invoke('chat:trace-event', {turnId: turns[0].turnId, eventId: tool.id}).data as any
        assert.ok(detail.details.rawResponse)
        const model = turns[0].events.find((item: any) => item.kind === 'model')
        const modelDetail = h.invoke('chat:trace-event', {turnId: turns[0].turnId, eventId: model.id}).data as any
        assert.equal('messages' in modelDetail.details, false)
    } finally {h.restore()}
})

test('forget ignores edits to non-text fields but refuses a changed memory text', async () => {
    const h = harness()
    try {
        h.invoke('memory:set-enabled', true)
        const seed = {kind: 'preference' as const, text: '用户偏好数学', evidence: '我喜欢数学', confidence: 1, pinned: true,
            expiresAt: null, status: 'active' as const, id: 'abcdef12-3456-7890-abcd-ef1234567890',
            createdAt: '2026-11-07T00:00:00Z', updatedAt: '2026-11-07T00:00:00Z'}
        h.db.saveMemory('alice', seed)
        setModel([callResponse('forget', {id: seed.id}), replyResponse('请允许删除。')])
        h.invoke('chat:send', '忘记这个偏好')
        let turn = await h.finish()
        let request = turn.actionRequests![0]
        // Editing only pin state must not invalidate the approval card.
        h.db.saveMemory('alice', {...h.db.getMemories('alice')[0], pinned: false})
        h.invoke('chat:decide-action', {turnId: turn.id, requestId: request.id, allow: true})
        assert.equal(h.db.getMemories('alice').length, 0)

        h.db.saveMemory('alice', seed)
        setModel([callResponse('forget', {id: seed.id}), replyResponse('请允许删除。')])
        h.invoke('chat:send', '再忘记一次')
        turn = await h.finish(); request = turn.actionRequests![0]
        h.db.saveMemory('alice', {...h.db.getMemories('alice')[0], text: '用户偏好物理'})
        h.invoke('chat:decide-action', {turnId: turn.id, requestId: request.id, allow: true})
        const failed = h.state().turns.at(-1)!.actionRequests![0]
        assert.equal(failed.status, 'failed')
        assert.match(failed.error!, /记忆内容已变化/)
        assert.equal(h.db.getMemories('alice').length, 1)
    } finally {h.restore()}
})

test('older turns fold their tool results before being replayed to the model', async () => {
    const h = harness()
    try {
        const turns = [0, 1, 2].map(i => ({id: `t${i}`, user: `问题${i}`, reply: 'a', cards: [], context: [
            {role: 'user', content: `问题${i}`},
            {role: 'assistant', content: null, tool_calls: [{id: `c${i}`, type: 'function', function: {name: 'list_todos', arguments: '{}'}}]},
            {role: 'tool', tool_call_id: `c${i}`, content: JSON.stringify({ok: true, data: {big: 'x'.repeat(5000)}})},
            {role: 'assistant', content: '答'},
        ]}))
        h.db.saveChatConversation('alice', JSON.stringify(turns))
        const requests = setModel([replyResponse('新回答')])
        h.invoke('chat:send', '再问')
        await h.finish()
        const tools = requests[0].messages.filter((message: any) => message.role === 'tool')
        assert.ok(tools[0].content.includes('已折叠'), 'the oldest turn folds')
        assert.ok(tools.at(-1).content.includes('"big"'), 'the newest turn keeps the original')
    } finally {h.restore()}
})

test('a single turn folds older tool results once the in-turn budget is exceeded', async () => {
    const h = harness()
    try {
        h.notices.detail = async () => ({content: 'x'.repeat(11000)})
        const responses = [callResponse('search_notices', {})]
        for (let i = 0; i < 6; i++) responses.push(callResponse('get_notice',
            {sourceId: h.notice.sourceId, url: h.notice.url}, `n-${i}`))
        responses.push(replyResponse('完成'))
        const requests = setModel(responses)
        h.invoke('chat:send', '读六次通知')
        const turn = await h.finish()
        assert.equal(turn.error, undefined)
        const tools = requests.at(-1).messages.filter((message: any) => message.role === 'tool')
        assert.ok(tools.some((message: any) => message.content.includes('已折叠')), 'older results fold within the turn')
        assert.ok(tools.slice(-2).every((message: any) => !message.content.includes('已折叠')), 'the newest results stay verbatim')
    } finally {h.restore()}
})

test('approvals clicked while streaming are queued and applied after the turn ends', async () => {
    const h = harness()
    try {
        let release: (() => void) | undefined
        let call = 0
        globalThis.fetch = async () => {
            call++
            if (call === 1) return callResponse('create_todo', {title: '排队待办'})
            return new Promise<Response>(resolve => {release = () => resolve(replyResponse('请允许。'))})
        }
        h.invoke('chat:send', '创建待办')
        const until = Date.now() + 1000
        while ((!h.state().turns.at(-1)?.actionRequests?.length || !release) && Date.now() < until) {
            await new Promise(resolve => setTimeout(resolve, 5))
        }
        const turn = h.state().turns.at(-1)!
        const request = turn.actionRequests![0]
        const result = h.invoke('chat:decide-action', {turnId: turn.id, requestId: request.id, allow: true})
        assert.equal(result.ok, true, 'the click is queued instead of rejected while streaming')
        assert.equal(h.db.getTodos('alice').length, 0, 'nothing is written before the turn ends')
        release!()
        await h.finish()
        assert.equal(h.db.getTodos('alice').length, 1, 'the queued approval runs once the turn ends')
    } finally {h.restore()}
})

function setJsonModel(outputs: string[]) {
    const requests: any[] = []
    globalThis.fetch = async (_url, init) => {
        const body = JSON.parse(String(init?.body))
        requests.push(body)
        const content = outputs.shift()
        if (content === undefined) throw new Error('unexpected model request')
        return new Response(JSON.stringify({choices: [{message: {content}}]}),
            {headers: {'Content-Type': 'application/json'}})
    }
    return requests
}

function seedTurns(count = 13) {
    return Array.from({length: count}, (_, i) => ({id: String(i), user: `问题${i}`, reply: 'a', cards: [],
        context: [{role: 'user', content: `问题${i}`}, {role: 'assistant', content: 'a'}]}))
}

test('compaction requests carry an existing-memory digest without stored fields', async () => {
    const h = harness()
    try {
        h.invoke('memory:set-enabled', true)
        const now = new Date().toISOString()
        h.db.saveMemory('alice', {id: '3f2a91c0-1111-2222-3333-444455556666', kind: 'fact',
            text: '用户是数学科学学院本科生', evidence: '我是数学科学学院本科生', confidence: 1, pinned: true,
            expiresAt: null, status: 'active', createdAt: now, updatedAt: now})
        h.db.saveChatConversation('alice', JSON.stringify(seedTurns()))
        const requests = setModel([replyResponse(JSON.stringify({facts: [], actions: [], pending: [], preferences: []})),
            replyResponse('继续')])
        h.invoke('chat:send', '继续')
        await h.finish()
        const payload = JSON.parse(requests[0].messages[1].content)
        assert.deepEqual(payload.memories, [{id: '3f2a91c0', kind: 'fact', text: '用户是数学科学学院本科生'}])
        assert.match(requests[0].messages[0].content, /已有记忆/)
        assert.match(requests[0].messages[0].content, /targetId/)
        assert.equal(JSON.stringify(payload.memories).includes('evidence'), false)
    } finally {h.restore()}
})

test('a skip candidate creates no card; an update candidate shows and applies a diff', async () => {
    const h = harness()
    try {
        h.invoke('memory:set-enabled', true)
        const createdAt = '2026-01-01T00:00:00.000Z'
        const now = new Date().toISOString()
        const id = '3f2a91c0-1111-2222-3333-444455556666'
        h.db.saveMemory('alice', {id, kind: 'fact', text: '用户是数学科学学院本科生', evidence: '我是数学科学学院本科生',
            confidence: 0.8, pinned: false, expiresAt: null, status: 'active', createdAt, updatedAt: now, seenCount: 1})
        h.db.saveChatConversation('alice', JSON.stringify(seedTurns()))
        const skip = JSON.stringify({facts: [], actions: [], pending: [], preferences: [], memories: [
            {op: 'skip', kind: 'fact', text: '用户是数学科学学院本科生'}]})
        setModel([replyResponse(skip), replyResponse('无需新增。')])
        h.invoke('chat:send', '继续')
        let turn = await h.finish()
        assert.equal(turn.actionRequests?.length ?? 0, 0, 'skip produces no card')

        // Reset the seeded history so the second turn compacts again.
        h.db.saveChatConversation('alice', JSON.stringify(seedTurns()))
        h.db.saveCompaction('alice', null)
        const update = JSON.stringify({facts: [], actions: [], pending: [], preferences: [], memories: [
            {op: 'update', targetId: '3f2a91c0', kind: 'fact', text: '用户是数学科学学院 2026 级本科生',
                confidence: 0.9, expiresAt: null}]})
        setModel([replyResponse(update), replyResponse('请确认更新。')])
        h.invoke('chat:send', '再继续')
        turn = await h.finish()
        const request = turn.actionRequests![0]
        assert.equal(request.action.kind, 'remember')
        assert.equal((request.action as any).targetId, id)
        assert.equal((request.action as any).previousText, '用户是数学科学学院本科生')
        h.invoke('chat:decide-action', {turnId: turn.id, requestId: request.id, allow: true})
        const memories = h.db.getMemories('alice')
        assert.equal(memories.length, 1, 'updated in place instead of adding a duplicate')
        assert.equal(memories[0].id, id)
        assert.equal(memories[0].createdAt, createdAt)
        assert.equal(memories[0].text, '用户是数学科学学院 2026 级本科生')
        assert.equal(memories[0].seenCount, 2)
    } finally {h.restore()}
})

test('consolidation preview, apply and undo round-trip', async () => {
    const h = harness()
    try {
        h.invoke('memory:set-enabled', true)
        const now = Date.now()
        const items = ['用户偏好数学', '用户偏好数学。', '用户偏好数学！'].map((text, index) => ({
            id: ['aaaa1111-1111-1111-1111-111111111111', 'bbbb2222-2222-2222-2222-222222222222',
                'cccc3333-3333-3333-3333-333333333333'][index],
            kind: 'preference' as const, text, evidence: index ? '我偏爱数学' : '我喜欢数学',
            confidence: 0.8, pinned: false, expiresAt: null, status: 'active' as const,
            createdAt: new Date(now - 3000 + index * 1000).toISOString(), updatedAt: new Date(now).toISOString(),
        }))
        for (const item of items) h.db.saveMemory('alice', item)
        const requests = setJsonModel([JSON.stringify({text: '用户偏好数学', kind: 'preference',
            keepIds: items.map(item => memoryShortId(item.id))})])
        const preview = await h.invoke('memory:consolidate-preview') as any
        assert.equal(preview.ok, true, preview.error)
        assert.equal(preview.data.groups.length, 1)
        assert.equal(preview.data.groups[0].before.length, 3)
        assert.equal(preview.data.groups[0].status, 'ok')
        assert.equal(requests.length, 1)
        assert.deepEqual(requests[0].messages[1].content, JSON.stringify({entries: items.map(item => ({
            id: memoryShortId(item.id), kind: item.kind, text: item.text, evidence: item.evidence}))}))

        const applied = h.invoke('memory:consolidate-apply',
            {previewId: preview.data.previewId, groupIds: [preview.data.groups[0].id]}) as any
        assert.equal(applied.ok, true, applied.error)
        assert.equal(applied.data.removed, 2)
        const merged = applied.data.state.items[0]
        assert.equal(merged.id, items[0].id, 'keeps the oldest id')
        assert.deepEqual(merged.mergedFrom, [items[1].id, items[2].id])
        assert.equal(merged.source, 'consolidation')
        assert.equal(applied.data.state.items.length, 1)

        const undone = h.invoke('memory:consolidate-undo', preview.data.previewId) as any
        assert.equal(undone.ok, true, undone.error)
        assert.equal(undone.data.restored, 3)
        assert.deepEqual(h.db.getMemories('alice').map(item => item.id).sort(), items.map(item => item.id).sort())
        assert.equal(h.db.getMemories('alice').find(item => item.id === items[2].id)?.text, '用户偏好数学！')
    } finally {h.restore()}
})

test('a failed consolidation group does not block a valid group', async () => {
    const h = harness()
    try {
        h.invoke('memory:set-enabled', true)
        const now = Date.now(), iso = (offset: number) => new Date(now + offset).toISOString()
        const items = [
            {id: 'aaaa1111-1111-1111-1111-111111111111', text: '用户偏好数学', createdAt: iso(-4000)},
            {id: 'bbbb2222-2222-2222-2222-222222222222', text: '用户偏好数学。', createdAt: iso(-3000)},
            {id: 'cccc3333-3333-3333-3333-333333333333', text: '用户住在邯郸校区', createdAt: iso(-2000)},
            {id: 'dddd4444-4444-4444-4444-444444444444', text: '用户在邯郸校区', createdAt: iso(-1000)},
        ].map(item => ({...item, kind: 'fact' as const, evidence: '用户原话', confidence: 0.7, pinned: false,
            expiresAt: null, status: 'active' as const, updatedAt: iso(0)}))
        for (const item of items) h.db.saveMemory('alice', item)
        const valid = items.slice(2).map(item => memoryShortId(item.id))
        setJsonModel([JSON.stringify({text: '用户偏好数学', kind: 'fact', keepIds: [memoryShortId(items[0].id), memoryShortId(items[1].id)]}),
            JSON.stringify({text: '无效', keepIds: ['zzzzzzzz']})])
        const preview = await h.invoke('memory:consolidate-preview') as any
        assert.equal(preview.ok, true, preview.error)
        const groups = preview.data.groups
        assert.equal(groups.length, 2)
        assert.equal(groups[0].status, 'ok', 'identical-text group is scanned first')
        assert.equal(groups[1].status, 'failed')
        const applied = h.invoke('memory:consolidate-apply',
            {previewId: preview.data.previewId, groupIds: [groups[0].id]}) as any
        assert.equal(applied.ok, true, applied.error)
        assert.equal(applied.data.removed, 1, 'only the valid group is applied')
        assert.equal(h.db.getMemories('alice').length, 3)
    } finally {h.restore()}
})

test('applying a preview after the user edited a memory is rejected', async () => {
    const h = harness()
    try {
        h.invoke('memory:set-enabled', true)
        const now = new Date().toISOString()
        const items = ['用户偏好数学', '用户偏好数学。', '用户偏好数学！'].map((text, index) => ({
            id: ['aaaa1111-1111-1111-1111-111111111111', 'bbbb2222-2222-2222-2222-222222222222',
                'cccc3333-3333-3333-3333-333333333333'][index],
            kind: 'preference' as const, text, evidence: '我喜欢数学', confidence: 0.8, pinned: false,
            expiresAt: null, status: 'active' as const, createdAt: now, updatedAt: now,
        }))
        for (const item of items) h.db.saveMemory('alice', item)
        setJsonModel([JSON.stringify({text: '用户偏好数学', keepIds: items.map(item => memoryShortId(item.id))})])
        const preview = await h.invoke('memory:consolidate-preview') as any
        assert.equal(preview.ok, true, preview.error)
        h.db.saveMemory('alice', {...h.db.getMemories('alice')[0], text: '用户偏好物理'})
        const applied = h.invoke('memory:consolidate-apply',
            {previewId: preview.data.previewId, groupIds: [preview.data.groups[0].id]}) as any
        assert.equal(applied.ok, false)
        assert.match(applied.error, /记忆已变化/)
        assert.equal(h.db.getMemories('alice').length, 3)
    } finally {h.restore()}
})

test('manual consolidation merges exactly the selected memories', async () => {
    const h = harness()
    try {
        h.invoke('memory:set-enabled', true)
        const now = new Date().toISOString()
        const items = ['用户偏好数学', '用户喜欢篮球'].map((text, index) => ({
            id: ['aaaa1111-1111-1111-1111-111111111111', 'bbbb2222-2222-2222-2222-222222222222',
                'cccc3333-3333-3333-3333-333333333333'][index],
            kind: 'fact' as const, text, evidence: '用户原话', confidence: 0.8, pinned: false,
            expiresAt: null, status: 'active' as const, createdAt: now, updatedAt: now,
        }))
        for (const item of items) h.db.saveMemory('alice', item)
        setJsonModel([JSON.stringify({text: '用户偏好数学，也喜欢篮球', keepIds: items.map(item => memoryShortId(item.id))})])
        const preview = await h.invoke('memory:consolidate-preview', {ids: items.map(item => item.id)}) as any
        assert.equal(preview.ok, true, preview.error)
        assert.equal(preview.data.groups.length, 1, 'manual mode bypasses clustering')
        assert.equal(preview.data.groups[0].before.length, 2)
    } finally {h.restore()}
})

test('disabled memory sends an empty digest and produces no candidates', async () => {
    const h = harness()
    try {
        const now = new Date().toISOString()
        h.db.saveMemory('alice', {id: 'aaaa1111-1111-1111-1111-111111111111', kind: 'fact', text: '用户主修数学',
            evidence: '我主修数学', confidence: 1, pinned: true, expiresAt: null, status: 'active', createdAt: now, updatedAt: now})
        h.db.saveChatConversation('alice', JSON.stringify(seedTurns()))
        const summary = JSON.stringify({facts: [], actions: [], pending: [], preferences: [], memories: [
            {op: 'add', kind: 'fact', text: '用户主修数学', evidence: '问题0', confidence: 1, expiresAt: null}]})
        const requests = setModel([replyResponse(summary), replyResponse('继续')])
        h.invoke('chat:send', '继续')
        const turn = await h.finish()
        assert.deepEqual(JSON.parse(requests[0].messages[1].content).memories, [])
        assert.equal(turn.actionRequests?.length ?? 0, 0)
        assert.equal(h.db.getMemories('alice').length, 1, 'no candidate is written')
    } finally {h.restore()}
})

test('a fabricated targetId is downgraded to add and recorded in the trace', async () => {
    const h = harness()
    try {
        h.invoke('memory:set-enabled', true)
        h.db.saveChatConversation('alice', JSON.stringify(seedTurns()))
        const summary = JSON.stringify({facts: [], actions: [], pending: [], preferences: [], memories: [
            {op: 'update', targetId: 'deadbeef', kind: 'fact', text: '用户主修数学', evidence: '问题0', confidence: 1, expiresAt: null}]})
        setModel([replyResponse(summary), replyResponse('继续')])
        h.invoke('chat:send', '继续')
        const turn = await h.finish()
        assert.equal(turn.actionRequests?.[0].action.kind, 'remember')
        assert.equal((turn.actionRequests![0].action as any).targetId, undefined, 'downgraded to add')
        const trace = h.invoke('chat:trace', turn.id).data as ChatTraceEvent[]
        assert.ok(trace.some(item => item.kind === 'error' && item.label === '压缩候选引用了不存在的记忆'))
    } finally {h.restore()}
})

test('a second consolidation scan is rejected while the first is running', async () => {
    const h = harness()
    try {
        h.invoke('memory:set-enabled', true)
        const now = new Date().toISOString()
        for (const [id, text] of [['aaaa1111-1111-1111-1111-111111111111', '用户偏好数学'],
            ['bbbb2222-2222-2222-2222-222222222222', '用户偏好数学。']]) {
            h.db.saveMemory('alice', {id, kind: 'preference', text, evidence: '我喜欢数学', confidence: 0.8,
                pinned: false, expiresAt: null, status: 'active', createdAt: now, updatedAt: now})
        }
        let release: (() => void) | undefined
        globalThis.fetch = async () => new Promise<Response>(resolve => {
            release = () => resolve(new Response(JSON.stringify({choices: [{message: {content: JSON.stringify({
                text: '用户偏好数学', keepIds: ['aaaa1111', 'bbbb2222']})}}]}), {headers: {'Content-Type': 'application/json'}}))
        })
        const first = h.invoke('memory:consolidate-preview') as Promise<any>
        const until = Date.now() + 1000
        while (!release && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 5))
        const second = await h.invoke('memory:consolidate-preview') as any
        assert.equal(second.ok, false)
        assert.match(second.error, /正在整理/)
        release!()
        const finished = await first
        assert.equal(finished.ok, true, finished.error)
    } finally {h.restore()}
})

test('editing a failed message replaces it and resends the edited text', async () => {
    const h = harness()
    try {
        globalThis.fetch = async () => new Response('bad request', {status: 400})
        h.invoke('chat:send', '原始问题')
        let turn = await h.finish()
        assert.ok(turn.error, 'the turn fails')
        const failedId = turn.id
        assert.ok(h.invoke('chat:trace', failedId).ok, 'failed turn has a trace')

        const requests = setModel([replyResponse('修改后的回答')])
        const result = h.invoke('chat:retry', {turnId: failedId, text: '修改后的问题'}) as any
        assert.equal(result.ok, true, result.error)
        turn = await h.finish()
        assert.equal(turn.user, '修改后的问题')
        assert.notEqual(turn.id, failedId)
        assert.equal(h.state().turns.length, 1, 'the failed turn is replaced, not appended')
        assert.equal(h.invoke('chat:trace', failedId).ok, false, 'its trace is removed with it')
        assert.ok(requests[0].messages.some((message: any) => message.content === '修改后的问题'))
    } finally {h.restore()}
})

test('retry only accepts the last failed turn', async () => {
    const h = harness()
    try {
        setModel([replyResponse('正常回答')])
        h.invoke('chat:send', '正常问题')
        const ok = await h.finish()
        const notFailed = h.invoke('chat:retry', {turnId: ok.id, text: '改一下'}) as any
        assert.equal(notFailed.ok, false)
        assert.match(notFailed.error, /只有失败/)

        globalThis.fetch = async () => new Response('bad request', {status: 400})
        h.invoke('chat:send', '会失败的')
        const failed = await h.finish()
        assert.ok(failed.error)

        setModel([replyResponse('第二条正常回答')])
        h.invoke('chat:send', '后续问题')
        await h.finish()
        const stale = h.invoke('chat:retry', {turnId: failed.id, text: '补救'}) as any
        assert.equal(stale.ok, false)
        assert.match(stale.error, /最近一条/)

        const empty = h.invoke('chat:retry', {turnId: failed.id, text: '   '}) as any
        assert.equal(empty.ok, false)
    } finally {h.restore()}
})
