import {useEffect, useState} from 'react'
import type {UsageSummary} from '../../shared/chat'

export function UsagePanel({active}: { active: boolean }) {
    const [usage, setUsage] = useState<UsageSummary | null>(null)
    const [error, setError] = useState('')
    const [retry, setRetry] = useState(0)
    useEffect(() => {
        if (!active) return
        if (!window.chat) {
            setError('聊天用量服务未加载，请重启应用。');
            return
        }
        let current = true
        setError('')
        void window.chat?.usage().then(result => {
            if (!current) return
            if (result.ok) setUsage(result.data); else setError(result.error)
        }).catch(() => {
            if (current) setError('无法读取用量。')
        })
        return () => {
            current = false
        }
    }, [active, retry])
    return <section className="agent-settings" aria-label="模型用量"><h3>聊天用量</h3>
        <p>按北京时间统计当前账号的聊天与上下文压缩请求。仅记录服务端报告的
            token，不估算缺失值，不限额；耗时包含等待与重试。</p>
        {usage ? <div className="usage-grid">{(['today', 'month'] as const).map(key => <div key={key}>
            <h4>{key === 'today' ? '今日' : '本月'}</h4>
            <p>{(usage[key].promptTokens + usage[key].completionTokens).toLocaleString()} 已报告 token</p>
            <small>输入 {usage[key].promptTokens.toLocaleString()} ·
                输出 {usage[key].completionTokens.toLocaleString()}</small>
            <p>{usage[key].requests} 条请求记录 · {(usage[key].elapsedMs / 1000).toFixed(1)} 秒</p>
            {!!usage[key].missingUsage && <small>{usage[key].missingUsage} 条未返回完整用量，实际总量未知</small>}
        </div>)}</div> : !error && <p role="status">正在读取用量…</p>}
        {error && <p className="chat-error" role="alert">{error}</p>}
        <button type="button" className="secondary-button" onClick={() => setRetry(value => value + 1)}>刷新用量
        </button>
    </section>
}
