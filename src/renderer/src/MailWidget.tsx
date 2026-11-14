import {useCallback, useEffect, useRef, useState} from 'react'
import type {MailItem, MailOverview} from '../../shared/mail'
import {Icon} from './Icon'

function senderName(from: string) {
    const match = /^([^<]*?)\s*</.exec(from)
    return (match ? match[1] : from).replace(/^["']|["']$/g, '').trim() || '未知发件人'
}

function mailTime(value: string) {
    const date = new Date(value)
    if (!Number.isFinite(date.getTime())) return ''
    if (date.toDateString() === new Date().toDateString()) {
        return date.toLocaleTimeString('zh-CN', {hour: '2-digit', minute: '2-digit'})
    }
    return date.toLocaleDateString('zh-CN', {month: 'numeric', day: 'numeric'})
}

function MailRow({item, onOpen}: { item: MailItem; onOpen: () => void }) {
    return <li>
        <button type="button" onClick={onOpen} title={`${item.from || '未知发件人'}：${item.subject}`}>
            <span className="dashboard-mail-meta">
                <span className="dashboard-mail-from">{senderName(item.from)}</span>
                {item.receivedAt && <time dateTime={item.receivedAt}>{mailTime(item.receivedAt)}</time>}
            </span>
            <strong>{!item.read && <span className="dashboard-mail-dot" role="img" aria-label="未读"/>}
                {item.subject}</strong>
        </button>
    </li>
}

export function MailWidget({refreshVersion, onOpenMail, onOpenMailbox}: {
    refreshVersion: number;
    onOpenMail: (item: MailItem) => void;
    onOpenMailbox: () => void
}) {
    const [overview, setOverview] = useState<MailOverview | null>(null)
    const [busy, setBusy] = useState(true)
    const [error, setError] = useState('')
    const mounted = useRef(false)
    const pending = useRef(false)
    const queuedRefresh = useRef(false)
    const previousVersion = useRef(refreshVersion)
    const api = window.mail

    const load = useCallback(async function load(force = false) {
        if (pending.current) {
            if (force) queuedRefresh.current = true
            return
        }
        if (!api) {
            setBusy(false)
            setError('请在桌面应用中查看邮件。')
            return
        }
        pending.current = true
        setBusy(true)
        setError('')
        try {
            const result = await api.overview(force)
            if (!mounted.current) return
            if (result.ok) setOverview(result.data)
            else setError(result.error)
        } catch {
            if (mounted.current) setError('无法读取邮件，请稍后重试。')
        } finally {
            pending.current = false
            if (mounted.current) {
                setBusy(false)
                if (queuedRefresh.current) {
                    queuedRefresh.current = false
                    void load(true)
                }
            }
        }
    }, [api])

    useEffect(() => {
        mounted.current = true
        void load()
        return () => {
            mounted.current = false
        }
    }, [load])

    useEffect(() => {
        if (previousVersion.current === refreshVersion) return
        previousVersion.current = refreshVersion
        void load(true)
    }, [refreshVersion, load])

    const items = overview?.items ?? []
    const failures = overview?.errors.length ?? 0

    return <div aria-busy={busy}>
        <div className="dashboard-widget-heading">
            <h2><Icon name="inbox"/>邮件速览</h2>
            <button type="button" onClick={onOpenMailbox}>全部<Icon name="chevron"/></button>
        </div>
        {busy && !overview && <p className="dashboard-widget-caption" role="status">正在读取邮件…</p>}
        {error && <p className="dashboard-error" role="alert">{error}</p>}
        {overview && !overview.configured &&
            <p className="dashboard-empty">尚未配置邮箱，
                <button type="button" className="dashboard-mail-setup" onClick={onOpenMailbox}>前往邮箱</button>
            </p>}
        {overview?.configured && !items.length && !failures &&
            <p className="dashboard-empty">收件箱暂无邮件</p>}
        {overview?.configured && !items.length && failures > 0 &&
            <p className="dashboard-error" role="alert">{overview.errors[0].message}</p>}
        {items.length > 0 && <ul className="dashboard-mail-list">
            {items.map(item => <MailRow key={item.id} item={item} onOpen={() => onOpenMail(item)}/>)}
        </ul>}
        {items.length > 0 && failures > 0 &&
            <p className="dashboard-widget-caption">部分邮箱暂时无法读取。</p>}
    </div>
}
