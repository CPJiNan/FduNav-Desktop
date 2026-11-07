import {useEffect, useRef} from 'react'
import {Icon} from './Icon'

export function ConfirmDialog({
                                  title, message, confirmLabel = '确认', busy = false, danger = false,
                                  onConfirm, onCancel
                              }: {
    title: string
    message: string
    confirmLabel?: string
    busy?: boolean
    danger?: boolean
    onConfirm: () => void
    onCancel: () => void
}) {
    const dialog = useRef<HTMLDialogElement>(null)
    useEffect(() => {
        dialog.current?.showModal()
    }, [])

    return <dialog className="calendar-dialog confirm-dialog" ref={dialog} aria-label={title}
                   onCancel={event => {
                       if (busy) event.preventDefault()
                       else onCancel()
                   }} onClose={onCancel}
                   onClick={event => {
                       if (!busy && event.target === dialog.current) onCancel()
                   }}>
        <div className="calendar-dialog-header">
            <strong>{title}</strong>
            <button type="button" className="icon-button" aria-label="关闭" disabled={busy}
                    onClick={onCancel}><Icon name="close"/></button>
        </div>
        <p className="confirm-dialog-message">{message}</p>
        <div className="calendar-dialog-actions">
            <button type="button" className="secondary-button" disabled={busy} onClick={onCancel}>取消</button>
            <button type="button" className={danger ? 'primary-button calendar-delete' : 'primary-button'}
                    disabled={busy} onClick={onConfirm}>{busy ? '处理中…' : confirmLabel}</button>
        </div>
    </dialog>
}
