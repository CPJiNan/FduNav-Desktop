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

const now = Date.now()
const at = (offsetMs: number) => new Date(now + offsetMs).toISOString()

const finishedTrace: ChatTraceEvent[] = [
    {id: 't1', kind: 'tool', label: '查询待办', at: at(-2400), elapsedMs: 300, status: 'completed'},
    {id: 't2', kind: 'tool', label: '获取日程', at: at(-1900), elapsedMs: 200, status: 'completed'},
    {id: 't3', kind: 'tool', label: '请求新增待办', at: at(-1500), elapsedMs: 500, status: 'completed'},
    {id: 't4', kind: 'finish', label: '生成回答', at: at(-800), elapsedMs: 1400, status: 'completed'},
]

const runningTrace: ChatTraceEvent[] = [
    {id: 'r1', kind: 'tool', label: '查询待办', at: at(-1600), elapsedMs: 260, status: 'completed'},
    {id: 'r2', kind: 'tool', label: '获取日程', at: at(-1200), elapsedMs: 180, status: 'completed'},
    {id: 'r3', kind: 'tool', label: '请求新增日程', at: at(-600), status: 'running'},
]

const stats = {
    turns: 2, steps: 7, requests: 4, promptTokens: 42_000, completionTokens: 2_100,
    cacheHitTokens: 39_900, elapsedMs: 96_000, lastPromptTokens: 8_600,
    cacheHitRate: 0.95, tokensPerSecond: 52.4, turnElapsedMs: 2400
}

const initial: ChatState = {
    username: 'demo', busy: true, status: '正在请求新增日程', stats,
    turns: [
        {
            id: 'turn-1', user: '查一下我的待办，再添加一项：阅读 LoRA 论文。',
            reply: '你目前有 1 条待办：**读论文**。\n\n我已准备好「阅读 LoRA 论文」的新增请求，请核对后允许保存。',
            cards: [], trace: finishedTrace, startedAt: at(-2400), finishedAt: at(0),
            actionRequests: [{
                id: 'request-1', status: 'pending',
                action: {kind: 'create_todo', todo: {title: '阅读 LoRA 论文', notes: '', dueDate: '', dueTime: '00:00', completed: false, reminderMinutes: -1}}
            }]
        },
        {
            id: 'turn-2', user: '明天下午有空吗？帮我把组会挪到两点。',
            reply: '明天下午只有一门课，组会挪到 14:00 没有问题，我已经准备好日程请求',
            cards: [], trace: runningTrace, startedAt: at(-1600),
            actionRequests: [{
                id: 'request-2', status: 'pending',
                action: {kind: 'create_event', after: {title: '组会', startDate: '2026-11-08', endDate: '2026-11-08', startTime: '14:00', endTime: '15:00', allDay: false, location: '数学楼 1201', notes: '', reminderMinutes: 15}}
            }]
        }
    ]
}

let state = structuredClone(initial)
let listener = (_state: ChatState) => {}
const result = <T,>(data: T) => Promise.resolve({ok: true as const, data: structuredClone(data)})
window.chat = {
    sessionTrace: () => result(state.turns.map(turn => ({turnId: turn.id, user: turn.user, at: turn.startedAt ?? at(0), events: turn.trace ?? []}))),
    get: () => result(state), trace: () => result(finishedTrace), usage: () => result({
        today: {promptTokens: 1200, completionTokens: 280, requests: 2, missingUsage: 1, elapsedMs: 1520},
        month: {promptTokens: 8900, completionTokens: 1200, requests: 15, missingUsage: 2, elapsedMs: 12030}
    }),
    send: async text => {
        state.turns.push({id: `turn-${state.turns.length + 1}`, user: text, reply: '查询结果为空。', cards: [], trace: [], startedAt: at(0)})
        listener(structuredClone(state)); return result(state)
    },
    clear: () => {state.turns = []; listener(state); return result(state)}, cancel: () => result(null),
    decideSummary: () => result(state),
    decideAction: (_turnId, requestId, allow) => {
        const request = state.turns.flatMap(turn => turn.actionRequests ?? []).find(item => item.id === requestId)!
        request.status = allow ? 'completed' : 'rejected'
        if (allow) request.checkpoint = {before: null, after: null, at: at(0)}
        listener(structuredClone(state)); return result(state)
    },
    undo: (_turnId, requestId) => {
        state.turns.flatMap(turn => turn.actionRequests ?? []).find(item => item.id === requestId)!.status = 'undone'
        listener(structuredClone(state)); return result(state)
    },
    onChanged: cb => {listener = cb; return () => {listener = () => {}}},
}
window.notices = {list: () => result({items: [], sources: []})} as never
window.messagePreferences = {get: () => result({identity: 'staff'})} as never
window.timetable = {get: () => result(null)} as never
const memories: MemoryState = {
    username: 'demo', enabled: true,
    items: [{id: 'memory-1', text: '偏好先看具体例子，再理解抽象定义。', kind: 'preference', evidence: '请先用具体例子解释。', confidence: 1, pinned: true, expiresAt: null, status: 'active', createdAt: at(0), updatedAt: at(0)}]
}
window.memory = {get: () => result(memories), setEnabled: enabled => {memories.enabled = enabled; return result(memories)},
    save: value => {memories.items = memories.items.map(item => item.id === value.id ? {...item, ...value} : item); return result(memories)},
    remove: id => {memories.items = memories.items.filter(item => item.id !== id); return result(memories)},
    exportJson: () => result(JSON.stringify({version: 1, memories: memories.items})), importJson: () => result(memories)}

function Preview() {
    const [settings, setSettings] = useState(false)
    const [thinking, setThinking] = useState(false)
    function toggleThinking() {
        const next = !thinking
        setThinking(next)
        state.busy = true
        state.status = next ? '思考中' : '正在请求新增日程'
        const last = state.turns.at(-1)!
        last.trace = next ? [] : structuredClone(runningTrace)
        if (next) delete last.reply
        else last.reply = '明天下午只有一门课，组会挪到 14:00 没有问题，我已经准备好日程请求'
        listener(structuredClone(state))
    }
    return <div style={{height: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--color-bg-surface)'}}>
        <nav aria-label="UI 验证" style={{display: 'flex', flexWrap: 'wrap', gap: 12, padding: '12px 24px', borderBottom: '1px solid var(--color-border-subtle)'}}>
            <strong style={{flexBasis: '100%'}}>FduNav · 界面验证（模拟数据）</strong>
            <button type="button" className="secondary-button" onClick={() => setSettings(false)}>聊天</button>
            <button type="button" className="secondary-button" onClick={() => setSettings(true)}>记忆与用量</button>
            <button type="button" className="secondary-button" onClick={toggleThinking}>
                {thinking ? '工具执行中' : '思考中'}
            </button>
            <button type="button" className="secondary-button" onClick={() => {
                document.documentElement.style.colorScheme = document.documentElement.style.colorScheme === 'dark' ? 'light' : 'dark'
            }}>切换主题</button>
        </nav>
        <main style={{flex: 1, minHeight: 0}}>{settings ? <div style={{maxWidth: 850, height: '100%', overflow: 'auto', margin: 'auto', padding: 24}}>
            <UsagePanel active/><MemoryPanel active/>
        </div> : <ChatPage username="demo" onSettings={() => setSettings(true)} onOpenNotice={() => {}}/>}</main>
    </div>
}

createRoot(document.getElementById('root')!).render(<Preview/>)
