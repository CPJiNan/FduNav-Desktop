import {useEffect, useState} from 'react'
import type {ChatTraceEvent} from '../../shared/agent'
import {Icon} from './Icon'

interface TurnActivityProps {
    trace?: ChatTraceEvent[]
    stage?: string
    busy: boolean
}

const activityKinds = new Set<ChatTraceEvent['kind']>(['tool', 'compaction', 'retry'])

function stepIcon(status: ChatTraceEvent['status']) {
    if (status === 'running') return <span className="turn-spin" aria-hidden="true"/>
    if (status === 'failed' || status === 'cancelled') return <span className="turn-cross" aria-hidden="true">✕</span>
    return <span className="turn-tick" aria-hidden="true">✓</span>
}

function seconds(elapsedMs?: number) {
    return elapsedMs !== undefined && elapsedMs >= 50 ? `${(elapsedMs / 1000).toFixed(1)}s` : ''
}

export function TurnActivity({trace, stage, busy}: TurnActivityProps) {
    const steps = (trace ?? []).filter(item => activityKinds.has(item.kind))
    const rows = steps.slice(-6)
    const hidden = steps.length - rows.length
    const hasRunning = steps.some(item => item.status === 'running')
    const stageLabel = busy && !hasRunning ? (stage || '正在处理') : ''
    const [expanded, setExpanded] = useState(busy)

    useEffect(() => {
        setExpanded(busy)
    }, [busy])

    if (!steps.length && !stageLabel) return null
    const showList = busy || expanded
    return <div className="turn-activity">
        {!busy && steps.length > 0 && <button type="button" className="turn-summary" data-expanded={expanded}
                                              aria-expanded={expanded}
                                              onClick={() => setExpanded(value => !value)}>
            <Icon name="chevron"/>{expanded ? '收起' : `${steps.length} 步`}
        </button>}
        {showList && <ol className="turn-steps">
            {rows.map(item => <li key={item.id} className="turn-step" data-state={item.status}>
                {stepIcon(item.status)}
                <span className="turn-step-name">{item.label}</span>
                <span className="turn-step-time">{seconds(item.elapsedMs)}</span>
            </li>)}
            {hidden > 0 && <li className="turn-step-more">还有 {hidden} 步，见执行记录</li>}
            {stageLabel && <li className="turn-step" data-state="running" role="status" aria-live="polite">
                <span className="turn-spin" aria-hidden="true"/>
                <span className="turn-step-name">{stageLabel}</span>
                <span className="turn-step-time"/>
            </li>}
        </ol>}
    </div>
}
