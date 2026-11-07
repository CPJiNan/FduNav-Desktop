import {useEffect, useRef, useState} from 'react'
import type {ChatTurn} from '../../shared/chat'
import type {ChatTraceEvent} from '../../shared/agent'
import {TracePayload, downloadJson} from './TracePayload'

const statusLabels = {running: '进行中', completed: '完成', failed: '失败', cancelled: '已停止'}
export {downloadJson}
export function ChatTracePanel({turn, onClose}: {turn: ChatTurn; onClose: () => void}) {
    const [events, setEvents] = useState<ChatTraceEvent[]>([])
    const [error, setError] = useState('')
    const [filter, setFilter] = useState('all')
    const [loading, setLoading] = useState(true)
    const [reload, setReload] = useState(0)
    const close = useRef<HTMLButtonElement>(null)
    const revision = (turn.trace ?? []).map(item => `${item.id}:${item.status}`).join('|')
    useEffect(() => {close.current?.focus()}, [])
    useEffect(() => {
        if (!window.chat) {setError('聊天服务未加载，请重启应用。'); setLoading(false); return}
        let active = true
        setError(''); setLoading(true)
        void window.chat?.trace(turn.id).then(result => {
            if (!active) return
            if (result.ok) {setEvents(result.data); setError('')}
            else setError(result.error)
        }).catch(() => {if (active) setError('无法读取执行记录，请重试。')})
            .finally(() => {if (active) setLoading(false)})
        return () => {active = false}
    }, [turn.id, revision, reload])
    const shown = events.filter(item => filter === 'all' || (filter === 'failed' ? item.status === 'failed' || item.status === 'cancelled' : item.kind === 'tool'))
    return <aside id="chat-trace-panel" className="chat-trace" aria-label="执行记录" onKeyDown={event => {
        if (event.key === 'Escape') {event.stopPropagation(); onClose()}
    }}>
        <header><div><h2>执行记录</h2><p>本轮 {events.length} 个步骤</p></div>
            <button type="button" ref={close} className="secondary-button" onClick={onClose} aria-label="关闭执行记录">关闭</button></header>
        <p className="trace-question">{turn.user}</p>
        <p className="trace-help">查看实际调用、工具原始响应与发送给模型的结果。这里不包含模型的隐藏思考。导出文件可能包含个人信息。</p>
        <div className="trace-toolbar">
            <label>筛选 <select value={filter} onChange={event => setFilter(event.target.value)}>
                <option value="all">全部步骤</option><option value="tool">工具调用</option><option value="failed">失败与停止</option>
            </select></label>
            <button type="button" className="secondary-button" disabled={loading || !!error || !events.length}
                    onClick={() => downloadJson({version: 1, turnId: turn.id, user: turn.user, events}, `fdunav-trace-${turn.id}.json`)}>导出 JSON</button>
        </div>
        {error && <div role="alert"><p className="chat-error">{error}</p><button type="button" className="secondary-button" onClick={() => setReload(value => value + 1)}>重试</button></div>}
        {!events.length && <p role="status">{loading ? '正在读取…' : '这条历史消息没有执行记录。新消息会自动记录。'}</p>}
        <ol className="trace-events">{shown.map((item, index) => <li key={item.id} data-status={item.status}>
            <div className="trace-step"><span>{String(index + 1).padStart(2, '0')}</span><strong>{item.label}</strong>
                <small>{statusLabels[item.status]}</small></div>
            <p className="trace-time"><time dateTime={item.at}>{new Date(item.at).toLocaleTimeString('zh-CN', {hour12: false})}</time>
                {item.elapsedMs !== undefined && ` · ${(item.elapsedMs / 1000).toFixed(2)} 秒`}</p>
            {item.details !== undefined && <details><summary>参数与响应</summary>
                <TracePayload value={item.details} filename={`fdunav-trace-${turn.id}-${item.id}.json`} /></details>}
        </li>)}</ol>
        {!!events.length && !shown.length && <p role="status">没有符合筛选条件的步骤。</p>}
    </aside>
}
