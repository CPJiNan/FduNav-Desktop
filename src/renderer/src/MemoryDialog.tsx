import {type FormEvent, useEffect, useRef, useState} from 'react'
import {type Memory, type MemoryState, validateMemory} from '../../shared/memory'
import {Icon} from './Icon'

export function MemoryDialog({item, onClose, onSaved}: {
    item: Memory; onClose: () => void; onSaved: (state: MemoryState) => void
}) {
    const dialog = useRef<HTMLDialogElement>(null)
    const [draft, setDraft] = useState<Memory>(item)
    const [error, setError] = useState('')
    const [busy, setBusy] = useState(false)
    useEffect(() => {
        dialog.current?.showModal()
    }, [])

    function change<K extends keyof Memory>(key: K, value: Memory[K]) {
        setDraft(current => ({...current, [key]: value}));
        setError('')
    }

    async function save(event: FormEvent) {
        event.preventDefault()
        if (busy) return
        if (!window.memory) {
            setError('记忆服务未加载，请重启应用。');
            return
        }
        const checked = validateMemory(draft)
        if (!checked.ok) {
            setError(checked.error);
            return
        }
        setBusy(true);
        setError('')
        try {
            const result = await window.memory.save(draft)
            if (!result.ok) setError(result.error)
            else {
                onSaved(result.data);
                onClose()
            }
        } catch {
            setError('无法保存记忆，请重试。')
        } finally {
            setBusy(false)
        }
    }

    return <dialog className="calendar-dialog" ref={dialog} aria-label="编辑记忆"
                   onCancel={event => {
                       if (busy) event.preventDefault()
                   }} onClose={onClose}
                   onClick={event => {
                       if (!busy && event.target === dialog.current) onClose()
                   }}>
        <div className="calendar-dialog-header">
            <strong>编辑记忆</strong>
            <button type="button" className="icon-button" aria-label="关闭编辑记忆" disabled={busy}
                    onClick={onClose}><Icon name="close"/></button>
        </div>
        <form className="calendar-event-form" onSubmit={save}>
            <label>内容<textarea autoFocus rows={4} value={draft.text} maxLength={600} disabled={busy}
                                 onChange={event => change('text', event.target.value)}/></label>
            <label>依据<textarea rows={2} value={draft.evidence} maxLength={1000} disabled={busy}
                                 onChange={event => change('evidence', event.target.value)}/></label>
            <label>类型<select value={draft.kind} disabled={busy}
                               onChange={event => change('kind', event.target.value as Memory['kind'])}>
                <option value="fact">事实</option>
                <option value="preference">偏好</option>
                <option value="event">事项</option>
            </select></label>
            <label>可信度<input type="number" min={0} max={1} step={0.1} value={draft.confidence} disabled={busy}
                                onChange={event => change('confidence', Number(event.target.value))}/></label>
            <label>到期时间<input type="text" value={draft.expiresAt ?? ''} disabled={busy}
                                  placeholder="2026-12-31T23:59:00+08:00"
                                  onChange={event => change('expiresAt', event.target.value || null)}/></label>
            <label>状态<select value={draft.status} disabled={busy}
                               onChange={event => change('status', event.target.value as Memory['status'])}>
                <option value="active">有效</option>
                <option value="archived">归档</option>
            </select></label>
            {error && <p className="account-error" role="alert">{error}</p>}
            <div className="calendar-dialog-actions">
                <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>取消</button>
                <button type="submit" className="primary-button" disabled={busy}>{busy ? '正在保存…' : '保存'}</button>
            </div>
        </form>
    </dialog>
}
