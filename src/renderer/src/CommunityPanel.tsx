import {type FormEvent, useEffect, useState} from 'react'
import type {DantaStatus} from '../../shared/danta'
import {Icon} from './Icon'
import './styles/community.css'

const schoolLabels: Record<DantaStatus['school'], string> = {
    unknown: '尚未检测', checking: '检测中', ready: '已连接', 'login-required': '需要登录', unavailable: '不可用',
}
const accountLabels: Record<DantaStatus['account'], string> = {
    'signed-out': '未连接', connected: '已连接', expired: '已失效',
}

/**
 * 学校 WebVPN 与旦挞社区账号是两套独立认证：学校网络只负责通路，社区账号才决定能否读树洞和课评。
 */
export function CommunityPanel() {
    const [status, setStatus] = useState<DantaStatus | null>(null)
    const [email, setEmail] = useState('')
    const [password, setPassword] = useState('')
    const [busy, setBusy] = useState('')
    const [error, setError] = useState('')
    const api = window.danta

    useEffect(() => {
        let active = true
        void api?.status().then(result => {
            if (!active) return
            if (result.ok) setStatus(result.data)
            else setError(result.error)
        }).catch(() => {
            if (active) setError('无法读取校园社区状态。')
        })
        return () => {
            active = false
        }
    }, [api])

    async function perform(label: string, action: () => Promise<{ok: true; data: DantaStatus} | {ok: false; error: string}>) {
        if (busy) return
        setBusy(label)
        setError('')
        try {
            const result = await action()
            if (result.ok) setStatus(result.data)
            else setError(result.error)
        } catch {
            setError('无法连接社区服务，请重启应用后重试。')
        } finally {
            setBusy('')
            void api?.status().then(result => {
                if (result.ok) setStatus(result.data)
            }).catch(() => {
            })
        }
    }

    function login(event: FormEvent) {
        event.preventDefault()
        if (!api || busy) return
        const input = {email: email.trim(), password}
        setPassword('')
        void perform('正在登录社区账号…', () => api.login(input).finally(() => {
            input.password = ''
        }))
    }

    const connected = status?.account === 'connected'
    const schoolReady = status?.school === 'ready'
    return <div className="community-panel">
        <h2>校园社区（树洞 / 课评）</h2>
        <p className="community-note">
            社区数据来自旦挞（FDUHole / Danke），只读。学校 WebVPN 负责通路，社区账号负责认证；两者都要连接才能搜索树洞和课评。
        </p>
        {!api && <p className="community-error">请在桌面应用中连接社区账号。</p>}
        {status && <dl className="community-status">
            <div>
                <dt>学校网络</dt>
                <dd><span className={`community-badge is-${status.school}`}>{schoolLabels[status.school]}</span></dd>
            </div>
            <div>
                <dt>社区账号</dt>
                <dd>
                    <span className={`community-badge is-${status.account}`}>{accountLabels[status.account]}</span>
                    {status.email && <span className="community-email">{status.email}</span>}
                </dd>
            </div>
            {status.lastLogin && <div>
                <dt>上次登录</dt>
                <dd>{new Date(status.lastLogin).toLocaleString('zh-CN')}</dd>
            </div>}
        </dl>}
        {status?.message && <p className="community-message">{status.message}</p>}
        {error && <p className="community-error" role="alert">{error}</p>}
        <div className="community-actions">
            <button type="button" className="secondary-button" disabled={!!busy || !api}
                    onClick={() => api && void perform('请在学校登录窗口完成认证…', () => api.connectSchool())}>
                {schoolReady ? '重新打开学校登录窗口' : '连接学校网络'}
            </button>
            <button type="button" className="secondary-button" disabled={!!busy || !api}
                    onClick={() => api && void perform('正在检测学校网络…', () => api.checkSchool())}>检测学校网络
            </button>
        </div>
        {schoolReady && !connected && <form className="community-form" onSubmit={login} aria-busy={!!busy}>
            <p className="community-form-title">学校网络已连接，请输入旦挞社区账号。</p>
            <label htmlFor="community-email">社区邮箱</label>
            <input id="community-email" name="email" type="email" autoComplete="username" value={email}
                   onChange={event => setEmail(event.target.value)} placeholder="旦挞注册邮箱" required
                   maxLength={320} disabled={!!busy}/>
            <label htmlFor="community-password">社区密码</label>
            <input id="community-password" name="password" type="password" autoComplete="current-password"
                   value={password} onChange={event => setPassword(event.target.value)} placeholder="社区账号密码"
                   required maxLength={1024} disabled={!!busy}/>
            <button type="submit" className="primary-button"
                    disabled={!!busy || !email.trim() || !password}>连接社区账号
            </button>
        </form>}
        {connected && <div className="community-actions">
            <button type="button" className="secondary-button" disabled={!!busy || !api}
                    onClick={() => api && void perform('正在断开…', () => api.logout())}>断开社区账号
            </button>
        </div>}
        {status && status.account === 'connected' && <label className="community-toggle">
            <input type="checkbox" checked={status.agentEnabled} disabled={!!busy || !api}
                   onChange={event => api && void perform(event.target.checked ? '正在开启…' : '正在关闭…',
                       () => api.setAgentEnabled(event.target.checked))}/>
            <span><strong>允许聊天助手读取树洞与课评</strong>
                <small>开启后，助手可以调用四个只读工具检索帖子、帖子楼层、课程与课评；不包含发帖、回复、投票和写课评。</small></span>
        </label>}
        {busy && <p className="community-feedback" role="status"><Icon name="refresh"/>{busy}</p>}
    </div>
}
