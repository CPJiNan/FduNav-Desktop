import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {handlers} from '../fakes/electron.ts'
import {streamResponse} from '../fakes/model.ts'
import {registerChatHandlers} from '../../src/main/chat.ts'
import {AppDatabase} from '../../src/main/database.ts'
import {TodoService} from '../../src/main/todo-service.ts'
import {emptyLlmSettings} from '../../src/shared/llm.ts'
import {LlmSettingsService} from '../../src/main/llm-settings.ts'
import type {ChatState} from '../../src/shared/chat.ts'

export function callResponse(name: string, args: unknown, id = 'call-1') {
    return streamResponse([{choices: [{delta: {tool_calls: [{index: 0, id, type: 'function', function: {name, arguments: JSON.stringify(args)}}]}, finish_reason: 'tool_calls'}]}, '[DONE]'])
}
export function harness() {
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
export function setModel(responses: Response[]) {
    const requests: any[] = []
    globalThis.fetch = async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)))
        const response = responses.shift()
        if (!response) throw new Error('unexpected model request')
        return response
    }
    return requests
}

