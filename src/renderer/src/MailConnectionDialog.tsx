import {type FormEvent, useEffect, useRef, useState} from 'react'
import {validateMailInput, type MailInput, type MailSettings, mailPresets, fudanStudentMail} from '../../shared/mail'
import {ConfirmDialog} from './ConfirmDialog'
import {Icon} from './Icon'

export function MailConnectionDialog({settings, campusUsername, onClose, onSaved}: {
    settings: MailSettings; campusUsername?: string; onClose: () => void; onSaved: (settings: MailSettings) => void
}) {
    const [initial] = useState<MailInput>(() => ({...settings, enabled: settings.configured ? settings.enabled : true,
        host: settings.host || fudanStudentMail.host, address: settings.address || (campusUsername ? campusUsername + '@' + fudanStudentMail.domain : ''),
        username: settings.username || '', password: ''}))
    const [draft, setDraft] = useState(initial)
    const [preset, setPreset] = useState(() => mailPresets.find(item => item.host === initial.host)?.id ?? 'custom')
    const [advanced, setAdvanced] = useState(false)
    const [revealed, setRevealed] = useState(false)
    const [busy, setBusy] = useState<'' | 'test' | 'save'>('')
    const [stopping, setStopping] = useState(false)
    const [error, setError] = useState('')
    const [fieldError, setFieldError] = useState<keyof MailInput | ''>('')
    const [notice, setNotice] = useState('')
    const [discarding, setDiscarding] = useState(false)
    const dialog = useRef<HTMLDialogElement>(null)
    const form = useRef<HTMLFormElement>(null)
    const closeButton = useRef<HTMLButtonElement>(null)
    const stopButton = useRef<HTMLButtonElement>(null)
    const mounted = useRef(true)
    const dirty = JSON.stringify(draft) !== JSON.stringify(initial)
    const api = window.mail

    useEffect(() => {
        mounted.current = true
        const element = dialog.current!, trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null
        element.showModal()
        form.current?.querySelector<HTMLInputElement>('[name="address"]')?.focus()
        return () => {mounted.current = false; element.close(); trigger?.focus({preventScroll: true})}
    }, [])
    useEffect(() => {
        if (fieldError) form.current?.querySelector<HTMLElement>('[name="' + fieldError + '"]')?.focus()
    }, [fieldError, advanced])
    useEffect(() => {if (busy) stopButton.current?.focus()}, [busy])
    useEffect(() => {
        if (!discarding && dialog.current?.matches(':modal') && !dialog.current.contains(document.activeElement)) closeButton.current?.focus()
    }, [discarding])

    function change<K extends keyof MailInput>(key: K, value: MailInput[K]) {
        setDraft(current => ({...current, [key]: value})); setError(''); setFieldError(''); setNotice('')
    }
    function requestClose() {
        if (busy) return
        if (dirty) setDiscarding(true)
        else onClose()
    }
    async function perform(kind: 'test' | 'save') {
        if (!api || busy) return
        const checked = validateMailInput(draft)
        if (!checked.ok) {
            setError(checked.error); setFieldError(checked.field ?? '')
            if (checked.field && !['address', 'password', 'enabled'].includes(checked.field)) setAdvanced(true)
            return
        }
        if (!settings.configured && !draft.password) {setError('请输入邮箱密码或客户端专用密码。'); setFieldError('password'); return}
        setBusy(kind); setError(''); setFieldError(''); setNotice('')
        const input = checked.data
        try {
            if (kind === 'test') {
                const result = await api.test(input)
                if (!mounted.current) return
                if (result.ok) setNotice(result.data.message)
                else setError(result.error)
            } else {
                const result = await api.save(input)
                if (!mounted.current) return
                if (result.ok) {onSaved(result.data); onClose()}
                else setError(result.error)
            }
        } catch {if (mounted.current) setError('连接未完成，请检查网络后重试。')}
        finally {input.password = ''; if (mounted.current) {setBusy(''); setStopping(false)}}
    }
    async function stopSetup() {
        if (!api || stopping) return
        setStopping(true)
        try {const result = await api.cancelSetup(); if (!result.ok) setError(result.error)}
        catch {setError('无法停止连接操作，请等待连接结束。')}
        finally {if (mounted.current) setStopping(false)}
    }
    const invalid = (field: keyof MailInput) => fieldError === field || undefined
    const described = (field: keyof MailInput, hint?: string) => fieldError === field ? 'mail-connection-error' : hint
    const hint = mailPresets.find(item => item.id === preset)?.hint
    return <dialog ref={dialog} className="calendar-dialog mail-connection-dialog" aria-labelledby="mail-connection-title"
                   aria-describedby="mail-connection-description" onClose={() => {if (!dialog.current?.open) requestClose()}}
                   onCancel={event => {event.preventDefault(); requestClose()}}
                   onClick={event => {if (event.target === dialog.current) requestClose()}}>
        <div className="calendar-dialog-header mail-dialog-heading">
            <div><h3 id="mail-connection-title">{settings.configured ? '修改助手连接' : '连接助手读取'}</h3>
                <p id="mail-connection-description">让助手按需查看收件箱，收发邮件仍在官方网页版完成。</p></div>
            <button ref={closeButton} type="button" className="icon-button" title="关闭" aria-label="关闭邮箱连接" disabled={!!busy} onClick={requestClose}><Icon name="close"/></button>
        </div>
        <form ref={form} className="mail-connection-form" noValidate onSubmit={(event: FormEvent) => {event.preventDefault(); void perform('save')}} aria-busy={!!busy}>
            <fieldset disabled={!!busy}>
                <label htmlFor="mail-provider">邮箱类型</label>
                <select id="mail-provider" value={preset} onChange={event => {
                    const next = mailPresets.find(item => item.id === event.target.value)!
                    setPreset(next.id); setDraft(current => ({...current, host: next.host, port: 993, security: 'tls', password: ''}))
                    setError(''); setFieldError(''); setNotice(''); setAdvanced(next.id === 'custom')
                }}>{mailPresets.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select>
                <label htmlFor="mail-address">邮箱地址</label>
                <input id="mail-address" name="address" type="email" autoComplete="username" autoCapitalize="none" spellCheck={false}
                       placeholder={'学号@' + fudanStudentMail.domain} maxLength={254} value={draft.address} aria-invalid={invalid('address')}
                       aria-describedby={described('address')} onChange={event => change('address', event.target.value)}/>
                <label htmlFor="mail-password">密码或客户端专用密码</label>
                <div className="mail-password-control">
                    <input id="mail-password" name="password" type={revealed ? 'text' : 'password'} autoComplete="current-password"
                           value={draft.password} maxLength={4096} placeholder={settings.configured ? '留空保留已保存的密码' : '输入密码或授权码'}
                           aria-invalid={invalid('password')} aria-describedby={described('password', 'mail-password-hint')}
                           onChange={event => change('password', event.target.value)}/>
                    <button type="button" className="mail-reveal" aria-label={revealed ? '隐藏密码' : '显示密码'} aria-pressed={revealed}
                            onClick={() => setRevealed(value => !value)}>{revealed ? '隐藏' : '显示'}</button>
                </div>
                <p className="mail-field-hint" id="mail-password-hint">{hint}</p>
                <details className="mail-advanced" open={advanced} onToggle={event => setAdvanced(event.currentTarget.open)}>
                    <summary>服务器设置</summary>
                    <div className="mail-advanced-fields">
                        <label htmlFor="mail-host">IMAP 服务器</label>
                        <input id="mail-host" name="host" value={draft.host} maxLength={253} autoCapitalize="none" spellCheck={false}
                               aria-invalid={invalid('host')} aria-describedby={described('host')} onChange={event => change('host', event.target.value)}/>
                        <div className="mail-form-columns"><div><label htmlFor="mail-port">端口</label>
                            <input id="mail-port" name="port" type="number" min={1} max={65535} value={draft.port || ''} aria-invalid={invalid('port')}
                                   aria-describedby={described('port')} onChange={event => change('port', Number(event.target.value))}/></div>
                            <div><label htmlFor="mail-security">连接加密</label>
                                <select id="mail-security" name="security" value={draft.security} onChange={event => {
                                    const security = event.target.value as MailInput['security']; setDraft(current => ({...current, security, port: security === 'tls' ? 993 : 143})); setNotice('')
                                }}><option value="tls">TLS（推荐）</option><option value="starttls">STARTTLS</option></select></div></div>
                        <label htmlFor="mail-username">登录账号（可选）</label>
                        <input id="mail-username" name="username" value={draft.username} maxLength={254} autoCapitalize="none" spellCheck={false}
                               placeholder="默认使用上方邮箱地址" aria-invalid={invalid('username')} aria-describedby={described('username')}
                               onChange={event => change('username', event.target.value)}/>
                    </div>
                </details>
                <label className="mail-agent-consent"><input type="checkbox" checked={draft.enabled} onChange={event => change('enabled', event.target.checked)}/>
                    允许助手按需读取收件箱</label>
                <p className="mail-field-hint">凭据通过系统安全存储加密保存在本机。助手读取的邮件片段会发送至你配置的模型，并保留在对话与执行记录中。</p>
            </fieldset>
            <div className="mail-form-feedback" aria-live="polite">
                {busy && <p role="status">{busy === 'test' ? '正在验证安全连接…' : '正在验证并加密保存…'}</p>}
                {notice && <p className="mail-success" role="status">{notice}</p>}
                {error && <p id="mail-connection-error" className="account-error" role="alert">{error}</p>}
            </div>
            <div className="calendar-dialog-actions mail-dialog-actions">
                {busy ? <button ref={stopButton} type="button" className="secondary-button" disabled={stopping} onClick={() => void stopSetup()}>{stopping ? '正在停止…' : busy === 'test' ? '停止测试' : '取消连接'}</button>
                    : <button type="button" className="secondary-button" disabled={!!busy} onClick={() => void perform('test')}>测试连接</button>}
                <button type="submit" className="primary-button" disabled={!!busy}>{busy === 'save' ? '正在保存…' : settings.configured ? '保存更改' : '连接并保存'}</button>
            </div>
        </form>
        {discarding && <ConfirmDialog title="放弃未保存的连接设置？" message="修改尚未保存。关闭后需要重新输入密码。" confirmLabel="放弃修改"
                                     onCancel={() => setDiscarding(false)} onConfirm={onClose}/>}
    </dialog>
}
