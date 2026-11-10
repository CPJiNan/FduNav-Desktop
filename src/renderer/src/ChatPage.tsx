import {type FormEvent, useEffect, useRef, useState} from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import type {ChatCard, ChatPushState, ChatState} from '../../shared/chat'
import type {Notice} from '../../shared/notices'
import {type CalendarOccurrence, calendarOccurrences, timeLabel} from '../../shared/calendar'
import {CalendarEventDialog} from './CalendarEventDialog'
import {Icon} from './Icon'
import {ChatSummaryRequestCard} from './ChatSummaryRequestCard'
import {ChatActionRequestCard} from './ChatActionRequestCard'
import {ChatTracePanel} from './ChatTracePanel'
import {ChatSessionTracePanel} from './ChatSessionTracePanel'
import {ChatStatusBar} from './ChatStatusBar'
import {CopyButton} from './MessageActions'
import {TurnActivity} from './TurnActivity'
import './styles/chat.css'
import './styles/calendar.css'

const suggestions = ['本周通知摘要', '查询今天日程', '新增待办事项']

/** Delta pushes carry only the running turn; merge them into the previous state. */
function mergeState(previous: ChatState, value: ChatPushState): ChatState {
    if (value.full) return value
    const turns = previous.username === value.username ? [...previous.turns] : []
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
    const [state, setState] = useState<ChatState>({username, turns: [], busy: false, status: ''})
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
    const traceTrigger = useRef<HTMLElement | null>(null)
    const [editor, setEditor] = useState<CalendarOccurrence | null>(null)
    const scroll = useRef<HTMLDivElement>(null)
    const input = useRef<HTMLTextAreaElement>(null)
    const mounted = useRef(true)
    const stickToBottom = useRef(true)
    const previousFocus = useRef<HTMLElement | null>(null)
    const stateRevision = useRef(0)

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

    async function send(event: FormEvent) {
        event.preventDefault()
        const text = draft.trim()
        if (!text || loading || syncing || state.busy || sending || !window.chat) return
        setSending(true);
        setError('');
        setConfirmClear(false);
        stickToBottom.current = true
        try {
            // While editing a failed turn, re-send it instead of appending a new message.
            const result = editingTurnId ? await window.chat.retry(editingTurnId, text) : await window.chat.send(text)
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

    /** Put a failed message back into the composer so it can be fixed and resent. */
    function startEdit(turn: {id: string; user: string}) {
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
                setTraceTurnId(null); setSessionTrace(false); setEditingTurnId(null); setDraft('')
            } else setError(result.error)
        } catch {
            if (mounted.current) setError('清空聊天失败。')
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
        setDecidingRequest(true); setError('')
        try {
            const result = await window.chat.undo(turnId, requestId)
            if (!mounted.current) return
            if (result.ok) setState(result.data); else setError(result.error)
        } catch {if (mounted.current) setError('无法撤销操作，请重试。')}
        finally {if (mounted.current) setDecidingRequest(false)}
    }
    function openTrace(turnId: string) {
        traceTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
        setSessionTrace(false)
        setTraceTurnId(turnId)
    }
    function closeTrace() {setTraceTurnId(null); traceTrigger.current?.focus()}

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
    return <section className="chat-workspace" aria-label="聊天"><div className="chat-page">
        <header className="chat-header">
            <button type="button" className="icon-button" aria-label="会话轨迹" title="会话轨迹"
                    aria-controls="chat-session-trace" aria-expanded={sessionTrace} disabled={!state.turns.length}
                    onClick={() => {setTraceTurnId(null); setSessionTrace(value => !value)}}><Icon name="panel"/></button>
            {confirmClear ? <div className="chat-clear-confirm"><span>清空聊天记录？</span>
                    <button type="button" className="secondary-button" disabled={busy} onClick={() => void clear()}>清空
                    </button>
                    <button type="button" className="secondary-button" onClick={() => setConfirmClear(false)}>取消</button>
                </div> :
                <button type="button" className="icon-button" aria-label="清空聊天" title="清空聊天"
                        disabled={busy || !state.turns.length}
                        onClick={() => setConfirmClear(true)}><Icon name="clean"/></button>}
            <button type="button" className="icon-button" aria-label="LLM 设置" title="LLM 设置"
                    onClick={onSettings}><Icon name="settings"/></button>
        </header>
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
                            <button type="button" className="chat-message-action" onClick={() => startEdit(turn)}>编辑并重发</button>}
                    </div>
                    <article className="chat-assistant" aria-label="助手回复">
                        <TurnActivity trace={turn.trace} stage={streaming(turn.id) ? state.status : ''}
                                      busy={streaming(turn.id)}/>
                        {turn.reply &&
                            <div className="chat-markdown"><Markdown remarkPlugins={[remarkGfm, remarkBreaks]}
                                                                     components={{
                                                                         a: ({children}) => <span>{children}</span>,
                                                                         img: ({alt}) => <span>{alt}</span>
                                                                     }}>{turn.reply}</Markdown></div>}
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
                                                                                       onUndo={() => void undo(turn.id, request.id)} onManageMemory={onSettings}/>)}
                        </div>}
                        {turn.startedAt && <div className="turn-meta">
                            <time dateTime={turn.startedAt}>{new Date(turn.startedAt).toLocaleTimeString('zh-CN', {
                                hour: '2-digit', minute: '2-digit', hour12: false
                            })}</time>
                            {turn.finishedAt && <><i className="turn-meta-dot" aria-hidden="true"/>
                                <span>{((Date.parse(turn.finishedAt) - Date.parse(turn.startedAt)) / 1000).toFixed(1)}s</span></>}
                            <button type="button" className="icon-button turn-meta-button" aria-label="查看执行记录"
                                    title="查看执行记录" aria-controls="chat-trace-panel"
                                    onClick={() => openTrace(turn.id)}><Icon name="panel"/></button>
                        </div>}
                        {turn.error && <p className="chat-error" role="alert">{turn.error}</p>}
                        {turn.reply && <div className="chat-message-actions chat-assistant-actions">
                            <CopyButton text={turn.reply} label="复制回复"/>
                        </div>}
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
                    {state.busy ? <button type="button" className="icon-button" title="停止回复" aria-label="停止回复"
                                          onClick={() => void cancel()}><Icon name="stop"/></button> :
                        <button type="submit" className="icon-button chat-send" title={editingTurnId ? '重新发送' : '发送'}
                                aria-label={editingTurnId ? '重新发送' : '发送'}
                                disabled={busy || loading || syncing || !draft.trim()}><Icon name="send"/></button>}
                </div>
            </form>
        </footer>
        {editor && <CalendarEventDialog date={editor.date} item={editor} create={false} onClose={closeEditor}
                                        onSaved={() => void refreshCards()} onRemoved={() => void refreshCards()}/>}
    </div>{traced && <ChatTracePanel key={traced.id} turn={traced} onClose={closeTrace}/>}
        {sessionTrace && <ChatSessionTracePanel onClose={() => setSessionTrace(false)}/>}</section>
}
