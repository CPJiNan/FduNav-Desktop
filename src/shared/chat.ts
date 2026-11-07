import type {ChatCancelReason, ChatTraceEvent} from './agent'
import type {Memory, MemoryInput} from './memory'
import type {Result} from './accounts'
import type {Notice, NoticeSummary} from './notices'
import type {CalendarEvent, CalendarEventInput, CalendarOccurrence} from './calendar'
import type {Todo, TodoInput} from './todos'

export type ChatCard = { kind: 'notice'; notice: Notice } |
    { kind: 'event'; event: CalendarEvent; deleted?: boolean } |
    { kind: 'course'; occurrence: CalendarOccurrence }

export interface ChatSummaryRequest {
    id: string
    notice: Notice
    status: 'pending' | 'generating' | 'completed' | 'rejected' | 'failed'
    summary?: NoticeSummary
    error?: string
}

export type ChatAction = { kind: 'create_event'; after: CalendarEventInput } |
    { kind: 'create_todo'; todo: TodoInput } |
    {kind: 'remember'; memory: MemoryInput} | {kind: 'forget'; memory: Memory}

export const chatActionTitles = {create_event: '新增日程', create_todo: '新增待办', remember: '保存记忆', forget: '删除记忆'} as const
export const chatActionStatusLabels = {pending: '等待允许', executing: '正在执行', completed: '已完成', rejected: '已拒绝', failed: '未完成', undone: '已撤销'} as const
export const chatSummaryStatusLabels = {pending: '等待允许', generating: '正在生成', completed: '已完成', rejected: '已拒绝', failed: '未完成'} as const

export interface ChatActionRequest {
    id: string
    action: ChatAction
    status: 'pending' | 'executing' | 'completed' | 'rejected' | 'failed' | 'undone'
    checkpoint?: {before: Memory | null; after: CalendarEvent | Todo | Memory | null; at: string}
    result?: CalendarEvent | Todo | Memory
    error?: string
}

export interface ChatTurn {
    id: string
    user: string
    reply: string
    cards: ChatCard[]
    summaryRequests?: ChatSummaryRequest[]
    actionRequests?: ChatActionRequest[]
    error?: string
    cancelReason?: ChatCancelReason
    trace?: ChatTraceEvent[]
    startedAt?: string
    finishedAt?: string
}

export interface UsageTotals {promptTokens: number; completionTokens: number; elapsedMs: number; requests: number; missingUsage: number}
export interface UsageSummary {today: UsageTotals; month: UsageTotals}

export interface ChatStats {
    turns: number
    steps: number
    requests: number
    promptTokens: number
    completionTokens: number
    cacheHitTokens: number
    elapsedMs: number
    lastPromptTokens: number
    /** 0-1, null when the provider reported no cache counters. */
    cacheHitRate: number | null
    tokensPerSecond: number | null
    /** Elapsed time of the running turn, 0 when idle. */
    turnElapsedMs: number
}

export interface SessionTraceTurn {
    turnId: string
    user: string
    at: string
    events: ChatTraceEvent[]
}

export interface ChatState {
    username: string
    turns: ChatTurn[]
    busy: boolean
    status: string
    stats?: ChatStats
}

export interface ChatAPI {
    get(): Promise<Result<ChatState>>

    send(text: string): Promise<Result<ChatState>>

    cancel(): Promise<Result<null>>

    clear(): Promise<Result<ChatState>>

    decideSummary(turnId: string, requestId: string, allow: boolean): Promise<Result<ChatState>>

    decideAction(turnId: string, requestId: string, allow: boolean): Promise<Result<ChatState>>

    trace(turnId: string): Promise<Result<ChatTraceEvent[]>>

    sessionTrace(): Promise<Result<SessionTraceTurn[]>>

    usage(): Promise<Result<UsageSummary>>

    undo(turnId: string, requestId: string): Promise<Result<ChatState>>

    onChanged(callback: (state: ChatState) => void): () => void
}
