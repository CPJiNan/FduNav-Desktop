import {useEffect, useRef, useState} from 'react'
import type {ChatSession} from '../../shared/chat'
import {Icon} from './Icon'
import {ConfirmDialog} from './ConfirmDialog'
import {ChatMenu} from './ChatMenu'

export type SessionAction = { kind: 'create' } | { kind: 'select' | 'delete'; id: string } |
    { kind: 'rename'; id: string; title: string }

export function ChatHistory({sessions, selectedId, disabled, onAction, onClose}: {
    sessions: ChatSession[]; selectedId: string; disabled: boolean
    onAction: (action: SessionAction) => Promise<boolean>; onClose: () => void
}) {
    const [query, setQuery] = useState('')
    const [searchOpen, setSearchOpen] = useState(false)
    const [action, setAction] = useState<{ kind: 'rename' | 'delete'; session: ChatSession } | null>(null)
    const [title, setTitle] = useState('')
    const [error, setError] = useState('')
    const dialog = useRef<HTMLDialogElement>(null)
    const sidebar = useRef<HTMLElement>(null)
    const search = useRef<HTMLInputElement>(null)
    const searchTrigger = useRef<HTMLButtonElement>(null)
    const list = useRef<HTMLElement>(null)
    useEffect(() => {
        list.current?.querySelector('[aria-current="page"]')?.scrollIntoView({block: 'nearest'})
    }, [selectedId, query])
    useEffect(() => {
        if (searchOpen) search.current?.focus()
    }, [searchOpen])
    useEffect(() => {
        if (action?.kind === 'rename') dialog.current?.showModal()
    }, [action])
    useEffect(() => {
        if (action) return
        const dismiss = (event: MouseEvent) => {
            const target = event.target
            if (!(target instanceof Element) || sidebar.current?.contains(target)) return
            // Portalled session menus belong to the sidebar. The toggle handles itself.
            if (target.closest('[data-chat-menu-owner="chat-history"], button[aria-controls="chat-history"]')) return
            onClose()
        }
        document.addEventListener('click', dismiss, true)
        return () => document.removeEventListener('click', dismiss, true)
    }, [action, onClose])

    async function perform() {
        if (!action || disabled) return
        const ok = await onAction(action.kind === 'delete' ? {kind: 'delete', id: action.session.id}
            : {kind: 'rename', id: action.session.id, title: title.trim()})
        if (ok) setAction(null)
        else setError('操作未完成，请关闭窗口查看错误详情后重试。')
    }

    const filtered = sessions.filter(item => item.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))

    function beginAction(kind: 'rename' | 'delete', session: ChatSession) {
        setAction({kind, session})
        setTitle(session.title)
        setError('')
    }

    return <aside ref={sidebar} className="chat-history" id="chat-history" aria-label="历史对话">
        <header><strong className="chat-history-brand">FduNav</strong>
            <div className="chat-history-tools">
                <button ref={searchTrigger} type="button" className="icon-button" aria-label="搜索历史对话"
                        title="搜索历史对话"
                        aria-expanded={searchOpen} aria-controls="chat-history-search" onClick={() => {
                    setSearchOpen(value => !value)
                    setQuery('')
                }}><Icon name="search"/></button>
                <button type="button" className="icon-button" aria-label="收起历史对话" title="收起历史对话"
                        onClick={onClose}><Icon name="panel"/></button>
            </div>
        </header>
        <button type="button" className="chat-new-session" disabled={disabled}
                onClick={() => {
                    setQuery('');
                    void onAction({kind: 'create'})
                }}><Icon name="square-pen"/>新对话
        </button>
        {searchOpen && <input ref={search} id="chat-history-search" className="chat-history-search" type="search"
                              aria-label="搜索对话" placeholder="搜索对话名称"
                              value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => {
            if (event.key === 'Escape') {
                setSearchOpen(false);
                setQuery('');
                searchTrigger.current?.focus()
            }
        }}/>}
        <nav ref={list} aria-label="对话列表">
            <h2 className="chat-history-heading">{query.trim() ? '搜索结果' : '最近对话'}</h2>
            {filtered.map(item =>
                <div className="chat-history-row" key={item.id} data-selected={item.id === selectedId}>
                    <button type="button" className="chat-history-select" title={item.title}
                            aria-current={item.id === selectedId ? 'page' : undefined} disabled={disabled}
                            onClick={() => void onAction({kind: 'select', id: item.id})}>
                        <Icon name="chat"/><span>{item.title}</span>
                        {item.busy && <span className="chat-history-busy" role="status" aria-label="正在处理"/>}
                    </button>
                    <div className="chat-history-actions">
                        <ChatMenu ownerId="chat-history" label={`对话选项：${item.title}`} disabled={disabled} items={[
                            {label: '重命名', icon: 'pencil', onSelect: () => beginAction('rename', item)},
                            {
                                label: '删除对话', icon: 'trash', danger: true, disabled: item.busy,
                                onSelect: () => beginAction('delete', item)
                            }
                        ]}/>
                    </div>
                </div>)}
            {!filtered.length &&
                <p className="chat-history-empty">{query.trim() ? '没有匹配的对话' : '新建对话，开始聊聊吧'}</p>}
        </nav>
        {action?.kind === 'delete' && <ConfirmDialog title="删除对话"
                                                     message={error || `确定删除“${action.session.title}”吗？`}
                                                     confirmLabel="删除" danger busy={disabled}
                                                     onCancel={() => setAction(null)}
                                                     onConfirm={() => void perform()}/>}
        {action?.kind === 'rename' &&
            <dialog ref={dialog} className="calendar-dialog chat-rename-dialog" aria-label="重命名对话"
                    onCancel={event => {
                        if (disabled) event.preventDefault(); else setAction(null)
                    }} onClose={() => setAction(null)}>
                <form onSubmit={event => {
                    event.preventDefault();
                    void perform()
                }}>
                    <div className="calendar-dialog-header"><strong>重命名对话</strong></div>
                    <label>对话名称<input autoFocus required maxLength={80} value={title} disabled={disabled}
                                          onChange={event => setTitle(event.target.value)}/></label>
                    {error && <p className="chat-error" role="alert">{error}</p>}
                    <div className="calendar-dialog-actions">
                        <button type="button" className="secondary-button" disabled={disabled}
                                onClick={() => setAction(null)}>取消
                        </button>
                        <button type="submit" className="primary-button" disabled={disabled || !title.trim()}>保存名称
                        </button>
                    </div>
                </form>
            </dialog>}
    </aside>
}
