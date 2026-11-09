import {useEffect, useRef, useState} from 'react'
import type {Result} from '../../shared/accounts'
import {emptyMailSettings, fudanStudentMail, type MailSettings} from '../../shared/mail'
import {MailConnectionDialog} from './MailConnectionDialog'
import {ConfirmDialog} from './ConfirmDialog'
import {Icon} from './Icon'
import './styles/mail.css'
import './styles/llm.css'

export function MailPanel({active, campusUsername, onOpenChat}: {
    active: boolean;
    campusUsername?: string;
    onOpenChat: () => void
}) {
    const [settings, setSettings] = useState(emptyMailSettings)
    const [loaded, setLoaded] = useState(false)
    const [busy, setBusy] = useState('')
    const [error, setError] = useState('')
    const [notice, setNotice] = useState('')
    const [editing, setEditing] = useState(false)
    const [removing, setRemoving] = useState(false)
    const [retry, setRetry] = useState(0)
    const connectionButton = useRef<HTMLButtonElement>(null)
    const removeButton = useRef<HTMLButtonElement>(null)

    function closeConnection() {
        setEditing(false)
        requestAnimationFrame(() => connectionButton.current?.focus({preventScroll: true}))
    }

    function closeRemoval() {
        setRemoving(false)
        requestAnimationFrame(() => removeButton.current?.focus({preventScroll: true}))
    }

    const api = window.mail
    useEffect(() => {
        if (!active) {
            setEditing(false);
            setRemoving(false);
            return
        }
        let current = true
        setLoaded(false);
        setError('')
        if (!api) {
            setError('请在桌面应用中使用邮箱连接。');
            setLoaded(true);
            return
        }
        void api.get().then(result => {
            if (!current) return
            if (result.ok) setSettings(result.data)
            else setError(result.error)
        }).catch(() => {
            if (current) setError('无法读取邮箱设置，请重试。')
        })
            .finally(() => {
                if (current) setLoaded(true)
            })
        return () => {
            current = false
        }
    }, [active, api, retry])

    async function update(action: () => Promise<Result<MailSettings>>, message: string) {
        if (busy) return
        setBusy('settings');
        setError('');
        setNotice('')
        try {
            const result = await action()
            if (result.ok) {
                setSettings(result.data);
                setNotice(message);
                setRemoving(false)
                if (removing) requestAnimationFrame(() => connectionButton.current?.focus({preventScroll: true}))
            } else setError(result.error)
        } catch {
            setError('无法更新邮箱连接，请重试。')
        } finally {
            setBusy('')
        }
    }

    async function open(mode: 'browser' | 'app') {
        if (!api || busy) return
        setBusy(mode);
        setError('');
        setNotice('')
        try {
            const result = await api.openWebmail(mode)
            if (!result.ok) setError(result.error)
            else setNotice(mode === 'browser' ? '已在浏览器打开邮箱。' : '已打开邮箱窗口。')
        } catch {
            setError('无法打开邮箱，请稍后重试。')
        } finally {
            setBusy('')
        }
    }

    if (!active) return null
    return <div className="mail-panel">
        <header className="mail-page-heading">
            <div className="mail-page-symbol"><Icon name="mail"/></div>
            <div><h2>邮箱</h2></div>
        </header>
        <section className="mail-webmail-section" aria-labelledby="mail-webmail-title">
            <div className="mail-section-heading"><h3 id="mail-webmail-title">复旦学生邮箱</h3><span
                className="mail-domain">{new URL(fudanStudentMail.webmailUrl).hostname}</span></div>
            <p>在官方网页版收发邮件、管理附件和文件夹。</p>
            <div className="mail-entry-actions">
                <button type="button" className="primary-button" disabled={!api || !!busy}
                        onClick={() => void open('browser')}>
                    <Icon name="external"/>{busy === 'browser' ? '正在打开…' : '在浏览器打开'}</button>
                <button type="button" className="secondary-button" disabled={!api || !!busy}
                        onClick={() => void open('app')}>
                    {busy === 'app' ? '正在打开…' : '在独立窗口打开'}</button>
            </div>
            <p className="mail-field-hint">独立窗口需要单独登录。</p>
        </section>
        <section className="mail-agent-section" aria-labelledby="mail-agent-title"
                 aria-busy={!loaded || busy === 'settings'}>
            <div className="mail-section-heading"><h3 id="mail-agent-title">邮箱接入</h3>
                {loaded && <span
                    className={'mail-connection-state' + (settings.configured && settings.enabled ? ' is-enabled' : '')}>
                    <span aria-hidden="true"/>{settings.configured ? settings.enabled ? '已启用' : '已暂停' : '未连接'}</span>}
            </div>
            <p className="mail-field-hint">连接后，可在对话中让助手查找邮件、阅读正文。</p>
            {!loaded ? <p role="status">正在加载邮箱设置…</p> : settings.configured ? <>
                <div className="mail-account-row">
                    <div><strong>{settings.address}</strong></div>
                    <button ref={connectionButton} type="button" className="secondary-button" disabled={!!busy}
                            onClick={() => setEditing(true)}>修改连接
                    </button>
                </div>
                <div className="mail-permission-row">
                    <div><label id="mail-agent-enable-label" htmlFor="mail-agent-enable">允许助手读取邮件</label>
                        <p>读取不会改变邮件的已读或未读状态。</p></div>
                    <button id="mail-agent-enable" type="button" role="switch" className="llm-switch"
                            aria-labelledby="mail-agent-enable-label"
                            aria-checked={settings.enabled} disabled={!!busy}
                            onClick={() => void update(() => api!.setEnabled(!settings.enabled), settings.enabled ? '已暂停邮件读取。' : '已允许助手读取邮件。')}>
                        <span className="llm-switch-track" aria-hidden="true"><span/></span></button>
                </div>
                {settings.lastVerifiedAt &&
                    <p className="mail-field-hint">上次验证：{new Date(settings.lastVerifiedAt).toLocaleString('zh-CN')}</p>}
                <div className="mail-account-actions">
                    <button type="button" className="secondary-button" onClick={onOpenChat}>打开对话</button>
                    <button ref={removeButton} type="button" className="mail-text-button" disabled={!!busy}
                            onClick={() => setRemoving(true)}>断开连接
                    </button>
                </div>
            </> : <div className="mail-connect-invitation"><p>连接前，请在官方邮箱开启并保存 IMAP/SMTP
                服务，再生成客户端专用密码。</p>
                <button ref={connectionButton} type="button" className="secondary-button" disabled={!api || !!busy}
                        onClick={() => setEditing(true)}><Icon name="plus"/>连接邮箱
                </button>
            </div>}
            {settings.configured &&
                <p className="mail-field-hint">例如：“查一下最近一周的考试通知。”可在对话中指定查询日期。</p>}
            <p className="mail-privacy-note"><Icon
                name="info"/><span>邮箱账号和密码加密保存在本机。助手读取的邮件内容会发送到所选模型，并保存在对话和执行记录中。</span>
            </p>
        </section>
        <div className="mail-page-feedback">{notice && <p className="mail-success" role="status">{notice}</p>}
            {error && <div role="alert"><p className="account-error">{error}</p>
                <button type="button" className="mail-text-button" disabled={!!busy}
                        onClick={() => setRetry(value => value + 1)}>重新加载设置
                </button>
            </div>}</div>
        {editing && <MailConnectionDialog settings={settings} campusUsername={campusUsername} onClose={closeConnection}
                                          onSaved={next => {
                                              setSettings(next);
                                              setError('');
                                              setNotice('邮箱连接已保存。')
                                          }}/>}
        {removing && <ConfirmDialog title="断开邮箱连接？"
                                    message="将删除本机保存的邮箱账号和密码。服务器上的邮件、网页登录和已有对话记录会保留。"
                                    confirmLabel="断开连接" danger busy={!!busy} onCancel={closeRemoval}
                                    onConfirm={() => void update(() => api!.disconnect(), '邮箱连接已断开。')}/>}
    </div>
}
