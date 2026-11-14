import {type FormEvent, useEffect, useRef, useState} from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import type {ChatCard, ChatPushState, ChatState} from '../../shared/chat'
import type {Notice} from '../../shared/notices'
import {type CalendarOccurrence, calendarOccurrences, timeLabel} from '../../shared/calendar'
import type {ResearchSource} from '../../shared/research'
import {CalendarEventDialog} from './CalendarEventDialog'
import {Icon} from './Icon'
import {ChatSummaryRequestCard} from './ChatSummaryRequestCard'
import {ChatActionRequestCard} from './ChatActionRequestCard'
import {ChatTracePanel} from './ChatTracePanel'
import {ChatSessionTracePanel} from './ChatSessionTracePanel'
import {ChatStatusBar} from './ChatStatusBar'
import {CopyButton} from './MessageActions'
import {ConfirmDialog} from './ConfirmDialog'
import {TurnActivity} from './TurnActivity'
import {ChatHistory, type SessionAction} from './ChatHistory'
import {ChatMenu} from './ChatMenu'
import './styles/chat.css'
import './styles/calendar.css'

const suggestions = ['本周通知摘要', '查询今天日程', '新增待办事项']

function sourceDisplayId(id: string): string {
    const kind = id.charAt(0).toUpperCase()
    return kind === 'W' ? `网页${id.slice(1)}` : kind === 'C' ? `树洞${id.slice(1)}` : id
}

function linkCitations(text: string): string {
    return text.split(/(```[\s\S]*?```|`[^`\n]*`)/g).map((segment, index) => {
        if (index % 2 === 1) return segment
        return segment.replace(/\[([WwCc][1-9][0-9]{0,5})\]/g, (_match, id: string) => `[#${sourceDisplayId(id)}](#citation-${id.toUpperCase()})`)
    }).join('')
}

function mergeState(previous: ChatState, value: ChatPushState): ChatState {
    if (value.full) return value
    const turns = previous.username === value.username && previous.sessionId === value.sessionId ? [...previous.turns] : []
    for (const turn of value.turns) {
        const index = turns.findIndex(item => item.id === turn.id)
        if (index < 0) turns.push(turn)
        else turns[index] = turn
    }
    return {...value, turns}
}

export function ChatPage({username, onOpenNotice, onSettings}: {
    username: string; onOpenNotice: (notice: Notice) => void; onSettings: () => void
}) {
    const [state, setState] = useState<ChatState>({
        username, sessionId: '', sessions: [], turns: [], busy: false, status: '', sources: [],
        research: {webReady: false, campus: {status: 'missing', loggedIn: false, email: null}}
    })
    const [loading, setLoading] = useState(true)
    const [syncing, setSyncing] = useState(true)
    const [syncError, setSyncError] = useState('')
    const [draft, setDraft] = useState('')
    const [error, setError] = useState('')
    const [sending, setSending] = useState(false)
    const [opening, setOpening] = useState(false)
    const [decidingRequest, setDecidingRequest] = useState(false)
    const [confirmClear, setConfirmClear] = useState(false)
    const [traceTurnId, setTraceTurnId] = useState<string | null>(null)
    const [editingTurnId, setEditingTurnId] = useState<string | null>(null)
    const [sessionTrace, setSessionTrace] = useState(false)
    const [historyOpen, setHistoryOpen] = useState(() => window.matchMedia('(min-width: 1001px)').matches)
    const drafts = useRef(new Map<string, { text: string; editingTurnId: string | null }>())
    const previousSession = useRef('')
    const [focusSessionId, setFocusSessionId] = useState<string | null>(null)
    const sessionActionLock = useRef(false)
    const [sourceTurnId, setSourceTurnId] = useState<string | null>(null)
    const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null)
    const traceTrigger = useRef<HTMLElement | null>(null)
    const [editor, setEditor] = useState<CalendarOccurrence | null>(null)
    const scroll = useRef<HTMLDivElement>(null)
    const input = useRef<HTMLTextAreaElement>(null)
    const mounted = useRef(true)
    const stickToBottom = useRef(true)
    const previousFocus = useRef<HTMLElement | null>(null)
    const stateRevision = useRef(0)

    const sourceIndex = new Map(state.sources.map(source => [source.id, source]))

    function sourcesFor(turn: ChatState['turns'][number]): ResearchSource[] {
        return (turn.sourceIds ?? [])
            .map(id => sourceIndex.get(id))
            .filter((source): source is ResearchSource => !!source)
    }

    function toggleSources(turnId: string) {
        setSelectedSourceId(null)
        setSourceTurnId(current => current === turnId ? null : turnId)
    }

    useEffect(() => {
        mounted.current = true
        let receivedUpdate = false
        const unsubscribe = window.chat?.onChanged(value => {
            if (value.username !== username) return
            stateRevision.current++
            receivedUpdate = true
            setState(previous => mergeState(previous, value))
        })
        if (!window.chat) {
            setError('聊天服务未加载，请重启应用。');
            setLoading(false)
        } else void window.chat.get().then(result => {
            if (!mounted.current) return
            if (!result.ok) setError(result.error)
            else if (!receivedUpdate && result.data.username === username) setState(result.data)
        }).catch(() => {
            if (mounted.current) setError('无法读取聊天记录。')
        })
            .finally(() => {
                if (mounted.current) setLoading(false)
            })
        return () => {
            mounted.current = false;
            unsubscribe?.()
        }
    }, [username])

    useEffect(() => {
        let active = true
        setSyncing(true)
        setSyncError('')
        const refreshNotices = async () => {
            if (!window.notices) throw new Error('通知服务未加载。')
            const result = await window.notices.list(true)
            if (!result.ok) throw new Error(result.error)
            const failed = result.data.sources.filter(source => source.enabled && source.lastError)
            if (failed.length) throw new Error(`${failed.length} 个通知来源刷新失败，暂使用已有通知。`)
        }
        const refreshTimetable = async () => {
            if (!window.messagePreferences || !window.timetable) throw new Error('课表服务未加载。')
            const preferences = await window.messagePreferences.get()
            if (!active) return
            if (!preferences.ok) throw new Error(preferences.error)
            if (preferences.data.identity !== 'student') return
            const result = await window.timetable.get({refresh: true})
            if (!result.ok) throw new Error(result.error)
        }
        void Promise.allSettled([refreshNotices(), refreshTimetable()]).then(results => {
            if (!active) return
            setSyncError(results.flatMap((result, index) => result.status === 'rejected'
                ? [`${index === 0 ? '通知' : '课表'}刷新未完成：${result.reason instanceof Error ? result.reason.message : '请稍后重试。'}`] : []).join(' '))
            setSyncing(false)
        })
        return () => {
            active = false
        }
    }, [username])

    useEffect(() => {
        if (stickToBottom.current) scroll.current?.scrollTo({top: scroll.current.scrollHeight})
    }, [state, loading])

    useEffect(() => {
        if (!state.sessionId || previousSession.current === state.sessionId) return
        if (previousSession.current) drafts.current.set(previousSession.current, {text: draft, editingTurnId})
        const saved = drafts.current.get(state.sessionId)
        previousSession.current = state.sessionId
        setDraft(saved?.text ?? '')
        setEditingTurnId(saved?.editingTurnId ?? null)
        setTraceTurnId(null)
        setSessionTrace(false)
        setSourceTurnId(null)
        setSelectedSourceId(null)
        setConfirmClear(false)
        setError('')
        stickToBottom.current = true
        scroll.current?.scrollTo({top: scroll.current.scrollHeight})
    }, [state.sessionId])

    useEffect(() => {
        if (!focusSessionId || sending || state.sessionId !== focusSessionId) return
        input.current?.focus()
        setFocusSessionId(null)
    }, [focusSessionId, sending, state.sessionId])

    async function manageSession(action: SessionAction): Promise<boolean> {
        if (!window.chat || loading || sending || decidingRequest || sessionActionLock.current) return false
        if (action.kind === 'select' && action.id === state.sessionId) return true
        sessionActionLock.current = true
        setSending(true)
        setError('')
        const revision = stateRevision.current
        try {
            const result = await (action.kind === 'create' ? window.chat.createSession()
                : action.kind === 'select' ? window.chat.selectSession(action.id)
                    : action.kind === 'rename' ? window.chat.renameSession(action.id, action.title)
                        : window.chat.deleteSession(action.id))
            if (!mounted.current) return false
            if (!result.ok) {
                setError(result.error);
                return false
            }
            if (stateRevision.current === revision) setState(result.data)
            if (action.kind === 'create') setFocusSessionId(result.data.sessionId)
            if (action.kind === 'delete') drafts.current.delete(action.id)
            if ((action.kind === 'create' || action.kind === 'select') && window.matchMedia('(max-width: 1000px)').matches) {
                setHistoryOpen(false)
            }
            return true
        } catch {
            if (mounted.current) setError('对话操作失败，请重试。')
            return false
        } finally {
            sessionActionLock.current = false
            if (mounted.current) setSending(false)
        }
    }

    async function send(event: FormEvent) {
        event.preventDefault()
        const text = draft.trim()
        if (!text || loading || syncing || state.busy || sending || !window.chat) return
        setSending(true);
        setError('');
        setConfirmClear(false);
        stickToBottom.current = true
        try {
            const result = editingTurnId ? await window.chat.retry(editingTurnId, text)
                : await window.chat.send(text, {sourceMode: 'auto'})
            if (!mounted.current) return
            if (!result.ok) setError(result.error)
            else {
                setState(result.data);
                setDraft('');
                setEditingTurnId(null)
            }
        } catch {
            if (mounted.current) setError('发送失败，请重试。')
        } finally {
            if (mounted.current) {
                setSending(false);
                input.current?.focus()
            }
        }
    }

    function startEdit(turn: { id: string; user: string }) {
        setEditingTurnId(turn.id)
        setDraft(turn.user)
        setError('')
        setTimeout(() => input.current?.focus(), 0)
    }

    function cancelEdit() {
        setEditingTurnId(null)
        input.current?.focus()
    }

    async function cancel() {
        try {
            const result = await window.chat?.cancel()
            if (mounted.current && result && !result.ok) setError(result.error)
        } catch {
            if (mounted.current) setError('停止回复失败，请重试。')
        }
    }

    async function clear() {
        if (!window.chat || sending || state.busy) return
        setSending(true)
        try {
            const result = await window.chat.clear()
            if (!mounted.current) return
            if (result.ok) {
                setState(result.data);
                setError('');
                setConfirmClear(false);
                setTraceTurnId(null);
                setSessionTrace(false);
                setEditingTurnId(null);
                setDraft('')
            } else {
                setError(result.error);
                setConfirmClear(false)
            }
        } catch {
            if (mounted.current) {
                setError('清空聊天失败。');
                setConfirmClear(false)
            }
        } finally {
            if (mounted.current) setSending(false)
        }
    }

    async function openCard(card: ChatCard) {
        if (opening) return
        setOpening(true);
        setError('')
        previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
        try {
            if (card.kind === 'notice') {
                const result = await window.notices?.getNotice(card.notice)
                if (!result) throw new Error('通知服务未加载。')
                if (!result.ok) throw new Error(result.error)
                if (mounted.current) onOpenNotice(result.data)
            } else if (card.kind === 'course') {
                const result = await window.timetable?.cached()
                if (!result) throw new Error('课表服务未加载。')
                if (!result.ok) throw new Error(result.error)
                const date = card.occurrence.date
                const item = calendarOccurrences(result.data, [], date, date)
                    .find(item => item.key === card.occurrence.key)
                if (!item) throw new Error('该课程安排已变化，请重新查询日程。')
                if (mounted.current) setEditor(item)
            } else {
                const result = await window.calendar?.list()
                if (!result) throw new Error('日程服务未加载。')
                if (!result.ok) throw new Error(result.error)
                const event = result.data.find(item => item.id === card.event.id)
                if (!event) throw new Error('这条日程已被删除。')
                const item = calendarOccurrences(null, [event], event.startDate, event.startDate)[0]
                if (mounted.current) setEditor(item)
            }
        } catch (error) {
            if (mounted.current) setError(error instanceof Error ? error.message : '无法打开详情。')
        } finally {
            if (mounted.current) setOpening(false)
        }
    }

    async function decideRequest(kind: 'summary' | 'action', turnId: string, requestId: string, allow: boolean) {
        if (!window.chat || state.busy || decidingRequest) return
        setDecidingRequest(true)
        setError('')
        const revision = stateRevision.current
        try {
            const result = await (kind === 'summary' ? window.chat.decideSummary(turnId, requestId, allow)
                : window.chat.decideAction(turnId, requestId, allow))
            if (!mounted.current) return
            if (!result.ok) setError(result.error)
            else if (stateRevision.current === revision) setState(result.data)
        } catch {
            if (mounted.current) setError('无法处理请求，请重试。')
        } finally {
            if (mounted.current) setDecidingRequest(false)
        }
    }

    async function undo(turnId: string, requestId: string) {
        if (!window.chat || state.busy || decidingRequest) return
        setDecidingRequest(true);
        setError('')
        try {
            const result = await window.chat.undo(turnId, requestId)
            if (!mounted.current) return
            if (result.ok) setState(result.data); else setError(result.error)
        } catch {
            if (mounted.current) setError('无法撤销操作，请重试。')
        } finally {
            if (mounted.current) setDecidingRequest(false)
        }
    }

    function openTrace(turnId: string) {
        traceTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
        setSessionTrace(false)
        setTraceTurnId(turnId)
    }

    function closeTrace() {
        setTraceTurnId(null);
        traceTrigger.current?.focus()
    }

    function closeEditor() {
        setEditor(null);
        previousFocus.current?.focus()
    }

    async function refreshCards() {
        closeEditor()
        try {
            const result = await window.chat?.get()
            if (mounted.current && result?.ok) setState(result.data)
        } catch {
            if (mounted.current) setError('日程已更新，聊天卡片刷新失败。')
        }
    }

    const busy = state.busy || sending
    const lastTurnId = state.turns.at(-1)?.id
    const streaming = (id: string) => busy && id === lastTurnId
    const traced = state.turns.find(turn => turn.id === traceTurnId)
    return <section className="chat-workspace" aria-label="聊天">
        {historyOpen && <ChatHistory sessions={state.sessions} selectedId={state.sessionId}
                                     disabled={loading || sending || decidingRequest} onAction={manageSession}
                                     onClose={() => setHistoryOpen(false)}/>}
        <div className="chat-page">
            <header className="chat-header">
                <button type="button" className="icon-button" aria-label="历史对话" title="历史对话"
                        aria-controls="chat-history" aria-expanded={historyOpen}
                        onClick={() => setHistoryOpen(value => !value)}><Icon name="menu"/></button>
                <strong className="chat-current-title"
                        title={state.sessions.find(item => item.id === state.sessionId)?.title}>
                    {state.sessions.find(item => item.id === state.sessionId)?.title ?? '新对话'}</strong>
                {!historyOpen && <button type="button" className="icon-button" aria-label="新对话" title="新对话"
                                         disabled={loading || sending || decidingRequest}
                                         onClick={() => void manageSession({kind: 'create'})}><Icon name="chat-plus"/>
                </button>}
                <ChatMenu label="当前对话选项" items={[
                    {
                        label: sessionTrace ? '收起会话轨迹' : '会话轨迹', icon: 'panel', disabled: !state.turns.length,
                        onSelect: () => {
                            setTraceTurnId(null);
                            setSessionTrace(value => !value)
                        }
                    },
                    {
                        label: '清空聊天', icon: 'clean', danger: true,
                        disabled: busy || decidingRequest || state.sessions.find(item => item.id === state.sessionId)?.busy || !state.turns.length,
                        onSelect: () => setConfirmClear(true)
                    },
                    {label: 'LLM 设置', icon: 'settings', onSelect: onSettings}
                ]}/>
            </header>
            {confirmClear && <ConfirmDialog title="清空聊天记录"
                                            message="是否清空当前对话的聊天记录？其他对话不受影响。"
                                            confirmLabel="清空" danger busy={sending}
                                            onConfirm={() => void clear()}
                                            onCancel={() => setConfirmClear(false)}/>}
            <div className="chat-messages" ref={scroll} onScroll={() => {
                const element = scroll.current
                if (element) stickToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80
            }}>
                <div className="chat-thread">
                    {loading ? <p className="chat-status" role="status">正在读取聊天记录…</p> : !state.turns.length &&
                        <div className="chat-welcome"><span className="chat-welcome-icon"><Icon name="chat"/></span>
                            <h2>有什么可以帮你？</h2>
                            <div className="chat-suggestions">{suggestions.map(text => <button type="button" key={text}
                                                                                               onClick={() => {
                                                                                                   setDraft(text);
                                                                                                   input.current?.focus()
                                                                                               }}>{text}<Icon
                                name="chevron"/></button>)}</div>
                        </div>}
                    {state.turns.map(turn => <div className="chat-turn" key={turn.id}
                                                  data-streaming={streaming(turn.id) || undefined}>
                        <article className="chat-user" aria-label="我的消息">{turn.user}</article>
                        <div className="chat-message-actions chat-user-actions">
                            <CopyButton text={turn.user} label="复制这条消息"/>
                            {turn.error && turn.id === state.turns.at(-1)?.id && !busy &&
                                <button type="button" className="chat-message-action"
                                        onClick={() => startEdit(turn)}>编辑并重发</button>}
                        </div>
                        <article className="chat-assistant" aria-label="助手回复">
                            <TurnActivity trace={turn.trace} stage={streaming(turn.id) ? state.status : ''}
                                          busy={streaming(turn.id)}/>
                            {turn.reply &&
                                <div className="chat-markdown"><Markdown remarkPlugins={[remarkGfm, remarkBreaks]}
                                                                         components={{
                                                                             a: ({href, children}) => {
                                                                                 const id = href?.match(/^#citation-([WC]\d+)$/)?.[1]
                                                                                 if (id) {
                                                                                     const exists = sourcesFor(turn).some(source => source.id === id)
                                                                                     return exists
                                                                                         ? <button type="button"
                                                                                                   className="chat-citation"
                                                                                                   aria-label={`查看来源 #${sourceDisplayId(id)}`}
                                                                                                   onClick={() => {
                                                                                                       setSourceTurnId(turn.id)
                                                                                                       setSelectedSourceId(id)
                                                                                                   }}>{children}</button>
                                                                                         : <span>{children}</span>
                                                                                 }
                                                                                 return <span>{children}</span>
                                                                             },
                                                                             img: ({alt}) => <span>{alt}</span>
                                                                         }}>{linkCitations(turn.reply)}</Markdown>
                                </div>}
                            {!!turn.cards.length && <div className="chat-cards">{turn.cards.map(card => {
                                const notice = card.kind === 'notice' ? card.notice : null
                                const event = card.kind === 'event' ? card.event : null
                                const course = card.kind === 'course' ? card.occurrence : null
                                const deleted = card.kind === 'event' && card.deleted
                                return <button type="button" className="chat-card"
                                               key={notice ? `${notice.sourceId}:${notice.url}` : course?.key ?? event!.id}
                                               disabled={opening || deleted} onClick={() => void openCard(card)}>
                                    <Icon name={notice ? 'notices' : course ? 'book' : 'calendar'}/><span>
                                    <small>{notice ? `${notice.sourceName} · ${notice.published}` :
                                        course ? `${course.date} ${timeLabel(course.startMinute)} — ${timeLabel(course.endMinute)} · 课程` :
                                            `${event!.startDate} ${event!.allDay ? '全天' : event!.startTime} — ${event!.endDate} ${event!.allDay ? '' : event!.endTime}`}</small>
                                    <strong>{notice?.title ?? course?.title ?? event!.title}</strong>
                                    {notice?.relevance &&
                                        <em>{notice.relevance === 'related' ? '@与我有关' : '@可能有关'}</em>}
                                    {event?.location && <small>{event.location}</small>}
                                    {course?.location && <small>{course.location}</small>}
                                    {deleted && <small>已删除</small>}
                                </span><Icon name="chevron"/>
                                </button>
                            })}</div>}
                            {!!turn.summaryRequests?.length && <div className="chat-summary-requests">
                                {turn.summaryRequests.map(request => <ChatSummaryRequestCard key={request.id}
                                                                                             request={request}
                                                                                             disabled={state.busy || sending || decidingRequest}
                                                                                             onDecide={allow => void decideRequest('summary', turn.id, request.id, allow)}
                                                                                             onOpen={() => void openCard({
                                                                                                 kind: 'notice',
                                                                                                 notice: request.notice
                                                                                             })}/>)}
                            </div>}
                            {!!turn.actionRequests?.length && <div className="chat-summary-requests">
                                {turn.actionRequests.map(request => <ChatActionRequestCard key={request.id}
                                                                                           request={request}
                                                                                           disabled={state.busy || sending || decidingRequest}
                                                                                           onDecide={allow => void decideRequest('action', turn.id, request.id, allow)}
                                                                                           onUndo={() => void undo(turn.id, request.id)}/>)}
                            </div>}
                            {sourceTurnId === turn.id &&
                                <SourcesPanel sources={sourcesFor(turn)} selected={selectedSourceId}
                                              onClearSelection={() => setSelectedSourceId(null)}
                                              onClose={() => {
                                                  setSourceTurnId(null)
                                                  setSelectedSourceId(null)
                                              }}/>}
                            {!!turn.warnings?.length &&
                                <p className="chat-notice">{[...new Set(turn.warnings)].join(' ')}</p>}
                            {turn.endReason === 'budget' &&
                                <p className="chat-notice">本轮已达到处理时限，仍有未核实的信息。</p>}
                            {(turn.startedAt || turn.reply) && <div className="turn-meta">
                                {turn.startedAt && <time
                                    dateTime={turn.startedAt}>{new Date(turn.startedAt).toLocaleTimeString('zh-CN', {
                                    hour: '2-digit', minute: '2-digit', hour12: false
                                })}</time>}
                                {turn.startedAt && turn.finishedAt && <><i className="turn-meta-dot"
                                                                           aria-hidden="true"/>
                                    <span>{((Date.parse(turn.finishedAt) - Date.parse(turn.startedAt)) / 1000).toFixed(1)}s</span></>}
                                {turn.reply && <CopyButton text={turn.reply} label="复制回复"/>}
                                {!!sourcesFor(turn).length && <button type="button"
                                                                      className="chat-message-action chat-message-icon"
                                                                      aria-label={`查看来源（${sourcesFor(turn).length}）`}
                                                                      title={`查看来源（${sourcesFor(turn).length}）`}
                                                                      aria-expanded={sourceTurnId === turn.id}
                                                                      onClick={() => toggleSources(turn.id)}>
                                    <Icon name="search"/>
                                </button>}
                                {turn.startedAt && <button type="button" className="icon-button turn-meta-button"
                                                           aria-label="查看执行记录"
                                                           title="查看执行记录" aria-controls="chat-trace-panel"
                                                           aria-expanded={traceTurnId === turn.id}
                                                           onClick={() => traceTurnId === turn.id ? closeTrace() : openTrace(turn.id)}>
                                    <Icon
                                        name="panel"/></button>}
                            </div>}
                            {turn.error && <p className="chat-error" role="alert">{turn.error}</p>}
                        </article>
                    </div>)}
                </div>
            </div>
            <footer className="chat-footer">
                <ChatStatusBar stats={state.turns.length || state.busy ? state.stats : undefined}/>
                {syncing && <p className="chat-status" role="status">正在刷新通知和课表…</p>}
                {syncError && <p className="chat-error" role="alert">{syncError}</p>}
                {error && <p className="chat-error" role="alert">{error}</p>}
                {editingTurnId && <div className="chat-edit-hint" role="status">
                    <span>正在编辑最近一条失败消息，发送后会替换它。</span>
                    <button type="button" className="secondary-button" onClick={cancelEdit}>取消编辑</button>
                </div>}
                <form className="chat-composer" onSubmit={event => void send(event)}>
                <textarea ref={input} value={draft} maxLength={8000} rows={2} aria-label="聊天消息"
                          placeholder="发送消息…"
                          onChange={event => setDraft(event.target.value)} onKeyDown={event => {
                    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                        event.preventDefault();
                        if (!busy) event.currentTarget.form?.requestSubmit()
                    }
                }}/>
                    <div className="chat-composer-actions">
                        {state.busy ?
                            <button type="button" className="icon-button" title="停止回复" aria-label="停止回复"
                                    onClick={() => void cancel()}><Icon name="stop"/></button> :
                            <button type="submit" className="icon-button chat-send"
                                    title={editingTurnId ? '重新发送' : '发送'}
                                    aria-label={editingTurnId ? '重新发送' : '发送'}
                                    disabled={busy || loading || syncing || !draft.trim()}><Icon name="send"/></button>}
                    </div>
                </form>
            </footer>
            {editor && <CalendarEventDialog date={editor.date} item={editor} create={false} onClose={closeEditor}
                                            onSaved={() => void refreshCards()} onRemoved={() => void refreshCards()}/>}
        </div>
        {traced && <ChatTracePanel key={traced.id} turn={traced} onClose={closeTrace}/>}
        {sessionTrace && <ChatSessionTracePanel onClose={() => setSessionTrace(false)}/>}</section>
}

function SourcesPanel({sources, selected, onClose, onClearSelection}: {
    sources: ResearchSource[]
    selected: string | null
    onClose: () => void
    onClearSelection: () => void
}) {
    const cards = useRef(new Map<string, HTMLElement>())
    useEffect(() => {
        if (!selected) return
        const card = cards.current.get(selected)
        if (!card) return
        card.scrollIntoView({block: 'nearest'})
        card.focus({preventScroll: true})
    }, [selected])
    useEffect(() => {
        if (!selected) return
        const clear = (event: PointerEvent) => {
            if (event.target instanceof Element && event.target.closest('.chat-source')) return
            onClearSelection()
        }
        document.addEventListener('pointerdown', clear)
        return () => document.removeEventListener('pointerdown', clear)
    }, [selected, onClearSelection])
    return <section className="chat-sources" aria-label="回答来源">
        <div className="chat-sources-heading">
            <strong><Icon name="search"/>来源</strong>
            <button type="button" className="icon-button" title="关闭来源" aria-label="关闭来源" onClick={onClose}>
                <Icon name="close"/>
            </button>
        </div>
        <div className="chat-source-list">
            {sources.map(source => <article key={source.id} tabIndex={-1}
                                            ref={node => {
                                                if (node) cards.current.set(source.id, node)
                                                else cards.current.delete(source.id)
                                            }}
                                            className={`chat-source${selected === source.id ? ' is-selected' : ''}`}>
                <div className="chat-source-meta">
                    <span>#{sourceDisplayId(source.id)}{source.source === 'web' ? ' · 公开网页' : ''}</span>
                    <span className="chat-source-origin">{source.source === 'campus'
                        ? `洞号 #${source.holeId} 楼层号 #${source.floorId}`
                        : source.publishedAt ?? '日期未知'}</span>
                </div>
                {source.source === 'web' && source.url && <button type="button" className="chat-source-title"
                                                                  onClick={() => void window.chat?.openSource(source.url!)}>
                    {source.title}<Icon name="external"/>
                </button>}
                <p>{source.snippet}</p>
                {source.source === 'web'
                    ?
                    <small>{source.pageRead ? '已读取正文' : '搜索摘要'}{source.truncated ? ' · 内容已截断' : ''}</small>
                    : source.truncated && <small>内容已截断</small>}
            </article>)}
        </div>
    </section>
}
