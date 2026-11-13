import {useEffect, useState} from 'react'
import type {ResearchSettings} from '../../shared/research'
import {Icon} from './Icon'
import './styles/research.css'

export function ResearchPanel({active}: { active: boolean }) {
    const api = window.research
    const [settings, setSettings] = useState<ResearchSettings | null>(null)
    const [email, setEmail] = useState('')
    const [password, setPassword] = useState('')
    const [loaded, setLoaded] = useState(false)
    const [loading, setLoading] = useState(false)
    const [loggingIn, setLoggingIn] = useState(false)
    const [error, setError] = useState('')

    useEffect(() => {
        if (!active || !api || loaded) return
        let cancelled = false
        setLoading(true)
        setError('')
        void api.get().then(result => {
            if (cancelled) return
            if (result.ok) {
                setSettings(result.data)
                setLoaded(true)
            } else setError(result.error)
        }).catch(() => {
            if (!cancelled) setError('无法读取旦挞设置。')
        }).finally(() => {
            if (!cancelled) setLoading(false)
        })
        return () => {
            cancelled = true
        }
    }, [active, api, loaded])

    async function reload() {
        if (!api) return
        const result = await api.get()
        if (result.ok) setSettings(result.data)
        else setError(result.error)
    }

    async function login() {
        if (!api || loggingIn) return
        setLoggingIn(true)
        setError('')
        const secret = password
        setPassword('')
        try {
            const result = await api.login({email: email.trim(), password: secret})
            if (!result.ok) {
                setError(result.error)
                return
            }
            await reload()
        } catch {
            setError('无法登录树洞。')
        } finally {
            setLoggingIn(false)
        }
    }

    async function logout() {
        if (!api || loggingIn) return
        setLoggingIn(true)
        setError('')
        try {
            const result = await api.logout()
            if (!result.ok) setError(result.error)
            else await reload()
        } catch {
            setError('无法退出树洞。')
        } finally {
            setLoggingIn(false)
        }
    }

    const campusLabel = settings?.campus.loggedIn ? '已登录'
        : settings?.campus.status === 'expired' ? '登录已过期'
            : settings?.campus.status === 'invalid' ? '凭据不可用' : '未登录'

    return <div className="llm-settings">
        <div className="llm-panel">
            <h3 className="llm-section-heading">树洞</h3>
            <div className="account-panel">
                {settings?.campus.loggedIn && <div className="account-summary">
                    <div className="account-symbol"><Icon name="user"/></div>
                    <div><strong>{settings.campus.email ?? (email.trim() || '树洞用户')}</strong>
                        <p className="account-status">{campusLabel}</p></div>
                </div>}
                {!settings?.campus.loggedIn && <div className="account-form">
                    <label htmlFor="research-campus-email">邮箱</label>
                    <input id="research-campus-email" type="email" value={email} maxLength={320}
                           placeholder="请输入邮箱" autoComplete="username"
                           disabled={loggingIn || loading || !loaded}
                           onChange={event => setEmail(event.target.value)}
                           onKeyDown={event => {
                               if (event.key === 'Enter') {
                                   event.preventDefault()
                                   void login()
                               }
                           }}/>
                    <label htmlFor="research-campus-password">密码</label>
                    <input id="research-campus-password" type="password" value={password} maxLength={1024}
                           placeholder="请输入密码" autoComplete="current-password"
                           disabled={loggingIn || loading || !loaded}
                           onChange={event => setPassword(event.target.value)}
                           onKeyDown={event => {
                               if (event.key === 'Enter') {
                                   event.preventDefault()
                                   void login()
                               }
                           }}/>
                    <button type="button" className="primary-button"
                            disabled={loggingIn || loading || !loaded || !email.trim() || !password}
                            onClick={() => void login()}>登录
                    </button>
                </div>}
                {settings?.campus.loggedIn && <div className="account-actions">
                    <button type="button" className="secondary-button" disabled={loggingIn || loading}
                            onClick={() => void logout()}>退出登录
                    </button>
                </div>}
                {loggingIn && <p className="account-feedback" role="status">正在处理…</p>}
            </div>
            {!api && <p className="account-error" role="alert">旦挞设置服务不可用。</p>}
            {loading && !loaded && <p className="llm-status" role="status">读取中…</p>}
            {error && <p className="account-error" role="alert">{error}</p>}
        </div>
    </div>
}
