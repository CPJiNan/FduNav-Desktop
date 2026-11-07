import {type FormEvent, useEffect, useRef, useState} from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import type {ChatCard, ChatState} from '../../shared/chat'
import type {Notice} from '../../shared/notices'
import {type CalendarOccurrence, calendarOccurrences, timeLabel} from '../../shared/calendar'
import {CalendarEventDialog} from './CalendarEventDialog'
import {Icon} from './Icon'
import {ChatSummaryRequestCard} from './ChatSummaryRequestCard'
import {ChatActionRequestCard} from './ChatActionRequestCard'
import {ChatTracePanel} from './ChatTracePanel'
import {ChatStatusBar} from './ChatStatusBar'
import './styles/chat.css'
import './styles/calendar.css'

const suggestions = ['本周通知摘要', '查询今天日程', '新增待办事项']

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
            setState(value)
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
            const result = await window.chat.send(text)
            if (!mounted.current) return
            if (!result.ok) setError(result.error)
            else {
                setState(result.data);
                setDraft('')
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
                setConfirmClear(false)
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
    const traced = state.turns.find(turn => turn.id === traceTurnId)
    return <section className="chat-workspace" aria-label="聊天"><div className="chat-page">
        <header className="chat-header">
            <button type="button" className="secondary-button" disabled={!state.turns.length} aria-controls="chat-trace" aria-expanded={!!traced}
                onClick={() => traced ? closeTrace() : openTrace(state.turns.at(-1)!.id)}>执行记录</button>
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
                {state.turns.map(turn => <div className="chat-turn" key={turn.id}>
                    <article className="chat-user" aria-label="我的消息">{turn.user}</article>
                    <article className="chat-assistant" aria-label="助手回复">
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
                        <button type="button" className="trace-turn-button" aria-controls="chat-trace"
                            aria-expanded={traceTurnId === turn.id} onClick={() => openTrace(turn.id)}>查看执行记录 · {turn.trace?.length ?? 0} 步</button>
                        {turn.error && <p className="chat-error" role="alert">{turn.error}</p>}
                    </article>
                </div>)}
            </div>
        </div>
        <footer className="chat-footer">
            <ChatStatusBar stats={state.stats} busy={state.busy} status={state.status}/>
            {syncing && <p className="chat-status" role="status">正在刷新通知和课表…</p>}
            {syncError && <p className="chat-error" role="alert">{syncError}</p>}
            {error && <p className="chat-error" role="alert">{error}</p>}
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
                        <button type="submit" className="icon-button chat-send" title="发送" aria-label="发送"
                                disabled={busy || loading || syncing || !draft.trim()}><Icon name="send"/></button>}
                </div>
            </form>
        </footer>
        {editor && <CalendarEventDialog date={editor.date} item={editor} create={false} onClose={closeEditor}
                                        onSaved={() => void refreshCards()} onRemoved={() => void refreshCards()}/>}
    </div>{traced && <ChatTracePanel key={traced.id} turn={traced} onClose={closeTrace}/>}</section>
}
