import {useEffect, useRef} from 'react'
import type {Memory} from '../../shared/memory'
import {Icon} from './Icon'

const kinds = {fact: '事实', preference: '偏好', event: '事项'}

export function MemoryListDialog({items, busy, error, nestedOpen, onClose, onEdit, onRemove, onPin}: {
    items: Memory[]; busy: boolean; error: string; nestedOpen: boolean
    onClose: () => void; onEdit: (item: Memory) => void; onRemove: (item: Memory) => void; onPin: (item: Memory) => void
}) {
    const dialog = useRef<HTMLDialogElement>(null)
    const title = useRef<HTMLHeadingElement>(null)
    const lastAction = useRef<HTMLButtonElement | null>(null)
    useEffect(() => {
        const element = dialog.current!, trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null
        element.showModal(); title.current?.focus()
        return () => {element.close(); trigger?.focus({preventScroll: true})}
    }, [])
    useEffect(() => {
        const element = dialog.current
        if (!nestedOpen && element?.matches(':modal') && !element.contains(document.activeElement)) {
            (lastAction.current?.isConnected ? lastAction.current : title.current)?.focus({preventScroll: true})
        }
    }, [items, nestedOpen])
    return <dialog ref={dialog} className="calendar-dialog memory-list-dialog" aria-labelledby="memory-list-title"
                   aria-describedby="memory-list-description" onClose={() => {if (!dialog.current?.open) onClose()}}
                   onClickCapture={event => {if (event.target instanceof Element) lastAction.current = event.target.closest('button')}}
                   onCancel={event => {event.preventDefault(); if (!busy) onClose()}}
                   onClick={event => {if (!busy && event.target === dialog.current) onClose()}}>
        <div className="calendar-dialog-header memory-list-header">
            <div><h3 ref={title} tabIndex={-1} id="memory-list-title">记忆列表 <span>共 {items.length} 条</span></h3>
                <p id="memory-list-description">查看和管理已保存的记忆。</p></div>
            <button type="button" className="icon-button" title="关闭" aria-label="关闭记忆列表" disabled={busy} onClick={onClose}><Icon name="close"/></button>
        </div>
        <div className="memory-list-body" aria-busy={busy}>
            {error && <p className="chat-error" role="alert">{error}</p>}
            {!items.length ? <div className="memory-list-empty"><Icon name="book"/><p>还没有记忆</p>
                <small>保存的记忆会显示在这里，也可以关闭后导入 JSON 文件。</small></div>
                : <ul className="memory-list">{items.map(item => <li key={item.id}>
                    <div className="memory-row-heading"><p>{item.text}</p><div className="memory-actions">
                        <button type="button" className="icon-button" title="编辑" aria-label={`编辑记忆：${item.text}`} disabled={busy} onClick={() => onEdit(item)}><Icon name="pencil"/></button>
                        <button type="button" className="icon-button" title={item.pinned ? '取消置顶' : '置顶'} aria-label={`${item.pinned ? '取消置顶' : '置顶'}：${item.text}`} aria-pressed={item.pinned} disabled={busy} onClick={() => onPin(item)}><Icon name="pin"/></button>
                        <button type="button" className="icon-button memory-remove" title="删除" aria-label={`删除记忆：${item.text}`} disabled={busy} onClick={() => onRemove(item)}><Icon name="close"/></button>
                    </div></div>
                    <div className="memory-row-support"><div className="memory-row-meta"><span>{kinds[item.kind]}</span>
                        {item.pinned && <span>已置顶</span>}{item.status === 'archived' ? <span>已归档</span>
                            : item.expiresAt && Date.parse(item.expiresAt) <= Date.now() && <span>已过期</span>}</div>
                        {item.evidence && <details className="memory-evidence"><summary>查看依据</summary><p>{item.evidence}</p></details>}</div>
                </li>)}</ul>}
        </div>
    </dialog>
}
