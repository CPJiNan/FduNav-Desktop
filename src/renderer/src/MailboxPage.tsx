import {type ComponentProps, useCallback, useEffect, useRef, useState} from 'react'
import type {
    MailAccount,
    MailAttachment,
    MailDraft,
    MailDraftSummary,
    MailFolder,
    MailItem,
    MailMessage,
    MailPage,
    MailQuery,
    MailScope
} from '../../shared/mail'
import {mailUploadBytes} from '../../shared/mail'
import {Icon} from './Icon'
import {replyRecipients} from './mail-reply'
import {ConfirmDialog} from './ConfirmDialog'
import {MailComposer} from './MailComposer'
import {MailContent} from './MailContent'
import {MailAttachmentPreview} from './MailAttachmentPreview'
import './styles/mail.css'

type View = MailScope | 'drafts'
const views: { id: View; label: string; icon: ComponentProps<typeof Icon>['name'] }[] = [
    {id: 'inbox', label: '收件箱', icon: 'inbox'}, {id: 'all', label: '全部邮件', icon: 'mail'},
    {id: 'starred', label: '收藏', icon: 'star'}, {id: 'sent', label: '已发送', icon: 'send'},
    {id: 'drafts', label: '草稿', icon: 'pencil'}, {id: 'trash', label: '垃圾箱', icon: 'trash'},
]
const timestamp = (value: string | null, full = false) => value ? new Date(value).toLocaleString('zh-CN', full ? {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
} : {month: 'numeric', day: 'numeric'}) : ''
const sizeLabel = (bytes: number) => bytes < 1024 * 1024 ? Math.max(1, Math.ceil(bytes / 1024)) + ' KB' : (bytes / (1024 * 1024)).toFixed(1) + ' MB'

function MailAction({icon, label, onClick, disabled, active}: {
    icon: ComponentProps<typeof Icon>['name'];
    label: string;
    onClick: () => void;
    disabled?: boolean;
    active?: boolean
}) {
    return <button type="button" className={'icon-button mail-action' + (active ? ' is-starred' : '')}
                   aria-label={label} title={label} disabled={disabled} onClick={onClick}><Icon name={icon}/></button>
}

function emptyDraft(accountId: string): MailDraft {
    return {
        id: crypto.randomUUID().replace(/-/g, ''),
        accountId,
        to: '',
        cc: '',
        bcc: '',
        subject: '',
        body: '',
        attachments: [],
        updatedAt: ''
    }
}

export function MailboxPage({onSettings}: { onSettings: () => void }) {
    const [accounts, setAccounts] = useState<MailAccount[]>([]), [accountId, setAccountId] = useState('')
    const [initialLoading, setInitialLoading] = useState(true), [initialError, setInitialError] = useState(''), [reloadAccounts, setReloadAccounts] = useState(0)
    const [view, setView] = useState<View>('inbox'), [folder, setFolder] = useState(''), [folders, setFolders] = useState<MailFolder[]>([])
    const [search, setSearch] = useState(''), [query, setQuery] = useState(''), [composing, setComposing] = useState(false), [unreadOnly, setUnreadOnly] = useState(false)
    const [items, setItems] = useState<MailItem[]>([]), [cursor, setCursor] = useState<string | null>(null), [loading, setLoading] = useState(false), [moreLoading, setMoreLoading] = useState(false)
    const [errors, setErrors] = useState<MailPage['errors']>([]), [listError, setListError] = useState(''), [actionError, setActionError] = useState(''), [notice, setNotice] = useState('')
    const [selected, setSelected] = useState<string | null>(null), [message, setMessage] = useState<MailMessage | null>(null), [bodyLoading, setBodyLoading] = useState(false), [bodyError, setBodyError] = useState(''), [bodyRetry, setBodyRetry] = useState(0)
    const [refresh, setRefresh] = useState(0), [busy, setBusy] = useState(''), [trashing, setTrashing] = useState<MailItem | null>(null)
    const [drafts, setDrafts] = useState<MailDraftSummary[]>([]), [draftReload, setDraftReload] = useState(0), [draftError, setDraftError] = useState('')
    const [editor, setEditor] = useState<MailDraft | null>(null), [preview, setPreview] = useState<{
        data: string;
        name: string;
        type: string
    } | null>(null)
    const [mobileFolders, setMobileFolders] = useState(false)
    const sidebar = useRef<HTMLElement>(null)
    const request = useRef(0), searchInput = useRef<HTMLInputElement>(null), list = useRef<HTMLDivElement>(null)
    const selection = useRef(selected);
    selection.current = selected
    const reportError = useCallback((error: string) => setActionError(error), [])
    useEffect(() => {
        if (!mobileFolders) return
        const element = sidebar.current,
            trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null
        element?.focus()
        const resize = () => {
            if (window.innerWidth > 900) setMobileFolders(false)
        }
        window.addEventListener('resize', resize)
        return () => {
            window.removeEventListener('resize', resize);
            trigger?.focus({preventScroll: true})
        }
    }, [mobileFolders])
    const accountKey = accounts.map(account => account.id).join(',')
    useEffect(() => {
        let current = true;
        setInitialLoading(true);
        setInitialError('')
        if (!window.mail) {
            setInitialError('邮箱服务不可用，请在 FduNav 桌面应用中使用。');
            setInitialLoading(false);
            return
        }
        void window.mail.accounts().then(result => {
            if (!current) return
            if (result.ok) setAccounts(result.data); else setInitialError(result.error)
        }).catch(() => {
            if (current) setInitialError('无法加载邮箱账号，请重试。')
        }).finally(() => {
            if (current) setInitialLoading(false)
        })
        return () => {
            current = false
        }
    }, [reloadAccounts])
    useEffect(() => {
        if (composing) return
        if (!search) {
            setQuery('');
            return
        }
        const timer = setTimeout(() => setQuery(search.trim()), 300)
        return () => clearTimeout(timer)
    }, [search, composing])
    useEffect(() => {
        let current = true
        if (!window.mail || !accounts.length) return
        void window.mail.folders(accountId ? [accountId] : undefined).then(result => {
            if (current && result.ok) setFolders(result.data.folders)
        }).catch(() => {
        })
        return () => {
            current = false
        }
    }, [accountKey, accountId, refresh])
    useEffect(() => {
        let current = true
        if (!window.mail || !accounts.length) return
        void window.mail.drafts().then(result => {
            if (!current) return
            if (result.ok) {
                setDrafts(result.data);
                setDraftError('')
            } else setDraftError(result.error)
        }).catch(() => {
            if (current) setDraftError('无法加载本地草稿，请重试。')
        })
        return () => {
            current = false
        }
    }, [accountKey, draftReload])
    const listQuery: MailQuery = {
        accountIds: accountId ? [accountId] : undefined, scope: view === 'drafts' ? 'inbox' : view,
        ...(folder ? {folder} : {}), query, unreadOnly, limit: 30
    }
    useEffect(() => {
        const sequence = ++request.current
        setSelected(null);
        setMessage(null);
        setBodyError('');
        setItems([]);
        setCursor(null);
        setMoreLoading(false);
        setErrors([]);
        setListError('')
        if (!window.mail || !accounts.length || view === 'drafts') {
            setLoading(false);
            return
        }
        setLoading(true)
        void window.mail.messages(listQuery).then(result => {
            if (request.current !== sequence) return
            if (result.ok) {
                setItems(result.data.items);
                setCursor(result.data.nextCursor);
                setErrors(result.data.errors)
            } else setListError(result.error)
        }).catch(() => {
            if (request.current === sequence) setListError('邮件列表加载失败，请重试。')
        }).finally(() => {
            if (request.current === sequence) setLoading(false)
        })
        return () => {
            if (request.current === sequence) request.current++
        }
    }, [accountKey, accountId, view, folder, query, unreadOnly, refresh])
    useEffect(() => {
        if (!selected || !window.mail) {
            setMessage(null);
            setBodyLoading(false);
            return
        }
        let current = true;
        setBodyLoading(true);
        setBodyError('');
        setMessage(null)
        void window.mail.message({id: selected, markRead: true}).then(result => {
            if (!current) return
            if (result.ok) {
                setMessage(result.data);
                setItems(before => before.map(item => item.id === selected ? {...item, read: result.data.read} : item))
                if (!result.data.read) return
                const previous = items.find(item => item.id === selected)
                if (previous && !previous.read) setFolders(before => before.map(folder => folder.accountId === previous.accountId && folder.path === previous.folder && folder.unread !== null ? {
                    ...folder,
                    unread: Math.max(0, folder.unread - 1)
                } : folder))
            } else setBodyError(result.error)
        }).catch(() => {
            if (current) setBodyError('邮件正文加载失败，请重试。')
        }).finally(() => {
            if (current) setBodyLoading(false)
        })
        return () => {
            current = false
        }
    }, [selected, bodyRetry])

    async function loadMore() {
        if (!window.mail || !cursor || loading || moreLoading) return
        const sequence = request.current;
        setMoreLoading(true)
        try {
            const result = await window.mail.messages({...listQuery, cursor})
            if (sequence !== request.current) return
            if (result.ok) {
                setItems(before => [...before, ...result.data.items.filter(item => !before.some(value => value.id === item.id))]);
                setCursor(result.data.nextCursor);
                setErrors(result.data.errors)
            } else setListError(result.error)
        } catch {
            if (sequence === request.current) setListError('加载更多邮件失败，请重试。')
        } finally {
            if (sequence === request.current) setMoreLoading(false)
        }
    }

    function navigate(next: View, path = '') {
        setView(next);
        setFolder(path);
        setMobileFolders(false);
        setActionError('');
        setNotice('')
    }

    async function flags(item: MailItem, patch: { read?: boolean; starred?: boolean }) {
        if (!window.mail || busy) return
        setBusy(item.id);
        setActionError('');
        setNotice('')
        try {
            const result = await window.mail.setFlags({id: item.id, ...patch})
            if (!result.ok) {
                setActionError(result.error);
                return
            }
            setItems(before => before.map(value => value.id === item.id ? {...value, ...patch} : value))
            setMessage(before => before?.id === item.id ? {...before, ...patch} : before)
            if (patch.read !== undefined && patch.read !== item.read) setFolders(before => before.map(folder => folder.accountId === item.accountId && folder.path === item.folder && folder.unread !== null ? {
                ...folder,
                unread: Math.max(0, folder.unread + (patch.read ? -1 : 1))
            } : folder))
            if ((view === 'starred' && patch.starred === false) || (unreadOnly && patch.read === true)) setNotice('标记已更新，刷新列表后将应用当前筛选。')
        } catch {
            setActionError('标记未能更新，请重试。')
        } finally {
            setBusy('')
        }
    }

    async function trash() {
        if (!window.mail || !trashing || busy) return
        const item = trashing;
        setBusy(item.id);
        setActionError('')
        try {
            const result = await window.mail.moveToTrash(item.id)
            if (!result.ok) {
                setActionError(result.error);
                return
            }
            setItems(before => before.filter(value => value.id !== item.id));
            setSelected(before => before === item.id ? null : before)
            setMessage(before => before?.id === item.id ? null : before);
            setTrashing(null);
            setNotice('邮件已移入垃圾箱。')
        } catch {
            setActionError('邮件未能移入垃圾箱，请重试。')
        } finally {
            setBusy('')
        }
    }

    function write() {
        const sender = accounts.find(value => value.id === accountId) ?? accounts.find(value => value.smtp) ?? accounts[0]
        if (sender) setEditor(emptyDraft(sender.id))
    }

    async function reply(mode: 'reply' | 'all' | 'forward') {
        if (!message || busy) return
        const original = message, sequence = request.current, draft = emptyDraft(original.accountId)
        draft.subject = (mode === 'forward' ? /^(?:fwd?|转发):/i.test(original.subject) : /^(?:re|回复):/i.test(original.subject)) ? original.subject : (mode === 'forward' ? 'Fwd: ' : 'Re: ') + original.subject
        const quoted = original.body.slice(0, 30000).split('\n').map(line => '> ' + line).join('\n')
        draft.body = '\n\n' + timestamp(original.receivedAt, true) + '，' + original.from + ' 写道：\n' + quoted + (original.body.length > 30000 ? '\n> （引用内容已截短）' : '')
        if (mode !== 'forward') {
            Object.assign(draft, replyRecipients(original, accounts, mode === 'all'))
        } else if (original.attachments.length) {
            if (original.attachments.length > 20) {
                setActionError('原邮件附件超过发送上限，请先下载附件后单独处理。');
                return
            }
            setBusy('forward');
            setNotice('正在准备转发附件…')
            try {
                for (const attachment of original.attachments) {
                    const result = await window.mail!.readAttachment({
                        id: original.id,
                        part: attachment.part,
                        forForward: true
                    })
                    if (!result.ok) throw new Error(result.error)
                    if (sequence !== request.current || selection.current !== original.id) return
                    draft.attachments.push(result.data)
                    if (draft.attachments.reduce((sum, value) => sum + mailUploadBytes(value.data), 0) > 20 * 1024 * 1024) throw new Error('原邮件附件总大小超过 20 MB，请先下载后单独处理。')
                }
            } catch (reason) {
                setActionError(reason instanceof Error ? reason.message : '无法准备转发附件。');
                return
            } finally {
                setBusy('');
                setNotice('')
            }
        }
        if (mode !== 'forward' && original.messageId) {
            draft.inReplyTo = original.messageId;
            draft.references = [...new Set([...original.references, original.messageId])].slice(-100)
        }
        setEditor(draft)
    }

    async function openDraft(id: string) {
        if (!window.mail || busy) return
        setBusy('draft');
        setActionError('')
        try {
            const result = await window.mail.draft(id);
            if (result.ok) setEditor(result.data); else setActionError(result.error)
        } catch {
            setActionError('无法打开草稿，请重试。')
        } finally {
            setBusy('')
        }
    }

    async function attachment(item: MailAttachment, previewOnly: boolean) {
        if (!window.mail || !message || busy) return
        const selectedId = message.id
        setBusy('attachment:' + item.part);
        setActionError('');
        setNotice('')
        try {
            if (previewOnly) {
                const result = await window.mail.readAttachment({id: message.id, part: item.part})
                if (selection.current !== selectedId) return
                if (result.ok) setPreview(result.data); else setActionError(result.error)
            } else {
                const result = await window.mail.downloadAttachment({id: message.id, part: item.part})
                if (!result.ok) setActionError(result.error); else if (result.data.saved) setNotice('附件已保存。')
            }
        } catch {
            setActionError('附件加载失败，请重试。')
        } finally {
            setBusy('')
        }
    }

    const draftItems = drafts.filter(draft => (!accountId || draft.accountId === accountId) && (!query || [draft.to, draft.subject, draft.preview].some(value => value.toLowerCase().includes(query.toLowerCase()))))
    const title = folder ? folders.find(value => value.path === folder)?.name ?? folder : views.find(value => value.id === view)!.label
    const inboxUnread = folders.filter(value => value.path.toUpperCase() === 'INBOX' || value.specialUse === '\\Inbox').reduce((sum, value) => sum + (value.unread ?? 0), 0)
    const unreadTotal = (list: MailFolder[]) => list.reduce((sum, value) => sum + (value.unread ?? 0), 0)
    const unreadCount = (() => {
        if (folder) return unreadTotal(folders.filter(value => value.path === folder))
        if (view === 'inbox') return inboxUnread
        if (view === 'sent') return unreadTotal(folders.filter(value => value.specialUse === '\\Sent' || /^(?:sent(?: messages| items)?|已发送|发件箱)$/i.test(value.path)))
        if (view === 'trash') return unreadTotal(folders.filter(value => value.specialUse === '\\Trash' || /^(?:trash|deleted(?: messages| items)?|已删除|废纸篓)$/i.test(value.path)))
        if (view === 'all') return unreadTotal(folders.filter(value => !['\\Trash', '\\Junk'].includes(value.specialUse ?? '') && !/^(?:trash|junk|spam|已删除|垃圾邮件|垃圾箱)$/i.test(value.path)))
        return items.filter(item => !item.read).length
    })()
    if (initialLoading) return <div className="mailbox-initial" role="status"><Icon name="mail"/><p>正在加载邮箱…</p>
    </div>
    if (initialError) return <div className="mailbox-initial"><Icon name="mail"/><h2>暂时无法打开邮箱</h2><p
        role="alert" className="account-error">{initialError}</p>
        <button type="button" className="secondary-button"
                onClick={() => setReloadAccounts(value => value + 1)}>重新加载
        </button>
    </div>
    if (!accounts.length) return <div className="mailbox-initial"><Icon name="mail"/><h2>暂无邮箱</h2>
        <button type="button" className="primary-button" onClick={onSettings}><Icon name="settings"/>打开设置</button>
    </div>
    return <div
        className={'mailbox-workspace' + (selected ? ' has-selection' : '') + (mobileFolders ? ' show-folders' : '')}>
        {mobileFolders &&
            <button type="button" className="mailbox-folder-backdrop" aria-label="关闭文件夹" tabIndex={-1}
                    onClick={() => setMobileFolders(false)}/>}
        <aside ref={sidebar} tabIndex={-1} role={mobileFolders ? 'dialog' : undefined}
               aria-modal={mobileFolders || undefined} className="mailbox-sidebar" aria-label="邮箱与文件夹"
               onKeyDown={event => {
                   if (!mobileFolders) return
                   if (event.key === 'Escape') {
                       event.preventDefault();
                       setMobileFolders(false)
                   }
                   if (event.key === 'Tab') {
                       const targets = Array.from(sidebar.current?.querySelectorAll<HTMLElement>('button:not(:disabled),select,summary') ?? []).filter(item => item.getClientRects().length > 0)
                       const index = targets.indexOf(document.activeElement as HTMLElement)
                       if (event.shiftKey && index <= 0) {
                           event.preventDefault();
                           targets.at(-1)?.focus()
                       } else if (!event.shiftKey && (index < 0 || index === targets.length - 1)) {
                           event.preventDefault();
                           targets[0]?.focus()
                       }
                   }
               }}>
            <header><h2>邮箱</h2><MailAction icon="close" label="关闭文件夹" onClick={() => setMobileFolders(false)}/>
            </header>
            <button type="button" className="primary-button mailbox-compose-button" onClick={write}><Icon
                name="pencil"/>写邮件
            </button>
            <label className="sr-only" htmlFor="mailbox-account">选择邮箱账号</label><select id="mailbox-account"
                                                                                             value={accountId}
                                                                                             onChange={event => {
                                                                                                 setAccountId(event.target.value);
                                                                                                 setFolder('');
                                                                                                 setMobileFolders(false)
                                                                                             }}>
            <option value="">全部账号</option>
            {accounts.map(account => <option key={account.id} value={account.id}>{account.label}</option>)}</select>
            <nav aria-label="邮件分类">{views.map(value => <button type="button" key={value.id}
                                                                   className={'mailbox-nav-item' + (view === value.id && !folder ? ' is-active' : '')}
                                                                   aria-current={view === value.id && !folder ? 'page' : undefined}
                                                                   onClick={() => navigate(value.id)}><Icon
                name={value.icon}/><span>{value.label}</span>
                {value.id === 'inbox' && inboxUnread > 0 ? <span
                    className="mailbox-nav-count">{inboxUnread}</span> : value.id === 'drafts' && drafts.length > 0 ?
                    <span
                        className="mailbox-nav-count">{drafts.filter(draft => !accountId || draft.accountId === accountId).length}</span> : null}
            </button>)}</nav>
            {accountId && folders.length > 0 && <details className="mailbox-folder-tree">
                <summary>文件夹</summary>
                {folders.filter(value => value.accountId === accountId).map(value => <button type="button"
                                                                                             key={value.path}
                                                                                             className={'mailbox-nav-item' + (folder === value.path ? ' is-active' : '')}
                                                                                             onClick={() => navigate('all', value.path)}>
                    <Icon name="folder"/><span>{value.name}</span>{!!value.unread &&
                    <span className="mailbox-nav-count">{value.unread}</span>}</button>)}</details>}
        </aside>
        <section inert={mobileFolders || undefined} className="mailbox-list-pane" aria-label={title + '邮件列表'}>
            <header className="mailbox-list-heading">
                <div><MailAction icon="panel" label="显示邮箱与文件夹" onClick={() => setMobileFolders(true)}/>
                    <h2>{title}</h2></div>
                <MailAction icon="refresh" label="刷新邮件" disabled={loading || moreLoading} onClick={() => {
                    setRefresh(value => value + 1);
                    setDraftReload(value => value + 1)
                }}/></header>
            <div className="mailbox-search"><Icon name="search"/><label className="sr-only"
                                                                        htmlFor="mailbox-search">搜索邮件</label><input
                ref={searchInput} id="mailbox-search" type="search" value={search} maxLength={200}
                placeholder={view === 'drafts' ? '搜索草稿' : accountId ? '搜索当前邮箱' : '搜索全部账号'}
                onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)}
                onChange={event => {
                    setSearch(event.target.value);
                    if (!event.target.value) setQuery('')
                }} onKeyDown={event => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) setQuery(search.trim())
            }}/>
                {search && <MailAction icon="close" label="清空搜索" onClick={() => {
                    setSearch('');
                    setQuery('');
                    searchInput.current?.focus()
                }}/>}</div>
            {view !== 'drafts' && <div className="mailbox-list-meta"><span>{unreadCount} 封未读</span>
                <button type="button" className={'mailbox-filter' + (unreadOnly ? ' is-active' : '')}
                        aria-pressed={unreadOnly} onClick={() => setUnreadOnly(!unreadOnly)}>仅未读
                </button>
            </div>}
            {(listError || (view === 'drafts' && draftError)) &&
                <div className="mailbox-inline-error" role="alert"><p>{view === 'drafts' ? draftError : listError}</p>
                    <button type="button" className="mail-text-button" onClick={() => {
                        setRefresh(value => value + 1);
                        setDraftReload(value => value + 1)
                    }}>重试
                    </button>
                </div>}
            {errors.length > 0 && <details className="mailbox-partial-error">
                <summary>{errors.length} 个邮箱未能加载</summary>
                {errors.map(error => <p key={error.accountId}>{error.address}：{error.message}</p>)}
                <button type="button" className="mail-text-button"
                        onClick={() => setRefresh(value => value + 1)}>重新加载
                </button>
            </details>}
            <div className="mailbox-action-feedback mailbox-list-feedback" aria-live="polite">{actionError &&
                <p role="alert" className="account-error">{actionError}</p>}{notice &&
                <p role="status">{notice}</p>}</div>
            <div className="mailbox-message-list" ref={list} aria-busy={loading} onKeyDown={event => {
                if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
                const buttons = Array.from(list.current?.querySelectorAll<HTMLButtonElement>('.mail-row-open') ?? []),
                    index = buttons.indexOf(document.activeElement as HTMLButtonElement)
                if (index < 0) return
                event.preventDefault();
                buttons[Math.max(0, Math.min(buttons.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus()
            }}>
                {loading ? <div className="mailbox-list-empty"
                                role="status">正在加载邮件…</div> : view === 'drafts' ? draftItems.length ? draftItems.map(draft =>
                    <div className="mail-row" key={draft.id}>
                        <button type="button" className="mail-row-open" disabled={busy === 'draft'}
                                onClick={() => void openDraft(draft.id)}><span
                            className="mail-row-top"><strong>{draft.to || '未填写收件人'}</strong><time>{timestamp(draft.updatedAt)}</time></span><span
                            className="mail-row-subject">{draft.subject || '（无主题）'}</span><span
                            className="mail-row-preview">{draft.sendState ? '发送结果待确认，请先核对已发送邮件' : draft.preview || '空白草稿'}</span>
                        </button>
                    </div>) : <div className="mailbox-list-empty"><Icon name="pencil"/>
                    <p>{query ? '没有匹配的草稿' : '暂无草稿'}</p></div> : items.length ? items.map(item => <div
                    key={item.id}
                    className={'mail-row' + (selected === item.id ? ' is-selected' : '') + (!item.read ? ' is-unread' : '')}>
                    <button type="button" className="mail-row-open"
                            aria-current={selected === item.id ? 'true' : undefined} onClick={() => {
                        setSelected(item.id);
                        setMobileFolders(false)
                    }}><span className="mail-row-top"><strong>{!item.read && <span className="mail-unread-dot"
                                                                                   aria-label="未读"/>}{item.from.split('<')[0].trim() || item.fromAddress || '未知发件人'}</strong><time
                        dateTime={item.receivedAt ?? undefined}>{timestamp(item.receivedAt)}</time></span>
                        <span className="mail-row-subject">{item.subject}</span><span
                            className="mail-row-bottom"><span>{!accountId ? accounts.find(account => account.id === item.accountId)?.label ?? item.accountAddress : item.folder === 'INBOX' ? '收件箱' : item.folder}</span>{item.hasAttachments &&
                            <span title="有附件"><Icon name="attachment"/></span>}</span></button>
                    <MailAction icon="star" label={item.starred ? '取消收藏' : '收藏邮件'} active={item.starred}
                                disabled={!!busy} onClick={() => void flags(item, {starred: !item.starred})}/>
                </div>) : !listError && <div className="mailbox-list-empty"><Icon name={query ? 'search' : 'inbox'}/>
                    <p>{query ? '没有找到匹配的邮件' : unreadOnly ? '没有未读邮件' : errors.length ? '暂无邮件' : '这里暂无邮件'}</p>{query &&
                        <button type="button" className="mail-text-button" onClick={() => {
                            setSearch('');
                            setQuery('')
                        }}>清空搜索</button>}</div>}
                {cursor && !loading && view !== 'drafts' &&
                    <button type="button" className="mailbox-load-more" disabled={moreLoading}
                            onClick={() => void loadMore()}>{moreLoading ? '正在加载…' : '加载更多'}</button>}
            </div>
        </section>
        <section inert={mobileFolders || undefined} className="mailbox-reader" aria-label="邮件阅读区"
                 aria-busy={bodyLoading}>
            <header className="mailbox-reader-toolbar">
                <div><span className="mailbox-back"><MailAction icon="arrow" label="返回邮件列表" onClick={() => {
                    setSelected(null);
                    setMessage(null)
                }}/></span>
                    {message && <><MailAction icon="star" label={message.starred ? '取消收藏' : '收藏邮件'}
                                              active={message.starred} disabled={!!busy}
                                              onClick={() => void flags(message, {starred: !message.starred})}/>
                        <MailAction icon="mail" label={message.read ? '标记为未读' : '标记为已读'} disabled={!!busy}
                                    onClick={() => void flags(message, {read: !message.read})}/>
                        <MailAction icon="trash" label="移入垃圾箱" disabled={!!busy || view === 'trash'}
                                    onClick={() => setTrashing(message)}/></>}
                </div>
                {message && <button type="button" className="secondary-button mail-reader-reply" disabled={!!busy}
                                    onClick={() => void reply('reply')}><Icon name="reply"/>回复</button>}</header>
            <div className="mailbox-action-feedback" aria-live="polite">{actionError &&
                <p role="alert" className="account-error">{actionError}</p>}{notice &&
                <p role="status">{notice}</p>}</div>
            <div className="mailbox-reader-scroll">
                {bodyLoading ?
                    <div className="mailbox-reader-empty" role="status"><Icon name="mail"/><p>正在加载正文…</p>
                    </div> : bodyError ?
                        <div className="mailbox-reader-empty"><p role="alert" className="account-error">{bodyError}</p>
                            <button type="button" className="secondary-button"
                                    onClick={() => setBodyRetry(value => value + 1)}>重试
                            </button>
                        </div> : message ? <article className="mailbox-message">
                                <div className="mail-message-account"><Icon name="user"/>{message.accountAddress}</div>
                                <h1>{message.subject}</h1>
                                <div className="mail-message-sender"><span className="mail-sender-avatar"
                                                                           aria-hidden="true">{(message.from.split('<')[0].trim() || message.fromAddress).slice(0, 1).toUpperCase() || '?'}</span>
                                    <div><strong>{message.from}</strong>{message.to && <p>收件人：{message.to}</p>}</div>
                                    <time
                                        dateTime={message.receivedAt ?? undefined}>{timestamp(message.receivedAt, true)}</time>
                                </div>
                                {message.cc.length > 0 && <p className="mail-message-cc">抄送：{message.cc.join(', ')}</p>}
                                {message.truncated &&
                                    <p className="mail-message-note">仅显示部分正文</p>}{message.remoteImagesBlocked &&
                                <p className="mail-message-note">已屏蔽外部图片</p>}
                                <MailContent message={message} onError={reportError}/>
                                {message.attachments.length > 0 &&
                                    <section className="mail-message-attachments" aria-label="附件"><h3><Icon
                                        name="attachment"/>{message.attachments.length} 个附件
                                    </h3>{message.attachments.map(item => <div className="mail-attachment-row"
                                                                               key={item.part}>
                                        <span><strong>{item.name}</strong><small>{sizeLabel(item.size)}</small></span>
                                        {(/^(?:image\/(?:png|jpeg|gif|webp)|application\/pdf)$/i.test(item.type)) &&
                                            <button type="button" className="mail-text-button" disabled={!!busy}
                                                    onClick={() => void attachment(item, true)}>预览</button>}
                                        <button type="button" className="mail-text-button" disabled={!!busy}
                                                onClick={() => void attachment(item, false)}>{busy === 'attachment:' + item.part ? '正在加载…' : '下载'}</button>
                                    </div>)}</section>}
                                <footer className="mail-message-reply-actions">
                                    <button type="button" className="secondary-button" disabled={!!busy}
                                            onClick={() => void reply('reply')}><Icon name="reply"/>回复
                                    </button>
                                    <button type="button" className="secondary-button" disabled={!!busy}
                                            onClick={() => void reply('all')}>回复全部
                                    </button>
                                    <button type="button" className="secondary-button" disabled={!!busy}
                                            onClick={() => void reply('forward')}><Icon name="forward"/>转发
                                    </button>
                                </footer>
                            </article> :
                            <div className="mailbox-reader-empty"><Icon name={view === 'drafts' ? 'pencil' : 'mail'}/>
                                <h3>{view === 'drafts' ? '未选择草稿' : '未选择邮件'}</h3></div>}
            </div>
        </section>
        {editor && <MailComposer key={editor.id} initial={editor} accounts={accounts} onClose={() => {
            setEditor(null);
            setDraftReload(value => value + 1)
        }} onDraftChange={() => setDraftReload(value => value + 1)} onSent={result => {
            setNotice(result.message);
            setRefresh(value => value + 1)
        }} onViewSent={() => navigate('sent')}/>}
        {preview && <MailAttachmentPreview attachment={preview} onClose={() => setPreview(null)}/>}
        {trashing && <ConfirmDialog title="移入垃圾箱？"
                                    message={'“' + trashing.subject + '”将移到所属邮箱的垃圾箱，可在该邮箱中恢复。'}
                                    confirmLabel="移入垃圾箱" danger busy={!!busy} onCancel={() => setTrashing(null)}
                                    onConfirm={() => void trash()}/>}
    </div>
}
