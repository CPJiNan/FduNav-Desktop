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

    const empty: ChatStats = {
        turns: 0, steps: 0, requests: 0, promptTokens: 0, completionTokens: 0, cacheHitTokens: 0,
        elapsedMs: 0, lastPromptTokens: 0, cacheHitRate: null, tokensPerSecond: null, turnElapsedMs: 0
    }
    const data = stats ?? empty
    const tokens = data.promptTokens + data.completionTokens
    const elapsed = busy ? Math.max(0, base.elapsed + (now - base.at)) : 0
    const cache = data.cacheHitRate === null ? null : Math.round(data.cacheHitRate * 1000) / 10

    return <div className="chat-status-bar" role="status" aria-live="polite">
        <span className="chat-stat" title="对话轮次 · 工具调用步数 · 平均吞吐">
            <span className="chat-stat-icon" aria-hidden="true">◷</span>
            {data.turns} 轮 · {data.steps} 步
            {data.tokensPerSecond ? ` · ${data.tokensPerSecond} tok/s` : ''}
        </span>
        <span className="chat-stat" title="本账号累计 token 与提示缓存命中率">
            <span className="chat-stat-icon" aria-hidden="true">⛁</span>
            {compact(tokens)} tok
            {cache !== null && ` · 缓存命中 ${cache}%`}
        </span>
        <span className="chat-stat" title="最近一次请求发送的上下文 token 数">
            <span className="chat-stat-icon" aria-hidden="true">▤</span>
            上下文 {compact(data.lastPromptTokens)}
        </span>
        {busy && <span className="chat-live">
            <span className="chat-live-dot" aria-hidden="true"/>
            <span className="chat-live-label">{status || '正在思考'}</span>
            {elapsed > 0 && <span className="chat-live-time">{seconds(elapsed)}</span>}
        </span>}
    </div>
}
