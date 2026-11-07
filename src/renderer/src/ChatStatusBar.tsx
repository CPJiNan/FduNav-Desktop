import type {ChatStats} from '../../shared/chat'

function compact(value: number): string {
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
    if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
    return String(value)
}

const empty: ChatStats = {
    turns: 0, steps: 0, requests: 0, promptTokens: 0, completionTokens: 0, cacheHitTokens: 0,
    elapsedMs: 0, lastPromptTokens: 0, cacheHitRate: null, tokensPerSecond: null, turnElapsedMs: 0
}

/** Session counters. Live activity is rendered inside the running turn, not here. */
export function ChatStatusBar({stats}: {stats?: ChatStats}) {
    const data = stats ?? empty
    const tokens = data.promptTokens + data.completionTokens
    const cache = data.cacheHitRate === null ? null : Math.round(data.cacheHitRate * 1000) / 10

    return <div className="chat-status-bar">
        <span className="chat-stat" title="对话轮次 · 工具调用步数 · 平均吞吐">
            <span className="chat-stat-icon" aria-hidden="true">◷</span>
            {data.turns} 轮 · {data.steps} 步
            {data.tokensPerSecond ? ` · ${data.tokensPerSecond} tok/s` : ''}
        </span>
        <span className="chat-stat" title="本次会话累计 token 与提示缓存命中率">
            <span className="chat-stat-icon" aria-hidden="true">⛁</span>
            {compact(tokens)} tok
            {cache !== null && ` · 缓存命中 ${cache}%`}
        </span>
        <span className="chat-stat" title="最近一次请求发送的上下文 token 数">
            <span className="chat-stat-icon" aria-hidden="true">▤</span>
            上下文 {compact(data.lastPromptTokens)}
        </span>
    </div>
}
