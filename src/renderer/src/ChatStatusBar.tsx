import {useEffect, useState} from 'react'
import type {ChatStats} from '../../shared/chat'

function compact(value: number): string {
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
    if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
    return String(value)
}

function seconds(ms: number): string {
    return `${(ms / 1000).toFixed(1)}s`
}

/** Session counters and the live agent stage, in the style of a terminal status line. */
export function ChatStatusBar({stats, busy, status}: {stats?: ChatStats; busy: boolean; status: string}) {
    const [now, setNow] = useState(() => Date.now())
    const [base, setBase] = useState({elapsed: 0, at: Date.now()})

    useEffect(() => {
        if (!busy) return
        const timer = window.setInterval(() => setNow(Date.now()), 500)
        return () => window.clearInterval(timer)
    }, [busy])

    useEffect(() => {
        setBase({elapsed: stats?.turnElapsedMs ?? 0, at: Date.now()})
    }, [stats?.turnElapsedMs])

    if (!stats || !stats.requests) return null
    const tokens = stats.promptTokens + stats.completionTokens
    const elapsed = busy ? Math.max(0, base.elapsed + (now - base.at)) : 0
    const cache = stats.cacheHitRate === null ? null : Math.round(stats.cacheHitRate * 1000) / 10

    return <div className="chat-status-bar" role="status" aria-live="polite">
        <span className="chat-stat" title="对话轮次 · 工具调用步数 · 平均吞吐">
            <span className="chat-stat-icon" aria-hidden="true">◷</span>
            {stats.turns} 轮 · {stats.steps} 步
            {stats.tokensPerSecond ? ` · ${stats.tokensPerSecond} tok/s` : ''}
        </span>
        <span className="chat-stat" title="本账号累计 token 与提示缓存命中率">
            <span className="chat-stat-icon" aria-hidden="true">⛁</span>
            {compact(tokens)} tok
            {cache !== null && ` · 缓存命中 ${cache}%`}
        </span>
        <span className="chat-stat chat-stat-meter" title="最近一次请求的上下文占用，按 32k token 估算">
            <span className="chat-meter" aria-hidden="true">
                <span className="chat-meter-fill" style={{width: `${Math.max(2, stats.contextPercent)}%`}}/>
            </span>
            {stats.contextPercent}%
        </span>
        {busy && <span className="chat-live">
            <span className="chat-live-dot" aria-hidden="true"/>
            <span className="chat-live-label">{status || '正在思考'}</span>
            {elapsed > 0 && <span className="chat-live-time">{seconds(elapsed)}</span>}
        </span>}
    </div>
}
