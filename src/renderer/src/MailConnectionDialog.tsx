import {type FormEvent, useEffect, useRef, useState} from 'react'
import {
    fudanStudentMail,
    type MailAccount,
    type MailAccountInput,
    mailPresets,
    type MailSmtpInput,
    smtpPresets,
    validateMailAccount
} from '../../shared/mail'
import {ConfirmDialog} from './ConfirmDialog'
import {Icon} from './Icon'

export function MailConnectionDialog({account, campusUsername, onClose, onSaved}: {
    account?: MailAccount; campusUsername?: string; onClose: () => void; onSaved: (account: MailAccount) => void
}) {
    const initialPreset = mailPresets.find(preset => preset.host === account?.host)?.id ?? (account ? 'custom' : 'fudan-cloud')
    const [preset, setPreset] = useState<string>(initialPreset)
    const [initial] = useState<MailAccountInput>(() => ({
        id: account?.id,
        label: account?.label ?? '',
        address: account?.address ?? (campusUsername ? campusUsername + '@' + fudanStudentMail.domain : ''),
        username: account?.username ?? '',
        host: account?.host ?? fudanStudentMail.host,
        port: account?.port ?? 993,
        security: account?.security ?? 'tls',
        password: '',
        enabled: account?.enabled ?? false,
        smtp: account ? account.smtp ? {...account.smtp, password: ''} : null : {
            ...smtpPresets['fudan-cloud'], username: '', address: '', password: '', useImapCredentials: true,
        },
    }))
    const [draft, setDraft] = useState(initial), [advanced, setAdvanced] = useState(initialPreset === 'custom')
    const [revealed, setRevealed] = useState(false), [smtpRevealed, setSmtpRevealed] = useState(false)
    const [busy, setBusy] = useState<'' | 'test' | 'save'>(''), [stopping, setStopping] = useState(false)
    const [error, setError] = useState(''), [notice, setNotice] = useState(''), [discarding, setDiscarding] = useState(false)
    const [fieldError, setFieldError] = useState('')
    const dialog = useRef<HTMLDialogElement>(null), form = useRef<HTMLFormElement>(null),
        stopButton = useRef<HTMLButtonElement>(null)
    const mounted = useRef(true), closeButton = useRef<HTMLButtonElement>(null)
    const dirty = JSON.stringify(draft) !== JSON.stringify(initial)
    useEffect(() => {
        mounted.current = true
        const element = dialog.current!,
            trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null
        element.showModal();
        form.current?.querySelector<HTMLInputElement>('[name="address"]')?.focus()
        return () => {
            mounted.current = false;
            element.close();
            trigger?.focus({preventScroll: true})
        }
    }, [])
    useEffect(() => {
        if (busy) stopButton.current?.focus()
    }, [busy])
    useEffect(() => {
        if (fieldError) form.current?.querySelector<HTMLElement>('[name="' + fieldError + '"]')?.focus()
    }, [fieldError, advanced])
    useEffect(() => {
        if (!discarding && dialog.current?.matches(':modal') && !dialog.current.contains(document.activeElement)) closeButton.current?.focus()
    }, [discarding])

    function update(value: Partial<MailAccountInput>) {
        setDraft(current => ({...current, ...value}));
        setError('');
        setFieldError('');
        setNotice('')
    }

    function updateSmtp(value: Partial<MailSmtpInput>) {
        if (draft.smtp) update({smtp: {...draft.smtp, ...value}})
    }

    function requestClose() {
        if (!busy) {
            if (dirty) setDiscarding(true); else onClose()
        }
    }

    async function perform(kind: 'test' | 'save') {
        if (!window.mail || busy) return
        const checked = validateMailAccount(draft)
        if (!checked.ok) {
            setError(checked.error);
            setFieldError(checked.field ?? '')
            if (checked.field && !['address', 'label', 'password'].includes(checked.field)) setAdvanced(true)
            return
        }
        if (!account && !draft.password) {
            setError(preset === 'gmail' ? '请输入应用专用密码。' : '请输入密码或授权码。');
            setFieldError('password');
            return
        }
        setBusy(kind);
        setError('');
        setFieldError('');
        setNotice('')
        try {
            if (kind === 'test') {
                const result = await window.mail.testAccount(checked.data)
                if (!mounted.current) return
                if (result.ok) setNotice(result.data.smtp ? '收信和发信连接验证通过。' : '收信连接验证通过。')
                else setError(result.error)
            } else {
                const result = await window.mail.saveAccount(checked.data)
                if (!mounted.current) return
                if (result.ok) {
                    onSaved(result.data);
                    onClose()
                } else setError(result.error)
            }
        } catch {
            if (mounted.current) setError('连接失败，请检查网络后重试。')
        } finally {
            checked.data.password = '';
            if (checked.data.smtp) checked.data.smtp.password = '';
            if (mounted.current) {
                setBusy('');
                setStopping(false)
            }
        }
    }

    async function stop() {
        if (!window.mail || stopping) return
        setStopping(true)
        try {
            const result = await window.mail.cancelSetup();
            if (!result.ok) setError(result.error)
        } catch {
            setError('暂时无法取消，请等待连接结束。')
        } finally {
            if (mounted.current) setStopping(false)
        }
    }

    async function openGmailPasswords() {
        if (!window.mail) return
        try {
            const result = await window.mail.openLink('https://myaccount.google.com/apppasswords')
            if (!result.ok) setError(result.error)
        } catch {
            setError('无法打开 Google 账号设置，请稍后重试。')
        }
    }

    const passwordLabel = preset === 'gmail' ? '应用专用密码' : '密码或授权码'
    const described = (field: string) => [
        field === 'password' && preset === 'gmail' ? 'mail-gmail-help' : '',
        fieldError === field ? 'mail-account-error' : '',
    ].filter(Boolean).join(' ') || undefined
    return <dialog ref={dialog} className="calendar-dialog mail-connection-dialog" aria-labelledby="mail-account-title"
                   onCancel={event => {
                       event.preventDefault();
                       requestClose()
                   }} onClick={event => {
        if (event.target === dialog.current) requestClose()
    }}>
        <header className="calendar-dialog-header mail-dialog-heading">
            <div><h3 id="mail-account-title">{account ? '编辑邮箱账号' : '添加邮箱'}</h3></div>
            <button ref={closeButton} type="button" className="icon-button" disabled={!!busy} title="关闭"
                    aria-label="关闭邮箱设置" onClick={requestClose}><Icon name="close"/></button>
        </header>
        <form ref={form} className="mail-connection-form" noValidate aria-busy={!!busy}
              onSubmit={(event: FormEvent) => {
                  event.preventDefault();
                  void perform('save')
              }}>
            <fieldset disabled={!!busy}>
                <label htmlFor="mail-provider">邮箱服务</label>
                <select id="mail-provider" value={preset} onChange={event => {
                    const value = mailPresets.find(item => item.id === event.target.value)!,
                        smtp = smtpPresets[value.id]
                    setPreset(value.id);
                    setAdvanced(value.id === 'custom');
                    setRevealed(false);
                    setSmtpRevealed(false)
                    update({
                        host: value.host,
                        port: 993,
                        security: 'tls',
                        password: '',
                        smtp: smtp ? {
                            ...smtp,
                            address: draft.address,
                            username: '',
                            password: '',
                            useImapCredentials: true
                        } : null
                    })
                }}>{mailPresets.map(value => <option key={value.id} value={value.id}>{value.label}</option>)}</select>
                <label htmlFor="mail-address">邮箱地址</label>
                <input id="mail-address" name="address" type="email" autoComplete="username" autoCapitalize="none"
                       spellCheck={false} maxLength={254}
                       placeholder="邮箱地址" value={draft.address}
                       aria-invalid={fieldError === 'address' || undefined} aria-describedby={described('address')}
                       onChange={event => update({address: event.target.value})}/>
                <label htmlFor="mail-label">邮箱名称</label>
                <input id="mail-label" name="label" aria-invalid={fieldError === 'label' || undefined}
                       value={draft.label} maxLength={80} placeholder="邮箱名称"
                       onChange={event => update({label: event.target.value})}/>
                <label htmlFor="mail-password">{passwordLabel}</label>
                <div className="mail-password-control"><input id="mail-password" name="password"
                                                              type={revealed ? 'text' : 'password'}
                                                              autoComplete="current-password" value={draft.password}
                                                              placeholder={account?.configured ? '已配置' : preset === 'gmail' ? '16 位应用专用密码' : passwordLabel}
                                                              maxLength={4096}
                                                              aria-invalid={fieldError === 'password' || undefined}
                                                              aria-describedby={described('password')}
                                                              onChange={event => update({password: preset === 'gmail' ? event.target.value.replace(/\s/g, '') : event.target.value})}/>
                    <button type="button" className="mail-reveal" aria-label={revealed ? '隐藏密码' : '显示密码'}
                            aria-pressed={revealed} onClick={() => setRevealed(!revealed)}><Icon
                        name={revealed ? 'eye-off' : 'eye'}/></button>
                </div>
                {preset === 'gmail' && <div className="mail-provider-help">
                    <p id="mail-gmail-help" className="mail-field-hint">先开启 Google 两步验证，再生成应用专用密码。</p>
                    <button type="button" className="mail-text-button"
                            onClick={() => void openGmailPasswords()}>获取应用专用密码
                    </button>
                </div>}
                <label className="mail-agent-consent"><input type="checkbox" checked={!!draft.smtp}
                                                             onChange={event => update({
                                                                 smtp: event.target.checked ? {
                                                                     ...(smtpPresets[preset] ?? {
                                                                         host: '',
                                                                         port: 465,
                                                                         security: 'tls'
                                                                     }),
                                                                     address: draft.address,
                                                                     username: '',
                                                                     password: '',
                                                                     useImapCredentials: true,
                                                                 } : null
                                                             })}/>启用发信</label>
                <label className="mail-agent-consent"><input type="checkbox" checked={draft.enabled}
                                                             onChange={event => update({enabled: event.target.checked})}/>允许
                    Agent 读取此邮箱</label>
                <details className="mail-advanced" open={advanced}
                         onToggle={event => setAdvanced(event.currentTarget.open)}>
                    <summary>服务器设置</summary>
                    <div className="mail-advanced-fields">
                        <h4>IMAP</h4>
                        <label htmlFor="mail-host">服务器</label><input id="mail-host" name="host" placeholder="服务器"
                                                                        value={draft.host} autoCapitalize="none"
                                                                        spellCheck={false}
                                                                        aria-invalid={fieldError === 'host' || undefined}
                                                                        aria-describedby={described('host')}
                                                                        onChange={event => update({host: event.target.value})}/>
                        <div className="mail-form-columns">
                            <div><label htmlFor="mail-port">端口</label><input id="mail-port" name="port"
                                                                               placeholder="端口"
                                                                               aria-invalid={fieldError === 'port' || undefined}
                                                                               type="number" min={1} max={65535}
                                                                               value={draft.port || ''}
                                                                               onChange={event => update({port: Number(event.target.value)})}/>
                            </div>
                            <div><label htmlFor="mail-security">加密方式</label><select id="mail-security"
                                                                                        value={draft.security}
                                                                                        onChange={event => update({
                                                                                            security: event.target.value as 'tls' | 'starttls',
                                                                                            port: event.target.value === 'tls' ? 993 : 143
                                                                                        })}>
                                <option value="tls">TLS</option>
                                <option value="starttls">STARTTLS</option>
                            </select></div>
                        </div>
                        <label htmlFor="mail-username">登录账号</label><input id="mail-username" name="username"
                                                                              placeholder="登录账号"
                                                                              aria-invalid={fieldError === 'username' || undefined}
                                                                              value={draft.username}
                                                                              onChange={event => update({username: event.target.value})}/>
                        {draft.smtp && <><h4>SMTP</h4><label htmlFor="smtp-host">服务器</label><input id="smtp-host"
                                                                                                      name="smtpHost"
                                                                                                      placeholder="服务器"
                                                                                                      value={draft.smtp.host}
                                                                                                      autoCapitalize="none"
                                                                                                      spellCheck={false}
                                                                                                      aria-invalid={fieldError === 'smtpHost' || undefined}
                                                                                                      aria-describedby={described('smtpHost')}
                                                                                                      onChange={event => updateSmtp({host: event.target.value})}/>
                            <div className="mail-form-columns">
                                <div><label htmlFor="smtp-port">端口</label><input id="smtp-port" name="smtpPort"
                                                                                   placeholder="端口"
                                                                                   aria-invalid={fieldError === 'smtpPort' || undefined}
                                                                                   type="number" min={1} max={65535}
                                                                                   value={draft.smtp.port || ''}
                                                                                   aria-describedby={described('smtpPort')}
                                                                                   onChange={event => updateSmtp({port: Number(event.target.value)})}/>
                                </div>
                                <div><label htmlFor="smtp-security">加密方式</label><select id="smtp-security"
                                                                                            value={draft.smtp.security}
                                                                                            onChange={event => updateSmtp({
                                                                                                security: event.target.value as 'tls' | 'starttls',
                                                                                                port: event.target.value === 'tls' ? 465 : 587
                                                                                            })}>
                                    <option value="tls">TLS</option>
                                    <option value="starttls">STARTTLS</option>
                                </select></div>
                            </div>
                            <label className="mail-agent-consent"><input type="checkbox"
                                                                         checked={draft.smtp.useImapCredentials}
                                                                         onChange={event => updateSmtp({
                                                                             useImapCredentials: event.target.checked,
                                                                             password: ''
                                                                         })}/>使用与收信相同的账号和密码</label>
                            {!draft.smtp.useImapCredentials && <><label htmlFor="smtp-username">发信账号</label><input
                                id="smtp-username" name="smtpUsername" placeholder="发信账号"
                                aria-invalid={fieldError === 'smtpUsername' || undefined} value={draft.smtp.username}
                                onChange={event => updateSmtp({username: event.target.value})}/>
                                <label htmlFor="smtp-password">发信密码</label>
                                <div className="mail-password-control"><input id="smtp-password" name="smtpPassword"
                                                                              placeholder="发信密码"
                                                                              aria-invalid={fieldError === 'smtpPassword' || undefined}
                                                                              type={smtpRevealed ? 'text' : 'password'}
                                                                              value={draft.smtp.password}
                                                                              autoComplete="current-password"
                                                                              aria-describedby={described('smtpPassword')}
                                                                              onChange={event => updateSmtp({password: event.target.value})}/>
                                    <button type="button" className="mail-reveal"
                                            aria-label={smtpRevealed ? '隐藏发信密码' : '显示发信密码'}
                                            aria-pressed={smtpRevealed} onClick={() => setSmtpRevealed(!smtpRevealed)}>
                                        <Icon name={smtpRevealed ? 'eye-off' : 'eye'}/></button>
                                </div>
                            </>}
                        </>}
                    </div>
                </details>
            </fieldset>
            <div className="mail-form-feedback" aria-live="polite">{busy &&
                <p role="status">{busy === 'test' ? '正在测试连接…' : '正在验证并保存…'}</p>}{notice &&
                <p role="status" className="mail-success">{notice}</p>}{error &&
                <p id="mail-account-error" role="alert" className="account-error">{error}</p>}</div>
            <div className="calendar-dialog-actions mail-dialog-actions">{busy ?
                <button ref={stopButton} type="button" className="secondary-button" disabled={stopping}
                        onClick={() => void stop()}>{stopping ? '正在取消…' : '取消操作'}</button> :
                <button type="button" className="secondary-button"
                        onClick={() => void perform('test')}>测试连接</button>}
                <button type="submit" className="primary-button"
                        disabled={!!busy}>{busy === 'save' ? '正在保存…' : account ? '保存更改' : '添加邮箱'}</button>
            </div>
        </form>
        {discarding && <ConfirmDialog title="放弃修改？" message="是否放弃修改？" confirmLabel="放弃修改"
                                      onCancel={() => setDiscarding(false)} onConfirm={onClose}/>}
    </dialog>
}
