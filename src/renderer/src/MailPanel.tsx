import {useEffect, useRef, useState} from 'react'
import type {Result} from '../../shared/accounts'
import {emptyMailSettings, fudanStudentMail, type MailSettings} from '../../shared/mail'
import {MailConnectionDialog} from './MailConnectionDialog'
import {ConfirmDialog} from './ConfirmDialog'
import {Icon} from './Icon'
import './styles/mail.css'
import './styles/llm.css'

export function MailPanel({active, campusUsername, onOpenChat}: {active: boolean; campusUsername?: string; onOpenChat: () => void}) {
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
        if (!active) {setEditing(false); setRemoving(false); return}
        let current = true
        setLoaded(false); setError('')
        if (!api) {setError('请在桌面应用中使用邮箱连接。'); setLoaded(true); return}
        void api.get().then(result => {
            if (!current) return
            if (result.ok) setSettings(result.data)
            else setError(result.error)
        }).catch(() => {if (current) setError('无法读取邮箱设置，请重试。')})
            .finally(() => {if (current) setLoaded(true)})
        return () => {current = false}
    }, [active, api, retry])
    async function update(action: () => Promise<Result<MailSettings>>, message: string) {
        if (busy) return
        setBusy('settings'); setError(''); setNotice('')
        try {
            const result = await action()
            if (result.ok) {
                setSettings(result.data); setNotice(message); setRemoving(false)
                if (removing) requestAnimationFrame(() => connectionButton.current?.focus({preventScroll: true}))
            }
            else setError(result.error)
        } catch {setError('无法更新邮箱连接，请重试。')}
        finally {setBusy('')}
    }
    async function open(mode: 'browser' | 'app') {
        if (!api || busy) return
        setBusy(mode); setError(''); setNotice('')
        try {
            const result = await api.openWebmail(mode)
            if (!result.ok) setError(result.error)
            else setNotice(mode === 'browser' ? '已在默认浏览器打开复旦邮箱。' : '已打开应用内邮箱窗口。')
        } catch {setError('未能打开邮箱，请重试或改用浏览器。')}
        finally {setBusy('')}
    }
    if (!active) return null
    return <div className="mail-panel">
        <header className="mail-page-heading"><div className="mail-page-symbol"><Icon name="mail"/></div>
            <div><h2>邮箱</h2><p>收发交给官方邮箱，阅读交给助手。</p></div></header>
        <section className="mail-webmail-section" aria-labelledby="mail-webmail-title">
            <div className="mail-section-heading"><h3 id="mail-webmail-title">复旦学生邮箱网页版</h3><span className="mail-domain">{new URL(fudanStudentMail.webmailUrl).hostname}</span></div>
            <p>使用完整的收发、附件、草稿和文件夹功能。浏览器入口可沿用你已有的登录状态。</p>
            <div className="mail-entry-actions"><button type="button" className="primary-button" disabled={!api || !!busy} onClick={() => void open('browser')}>
                <Icon name="external"/>{busy === 'browser' ? '正在打开…' : '在浏览器打开'}</button>
                <button type="button" className="secondary-button" disabled={!api || !!busy} onClick={() => void open('app')}>
                    {busy === 'app' ? '正在打开…' : '在应用内打开'}</button></div>
            <p className="mail-field-hint">应用内使用独立邮箱窗口，首次打开需要登录。网页登录与助手连接分别管理。</p>
        </section>
        <section className="mail-agent-section" aria-labelledby="mail-agent-title" aria-busy={!loaded || busy === 'settings'}>
            <div className="mail-section-heading"><h3 id="mail-agent-title">助手读取</h3>
                {loaded && <span className={'mail-connection-state' + (settings.configured && settings.enabled ? ' is-enabled' : '')}>
                    <span aria-hidden="true"/>{settings.configured ? settings.enabled ? '已启用' : '已暂停' : '未连接'}</span>}</div>
            {!loaded ? <p role="status">正在读取连接设置…</p> : settings.configured ? <>
                <div className="mail-account-row"><div><strong>{settings.address}</strong><p>{settings.host}：{settings.port}，{settings.security === 'tls' ? 'TLS' : 'STARTTLS'}</p></div>
                    <button ref={connectionButton} type="button" className="secondary-button" disabled={!!busy} onClick={() => setEditing(true)}>修改连接</button></div>
                <div className="mail-permission-row"><div><label id="mail-agent-enable-label" htmlFor="mail-agent-enable">允许助手读取收件箱</label>
                    <p>只读标题、正文摘录和正文，不改变已读状态。</p></div>
                    <button id="mail-agent-enable" type="button" role="switch" className="llm-switch" aria-labelledby="mail-agent-enable-label"
                            aria-checked={settings.enabled} disabled={!!busy} onClick={() => void update(() => api!.setEnabled(!settings.enabled), settings.enabled ? '助手读取已暂停。' : '助手读取已启用。')}>
                        <span className="llm-switch-track" aria-hidden="true"><span/></span></button></div>
                {settings.lastVerifiedAt && <p className="mail-field-hint">上次连接验证：{new Date(settings.lastVerifiedAt).toLocaleString('zh-CN')}</p>}
                <div className="mail-account-actions"><button type="button" className="secondary-button" onClick={onOpenChat}>前往对话</button>
                    <button ref={removeButton} type="button" className="mail-text-button" disabled={!!busy} onClick={() => setRemoving(true)}>移除本机连接</button></div>
            </> : <div className="mail-connect-invitation"><p>首次连接前，请在官方邮箱开启 IMAP/SMTP 服务并保存，再生成客户端专用密码。连接时将专用密码粘贴到 FduNav。</p>
                <button ref={connectionButton} type="button" className="secondary-button" disabled={!api || !!busy} onClick={() => setEditing(true)}><Icon name="plus"/>连接助手读取</button></div>}
            <ul className="mail-capabilities"><li><Icon name="notices"/><div><strong>查看最近邮件</strong><p>标题、发件人和正文摘录，默认最近 30 天，可指定日期。</p></div></li>
                <li><Icon name="book"/><div><strong>按需阅读正文</strong><p>只读取需要的邮件。写信、回复和管理操作由你在网页版完成。</p></div></li></ul>
            <p className="mail-privacy-note"><Icon name="info"/><span>连接凭据仅加密保存在本机。交给助手读取的邮件片段会发送至你配置的模型，并保留在对话与执行记录中。</span></p>
        </section>
        <div className="mail-page-feedback">{notice && <p className="mail-success" role="status">{notice}</p>}
            {error && <div role="alert"><p className="account-error">{error}</p><button type="button" className="mail-text-button" disabled={!!busy} onClick={() => setRetry(value => value + 1)}>重新读取设置</button></div>}</div>
        {editing && <MailConnectionDialog settings={settings} campusUsername={campusUsername} onClose={closeConnection}
                                           onSaved={next => {setSettings(next); setError(''); setNotice('连接已验证并加密保存。')}}/>}
        {removing && <ConfirmDialog title="移除本机邮箱连接？" message="将删除本机保存的助手连接凭据，不删除服务器邮件。已有对话和执行记录中的邮件片段仍会保留。网页版登录状态不受影响。"
                                    confirmLabel="移除连接" danger busy={!!busy} onCancel={closeRemoval}
                                    onConfirm={() => void update(() => api!.disconnect(), '已移除本机助手连接。')}/>}
    </div>
}
