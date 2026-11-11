import {test} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {handlers} from './fakes/electron.ts'
import {replyResponse, streamResponse} from './fakes/model.ts'
import {registerChatHandlers} from '../src/main/chat.ts'
import {AppDatabase} from '../src/main/database.ts'
import {TodoService} from '../src/main/todo-service.ts'
import {emptyLlmSettings} from '../src/shared/llm.ts'
import {LlmSettingsService} from '../src/main/llm-settings.ts'

function batch(round: number) {
    return streamResponse([{choices: [{delta: {tool_calls: Array.from({length: 8}, (_, i) => ({
        index: i, id: `${round}-${i}`, type: 'function', function: {name: 'list_todos', arguments: '{}'}
    }))}, finish_reason: 'tool_calls'}]}, '[DONE]'])
}
function call(name: string, args: unknown) {
    return streamResponse([{choices: [{delta: {tool_calls: [{index: 0, id: randomUUID(), type: 'function',
        function: {name, arguments: JSON.stringify(args)}}]}, finish_reason: 'tool_calls'}]}, '[DONE]'])
}
function harness() {
    handlers.clear()
    const db = new AppDatabase(':memory:')
    const user = 'alice'
    db.saveAccount({username: user, cookies: new Uint8Array(), target: '', last_login: 'now'})
    db.saveLlmSettings({...emptyLlmSettings(), baseUrl: 'https://example.com/v1', model: 'test-model', encryptedApiKey: null})
    db.setLlmEnabled(true)
    const accounts = {getState: () => ({status: 'signed-in', username: user})}
    const llm = new LlmSettingsService(db, {available: async () => true, encrypt: async () => new Uint8Array(), decrypt: async () => ''})
    const service = new TodoService(db)
    const calendar = {save: (_u: string, i: any) => {const value = {...i, id: i.id ?? randomUUID()}; db.saveCalendarEvent(_u, value); return value},
        remove: (_u: string, id: string) => db.removeCalendarEvent(_u, id)}
    const todos = {save: (owner: string, input: unknown) => service.save(owner, input), remove: (owner: string, id: string) => service.remove(owner, id)}
    const notices = {list: () => ({items: []}), detail: async () => ({content: ''})}
    registerChatHandlers(db, accounts as never, llm, notices as never, calendar as never, todos as never, {list: async () => {throw new Error('mail stub')}, read: async () => ({} as never)} as never, () => true)
    const event = {trusted: true, sender: {once: () => {}, isDestroyed: () => false, send: () => {}}}
    const invoke = (channel: string, input?: unknown): any => handlers.get(channel)!(event, input)
    const state = (): any => invoke('chat:get').data
    const finish = async () => {
        const until = Date.now() + 8000
        while (state().busy && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 5))
        assert.equal(state().busy, false, 'turn should finish')
        return state().turns.at(-1)!
    }
    return {db, invoke, state, finish, service}
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
const original = globalThis.fetch
test.after(() => {globalThis.fetch = original})

test('a cancelled turn leaves an assistant note so roles alternate', async () => {
    const h = harness()
    try {
        globalThis.fetch = async (_u, init) => new Promise((_resolve, reject) => {
            if (init!.signal!.aborted) reject(init!.signal!.reason)
            else init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), {once: true})
        })
        h.invoke('chat:send', '明天的课表')
        await new Promise(resolve => setTimeout(resolve, 20))
        h.invoke('chat:cancel')
        await h.finish()
        const requests = setModel([replyResponse('好的')])
        h.invoke('chat:send', '那继续')
        await h.finish()
        const roles = requests[0].messages.map((message: any) => message.role)
        assert.deepEqual(roles, ['system', 'user', 'assistant', 'user'])
    } finally {h.db.close()}
})

test('tool budget exhaustion still returns text instead of failing the turn', async () => {
    const h = harness()
    try {
        const requests = setModel([batch(0), batch(1), batch(2), batch(3)])
        h.invoke('chat:send', '查询待办')
        const turn = await h.finish()
        assert.equal(turn.error, undefined)
        const tools = (turn.trace ?? []).filter((item: any) => item.kind === 'tool')
        assert.equal(tools.length, 24)
        assert.equal(requests.length, 4)
        assert.equal(requests[3].tools, undefined, 'final round must not offer tools')
    } finally {h.db.close()}
})

test('update and delete tools request approval, apply the change and undo it', async () => {
    const h = harness()
    try {
        h.service.save('alice', {title: '读论文', notes: '', dueDate: '2026-11-10', dueTime: '23:59', reminderMinutes: -1, completed: false})
        const todo = h.db.getTodos('alice')[0]
        setModel([call('update_todo', {id: todo.id, completed: true}), replyResponse('好的'), replyResponse('好')])
        h.invoke('chat:send', '把读论文标记完成')
        const turn = await h.finish()
        const request = (turn.actionRequests ?? []).find((item: any) => item.action.kind === 'update_todo')!
        assert.ok(request, 'update_todo should create an approval request')
        assert.equal(request.action.before.completed, false)
        assert.equal(request.action.after.completed, true)
        h.invoke('chat:decide-action', {turnId: turn.id, requestId: request.id, allow: true})
        assert.equal(h.db.getTodos('alice')[0].completed, true)
        const stored = JSON.parse(h.db.getChatConversation('alice')!).find((item: any) => item.id === turn.id)
        assert.ok(stored.context.some((message: any) => message.role === 'assistant' && String(message.content).includes('已修改待办')))
        h.invoke('chat:undo', {turnId: turn.id, requestId: request.id})
        assert.equal(h.db.getTodos('alice')[0].completed, false)
    } finally {h.db.close()}
})

test('oversized first turn with failing compaction does not lock the conversation', async () => {
    const h = harness()
    try {
        const big = 'x'.repeat(61000)
        h.db.saveChatConversation('alice', JSON.stringify([
            {id: 't0', user: '长问题', reply: '好', cards: [], context: [{role: 'user', content: big}, {role: 'assistant', content: '好'}]},
            {id: 't1', user: '问题1', reply: '答1', cards: [], context: [{role: 'user', content: '问题1'}, {role: 'assistant', content: '答1'}]}
        ]))
        const requests = setModel([replyResponse('invalid'), replyResponse('invalid'), replyResponse('invalid'),
            replyResponse('回答1'), replyResponse('回答2')])
        h.invoke('chat:send', '新问题')
        const first = await h.finish()
        assert.equal(first.error, undefined, 'a failed compaction must not fail the turn')
        assert.ok(h.db.getCompaction('alice'), 'compaction boundary is recorded even without droppable turns')
        h.invoke('chat:send', '再问一句')
        await h.finish()
        assert.equal(requests.length, 5, 'the failed range is not compacted again')
    } finally {h.db.close()}
})
