import {useEffect, useRef, useState} from 'react'
import type {MailAccount} from '../../shared/mail'
import {MailConnectionDialog} from './MailConnectionDialog'
import {ConfirmDialog} from './ConfirmDialog'
import {Icon} from './Icon'
import './styles/mail.css'
import './styles/llm.css'

export function MailPanel({active, campusUsername}: { active: boolean; campusUsername?: string }) {
    const [accounts, setAccounts] = useState<MailAccount[]>([]), [loading, setLoading] = useState(true)
    const [error, setError] = useState(''), [busy, setBusy] = useState('')
    const [editing, setEditing] = useState<MailAccount | 'new' | null>(null), [removing, setRemoving] = useState<MailAccount | null>(null)
    const [reload, setReload] = useState(0), addButton = useRef<HTMLButtonElement>(null)
    useEffect(() => {
        if (!active) {
            setEditing(null);
            setRemoving(null);
            return
        }
        let current = true;
        setLoading(true);
        setError('')
        if (!window.mail) {
            setError('请在 FduNav 桌面应用中配置邮箱。');
            setLoading(false);
            return
        }
        void window.mail.accounts().then(result => {
            if (!current) return
            if (result.ok) setAccounts(result.data); else setError(result.error)
        }).catch(() => {
            if (current) setError('无法加载邮箱账号，请重试。')
        }).finally(() => {
            if (current) setLoading(false)
        })
        return () => {
            current = false
        }
    }, [active, reload])

    async function remove() {
        if (!window.mail || !removing || busy) return
        setBusy(removing.id);
        setError('')
        try {
            const result = await window.mail.removeAccount(removing.id)
            if (result.ok) {
                setAccounts(current => current.filter(value => value.id !== removing.id));
                setRemoving(null);
                requestAnimationFrame(() => addButton.current?.focus())
            } else setError(result.error)
        } catch {
            setError('未能移除邮箱，请重试。')
        } finally {
            setBusy('')
        }
    }

    if (!active) return null
    return <div className="mail-panel">
        {loading ? <p role="status">正在加载邮箱账号…</p> : accounts.length ? <div className="mail-settings-accounts">
            {accounts.map(account => <section className="mail-settings-account" key={account.id}
                                              aria-label={account.label}>
                <div className="mail-settings-account-top"><span className="mail-account-avatar"
                                                                 aria-hidden="true">{account.label.slice(0, 1).toUpperCase()}</span>
                    <div className="mail-settings-account-name"><h3>{account.label}</h3><p>{account.address}</p></div>
                    {!account.smtp && <span className="mail-account-capability">仅收信</span>}
                    <button type="button" className="icon-button" title="编辑邮箱"
                            aria-label={'编辑 ' + account.address} disabled={!!busy}
                            onClick={() => setEditing(account)}><Icon name="pencil"/></button>
                    <button type="button" className="icon-button" title="移除邮箱"
                            aria-label={'移除 ' + account.address} disabled={!!busy}
                            onClick={() => setRemoving(account)}><Icon name="trash"/></button>
                </div>
            </section>)}
        </div> : !error && <div className="mail-settings-empty"><Icon name="mail"/><h3>暂无邮箱账号</h3></div>}
        <div className="mail-settings-add">
            <button ref={addButton} type="button" className="primary-button"
                    disabled={loading || !!busy || !window.mail} onClick={() => setEditing('new')}><Icon name="plus"/>添加邮箱
            </button>
        </div>
        <div className="mail-page-feedback" aria-live="polite">{error &&
            <div role="alert"><p className="account-error">{error}</p>
                <button type="button" className="mail-text-button"
                        onClick={() => setReload(value => value + 1)}>重新加载
                </button>
            </div>}</div>
        {editing &&
            <MailConnectionDialog account={editing === 'new' ? undefined : editing} campusUsername={campusUsername}
                                  onClose={() => setEditing(null)} onSaved={value => {
                setAccounts(current => [...current.filter(account => account.id !== value.id && account.id !== (editing === 'new' ? '' : editing.id)), value]);
                setError('')
            }}/>}
        {removing && <ConfirmDialog title={'移除“' + removing.label + '”？'}
                                    message="将清除本机保存的连接信息。服务器上的邮件和本地草稿会保留；重新添加邮箱后才能继续收发邮件。"
                                    confirmLabel="移除邮箱" danger busy={!!busy} onCancel={() => setRemoving(null)}
                                    onConfirm={() => void remove()}/>}
    </div>
}
