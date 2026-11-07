/** Isolated UI fixture: production components, mock IPC. Never imported by the application. */
import {useState} from 'react'
import {createRoot} from 'react-dom/client'
import {ChatPage} from '../src/renderer/src/ChatPage'
import {MemoryPanel} from '../src/renderer/src/MemoryPanel'
import {UsagePanel} from '../src/renderer/src/UsagePanel'
import type {ChatState} from '../src/shared/chat'
import type {ChatTraceEvent} from '../src/shared/agent'
import type {MemoryState} from '../src/shared/memory'
import '../src/renderer/src/styles/base.css'
import '../src/renderer/src/styles/app.css'
import '../src/renderer/src/styles/llm.css'

const at = new Date().toISOString()
const events: ChatTraceEvent[] = [
    {id: 'context', kind: 'context', label: '本次模型上下文', at, status: 'completed', details: {timeZone: 'Asia/Shanghai', memoryIds: []}},
    {id: 'model', kind: 'model', label: '模型调用 1', at, elapsedMs: 831, status: 'completed', details: {model: 'demo', response: {tool_calls: [{id: 'call-1', function: {name: 'list_todos', arguments: '{}'}}]}}},
    {id: 'tool', kind: 'tool', label: '正在查询待办', at, elapsedMs: 12, status: 'completed', details: {name: 'list_todos', arguments: '{}', rawResponse: {total: 1, items: [{title: '读论文', notes: '先读方法，再看实验'}]}, modelResponse: {ok: true, data: {total: 1, items: [{title: '读论文'}]}, truncated: false, remaining: {rounds: 7, calls: 23}}}},
    {id: 'usage', kind: 'usage', label: '模型用量与耗时', at, status: 'completed', details: {promptTokens: 1034, completionTokens: 142, elapsedMs: 831}},
    {id: 'finish', kind: 'finish', label: '本轮回复完成', at, status: 'completed', details: {pendingApprovals: 1}},
]
const stats = {
    turns: 32, steps: 263, requests: 41, promptTokens: 45_200_000, completionTokens: 120_000,
    cacheHitTokens: 44_064_400, elapsedMs: 780_000, lastPromptTokens: 8_600,
    cacheHitRate: 0.975, tokensPerSecond: 58.1, contextPercent: 27, turnElapsedMs: 0
}
const initial: ChatState = {username: 'demo', busy: true, status: '正在查询待办', stats, turns: [{id: 'turn-1', user: '查一下我的待办，再添加一项：阅读 LoRA 论文。',
    reply: '你目前有 1 条待办：**读论文**。\n\n我已准备好“阅读 LoRA 论文”的新增请求，请核对后允许保存。', cards: [],
    trace: events.map(({details, ...item}) => item),
    actionRequests: [{id: 'request-1', status: 'pending', action: {kind: 'create_todo', todo: {title: '阅读 LoRA 论文', notes: '', dueDate: '', dueTime: '00:00', completed: false, reminderMinutes: -1}}}]}]}
let state = structuredClone(initial)
let listener = (_state: ChatState) => {}
const result = <T,>(data: T) => Promise.resolve({ok: true as const, data: structuredClone(data)})
window.chat = {
    get: () => result(state), trace: () => result(events), usage: () => result({today: {promptTokens: 1200, completionTokens: 280, requests: 2, missingUsage: 1, elapsedMs: 1520}, month: {promptTokens: 8900, completionTokens: 1200, requests: 15, missingUsage: 2, elapsedMs: 12030}}),
    send: async text => {state.turns.push({id: `turn-${state.turns.length + 1}`, user: text, reply: '查询结果为空。可缩小关键词范围或刷新数据后再试。', cards: [], trace: []}); listener(structuredClone(state)); return result(state)},
    clear: () => {state.turns = []; listener(state); return result(state)}, cancel: () => result(null),
    decideSummary: () => result(state),
    decideAction: (_turnId, requestId, allow) => {
        const request = state.turns.flatMap(turn => turn.actionRequests ?? []).find(item => item.id === requestId)!
        request.status = allow ? 'completed' : 'rejected'
        if (allow) request.checkpoint = {before: null, after: null, at}
        listener(structuredClone(state)); return result(state)
    },
    undo: (_turnId, requestId) => {state.turns.flatMap(turn => turn.actionRequests ?? []).find(item => item.id === requestId)!.status = 'undone'; listener(structuredClone(state)); return result(state)},
    onChanged: cb => {listener = cb; return () => {listener = () => {}}},
}
window.notices = {list: () => result({items: [], sources: []})} as never
window.messagePreferences = {get: () => result({identity: 'staff'})} as never
window.timetable = {get: () => result(null)} as never
let memories: MemoryState = {username: 'demo', enabled: true, items: [{id: 'memory-1', text: '偏好先看具体例子，再理解抽象定义。', kind: 'preference', evidence: '请先用具体例子解释。', confidence: 1, pinned: true, expiresAt: null, status: 'active', createdAt: at, updatedAt: at}]}
window.memory = {get: () => result(memories), setEnabled: enabled => {memories.enabled = enabled; return result(memories)},
    save: value => {memories.items = memories.items.map(item => item.id === value.id ? {...item, ...value} : item); return result(memories)},
    remove: id => {memories.items = memories.items.filter(item => item.id !== id); return result(memories)},
    exportJson: () => result(JSON.stringify({version: 1, memories: memories.items})), importJson: () => result(memories)}
function Preview() {
    const [settings, setSettings] = useState(false)
    return <div style={{height: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--color-bg-surface)'}}>
        <nav aria-label="UI 验证" style={{display: 'flex', flexWrap: 'wrap', gap: 12, padding: '12px 24px', borderBottom: '1px solid var(--color-border-subtle)'}}>
            <strong style={{flexBasis: '100%'}}>FduNav · 界面验证（模拟数据）</strong>
            <button type="button" className="secondary-button" onClick={() => setSettings(false)}>聊天</button>
            <button type="button" className="secondary-button" onClick={() => setSettings(true)}>记忆与用量</button>
            <button type="button" className="secondary-button" onClick={() => {document.documentElement.style.colorScheme = document.documentElement.style.colorScheme === 'dark' ? 'light' : 'dark'}}>切换主题</button>
        </nav>
        <main style={{flex: 1, minHeight: 0}}>{settings ? <div style={{maxWidth: 850, height: '100%', overflow: 'auto', margin: 'auto', padding: 24}}>
            <UsagePanel active/><MemoryPanel active/>
        </div> : <ChatPage username="demo" onSettings={() => setSettings(true)} onOpenNotice={() => {}}/>}</main>
    </div>
}
createRoot(document.getElementById('root')!).render(<Preview/>)
