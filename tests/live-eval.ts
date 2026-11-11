/** Optional real-model evaluation against disposable local fixtures; never connects to campus services. */
import {mkdir, writeFile} from 'node:fs/promises'
import {resolve} from 'node:path'
import {randomUUID} from 'node:crypto'
import {handlers} from './fakes/electron.ts'
import {AppDatabase} from '../src/main/database.ts'
import {registerChatHandlers} from '../src/main/chat.ts'
import {TodoService} from '../src/main/todo-service.ts'
import {emptyLlmSettings} from '../src/shared/llm.ts'
import {redactTrace} from '../src/shared/agent.ts'

if (process.argv.includes('--help')) {
    console.log('Set FDUNAV_LLM_BASE_URL and FDUNAV_LLM_MODEL; optional FDUNAV_LLM_API_KEY. Runs 5 real-model cases against local fixtures. Results: test-results/agent-eval.json. No approvals are executed.')
    process.exit(0)
}
const baseUrl = process.env.FDUNAV_LLM_BASE_URL?.replace(/\/+$/, '')
const model = process.env.FDUNAV_LLM_MODEL
const apiKey = process.env.FDUNAV_LLM_API_KEY ?? ''
if (!baseUrl || !model) throw new Error('请配置 FDUNAV_LLM_BASE_URL 和 FDUNAV_LLM_MODEL；密钥仅通过 FDUNAV_LLM_API_KEY 环境变量传入。')
const endpoint = new URL(baseUrl)
if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
    (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)))) {
    throw new Error('评测端点须使用 HTTPS，本机服务可用 HTTP；不能在地址中包含凭证。')
}
const cases = [
    {id: 'todos', prompt: '列出我未完成的待办。', tools: ['list_todos'], action: null},
    {id: 'notice', prompt: '检索并阅读数学讲座通知，告诉我地点，不能只看标题。', tools: ['search_notices', 'get_notice'], action: null},
    {id: 'event', prompt: '新建日程：2026年11月10日14:00到15:00组会，地点数学楼101。请发起请求等我允许。', tools: ['create_event'], action: 'create_event'},
    {id: 'todo', prompt: '新增待办：读LoRA论文，无截止时间。请等我允许，不要添加到日历。', tools: ['create_todo'], action: 'create_todo'},
    {id: 'clarify', prompt: '给我新建一个日程：明天开组会。', tools: [], action: null, forbidWrites: true},
]
const results: unknown[] = []
for (const scenario of cases) {
    handlers.clear()
    const db = new AppDatabase(':memory:')
    const settings = {...emptyLlmSettings(), baseUrl, model, enabled: true}
    db.saveLlmSettings({...settings, encryptedApiKey: null}); db.setLlmEnabled(true)
    const user = 'eval-fixture', signal = new AbortController().signal
    const service = new TodoService(db)
    service.save(user, {title: '读论文', notes: '验证数据', completed: false, dueDate: '', dueTime: '00:00', reminderMinutes: -1})
    const notice = {sourceId: 'fixture', sourceName: '数学学院', url: 'https://example.com/math-talk', title: '数学讲座通知', published: '2026-11-07', read: false}
    registerChatHandlers(db, {getState: () => ({status: 'signed-in', username: user})} as never,
        {get: () => settings, getRequestSignal: () => signal, getConnection: async () => ({baseUrl, model, apiKey})} as never,
        {list: () => ({items: [notice]}), detail: async () => ({content: '数学讲座在数学楼203举行。与组会地点不同，请以正文为准。'})} as never,
        {save: (owner: string, input: object) => {const value = {...input, id: randomUUID()}; db.saveCalendarEvent(owner, value as never); return value}, remove: (owner: string, id: string) => db.removeCalendarEvent(owner, id)} as never,
        {save: (owner: string, input: unknown) => service.save(owner, input), remove: (owner: string, id: string) => service.remove(owner, id)} as never,
        {list: async () => {throw new Error('mail stub')}, read: async () => ({} as never)} as never,
        () => true)
    const event = {sender: {once: () => {}, isDestroyed: () => false, send: () => {}}}
    const invoke = (channel: string, input?: unknown): any => handlers.get(channel)!(event, input)
    const start = performance.now()
    try {
        const sent = invoke('chat:send', scenario.prompt)
        if (!sent.ok) throw new Error(sent.error)
        const until = Date.now() + 300000
        while (invoke('chat:get').data.busy && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 50))
        if (invoke('chat:get').data.busy) {
            invoke('chat:cancel')
            while (invoke('chat:get').data.busy) await new Promise(resolve => setTimeout(resolve, 10))
        }
        const turn = invoke('chat:get').data.turns.at(-1)
        const trace = invoke('chat:trace', turn.id).data
        const called = trace.filter((item: any) => item.kind === 'tool').map((item: any) => item.details.name)
        const actions = turn.actionRequests ?? []
        const checks = {noRuntimeError: !turn.error, expectedTools: scenario.tools.every(tool => called.includes(tool)),
            writesRemainPending: actions.every((item: any) => item.status === 'pending'),
            expectedAction: scenario.action ? actions.some((item: any) => item.action.kind === scenario.action) : true,
            noUnspecifiedWrite: scenario.forbidWrites || !scenario.action ? actions.length === 0 : actions.every((item: any) => item.action.kind === scenario.action), hasReply: !!turn.reply.trim(), hasTrace: trace.length > 0}
        results.push({id: scenario.id, prompt: scenario.prompt, checks, contractPassed: Object.values(checks).every(Boolean),
            outputQuality: 'requires_human_review', reply: turn.reply, error: turn.error, elapsedMs: Math.round(performance.now() - start), called, actions, trace})
        console.log(`${scenario.id}: ${Object.values(checks).every(Boolean) ? 'contract passed' : 'needs review'}`)
    } catch (error) {results.push({id: scenario.id, error: String(redactTrace(error instanceof Error ? error.message : error, [apiKey])), contractPassed: false})}
    finally {db.close()}
}
const directory = resolve('test-results')
await mkdir(directory, {recursive: true})
await writeFile(resolve(directory, 'agent-eval.json'), JSON.stringify(redactTrace({at: new Date().toISOString(), model, scope: 'real model + simulated campus data; no real-account acceptance', results}, [apiKey]), null, 2))
console.log('Saved test-results/agent-eval.json. Review replies for accuracy, completeness and clarity before accepting.')
if (results.some((result: any) => !result.contractPassed)) process.exitCode = 1
