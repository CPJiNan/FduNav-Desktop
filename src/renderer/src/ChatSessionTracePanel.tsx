import {useEffect, useRef, useState} from 'react'
import type {SessionTraceTurn} from '../../shared/chat'

const statusLabels = {running: '进行中', completed: '完成', failed: '失败', cancelled: '已停止'}

/** Whole-conversation trace: every retained turn and its steps, newest last. */
export function ChatSessionTracePanel({onClose}: {onClose: () => void}) {
    const [turns, setTurns] = useState<SessionTraceTurn[]>([])
    const [error, setError] = useState('')
    const [loading, setLoading] = useState(true)
    const [reload, setReload] = useState(0)
    const close = useRef<HTMLButtonElement>(null)
    useEffect(() => {close.current?.focus()}, [])
    useEffect(() => {
        if (!window.chat) {setError('聊天服务未加载，请重启应用。'); setLoading(false); return}
        let active = true
        setLoading(true); setError('')
        void window.chat.sessionTrace().then(result => {
            if (!active) return
            if (result.ok) setTurns(result.data); else setError(result.error)
        }).catch(() => {if (active) setError('无法读取会话轨迹，请重试。')})
            .finally(() => {if (active) setLoading(false)})
        return () => {active = false}
    }, [reload])
    const steps = turns.reduce((total, turn) => total + turn.events.length, 0)
    return <aside id="chat-trace" className="chat-trace" aria-label="会话轨迹" onKeyDown={event => {
        if (event.key === 'Escape') {event.stopPropagation(); onClose()}
    }}>
        <header><div><h2>会话轨迹</h2><p>{turns.length} 轮 · {steps} 步</p></div>
            <button type="button" ref={close} className="secondary-button" onClick={onClose} aria-label="关闭会话轨迹">关闭</button></header>
        <p className="trace-help">从对话开始至今的全部轮次，包含每轮的工具调用与模型请求。压缩只影响发给模型的上下文，不会删除这里的记录。</p>
        {error && <div role="alert"><p className="chat-error">{error}</p>
            <button type="button" className="secondary-button" onClick={() => setReload(value => value + 1)}>重试</button></div>}
        {loading && <p role="status">正在读取…</p>}
        {!loading && !error && !turns.length && <p role="status">还没有可显示的执行记录。</p>}
        <ol className="trace-sessions">{turns.map((turn, index) => <li key={turn.turnId}>
            <details>
                <summary>
                    <span className="trace-session-index">{String(index + 1).padStart(2, '0')}</span>
                    <span className="trace-session-question">{turn.user}</span>
                    <small>{turn.events.length} 步</small>
                </summary>
                <ol className="trace-events">{turn.events.map((item, position) => <li key={item.id} data-status={item.status}>
                    <div className="trace-step"><span>{String(position + 1).padStart(2, '0')}</span><strong>{item.label}</strong>
                        <small>{statusLabels[item.status]}</small></div>
                    <p className="trace-time"><time dateTime={item.at}>{new Date(item.at).toLocaleTimeString('zh-CN', {hour12: false})}</time>
                        {item.elapsedMs !== undefined && ` · ${(item.elapsedMs / 1000).toFixed(2)} 秒`}</p>
                    {item.details !== undefined && <details><summary>参数与响应</summary>
                        <pre tabIndex={0}>{JSON.stringify(item.details, null, 2)}</pre></details>}
                </li>)}</ol>
            </details>
        </li>)}</ol>
    </aside>
}
