import {useEffect, useRef, useState} from 'react'
import type {Memory, MemoryState} from '../../shared/memory'
import type {Result} from '../../shared/accounts'
import {downloadJson} from './ChatTracePanel'
import {MemoryListDialog} from './MemoryListDialog'
import {MemoryDialog} from './MemoryDialog'
import {ConfirmDialog} from './ConfirmDialog'

export function MemoryPanel({active}: { active: boolean }) {
    const [state, setState] = useState<MemoryState>({username: '', enabled: false, items: []})
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')
    const [loaded, setLoaded] = useState(false)
    const [editing, setEditing] = useState<Memory | null>(null)
    const [deleting, setDeleting] = useState('')
    const [retry, setRetry] = useState(0)
    const [notice, setNotice] = useState('')
    const [listOpen, setListOpen] = useState(false)
    const importInput = useRef<HTMLInputElement>(null)
    useEffect(() => {
        if (!active) return
        if (!window.memory) {
            setError('记忆服务未加载，请重启应用。');
            return
        }
        let current = true
        setLoaded(false);
        setError('')
        void window.memory?.get().then(result => {
            if (!current) return
            if (result.ok) {
                setState(result.data);
                setLoaded(true)
            } else setError(result.error)
        }).catch(() => {
            if (current) setError('无法读取记忆。')
        })
        return () => {
            current = false
        }
    }, [active, retry])

    async function update(action: () => Promise<Result<MemoryState> | undefined> | undefined) {
        if (busy) return
        setBusy(true);
        setError('');
        setNotice('')
        try {
            const result = await action()
            if (!result) throw new Error('记忆服务不可用。')
            if (result.ok) {
                setState(result.data);
                setEditing(null);
                setDeleting('')
            } else setError(result.error)
        } catch (error) {
            setError(error instanceof Error ? error.message : '记忆更新失败。')
        } finally {
            setBusy(false)
        }
    }

    async function confirmRemove() {
        const id = deleting
        if (!id) return
        await update(() => window.memory?.remove(id))
        setDeleting('')
    }

    async function importFile(file: File) {
        if (file.size > 1024 * 1024) {
            setError('文件须小于 1 MiB。');
            return
        }
        setNotice('')
        const before = state.items.length
        await update(async () => {
            const result = await window.memory?.importJson(await file.text(), state.username)
            if (result?.ok) {
                const added = Math.max(0, result.data.items.length - before)
                setNotice(added ? `已导入 ${added} 条记忆。` : '没有新增记忆，可能与现有记忆重复。')
            }
            return result
        })
    }

    return <section className="agent-settings" aria-label="记忆管理">
        <h3>记忆</h3>
        <div className="llm-field llm-enable-field">
            <label id="memory-enable-label" htmlFor="memory-enable">启用</label>
            <button id="memory-enable" type="button" role="switch" className="llm-switch"
                    aria-labelledby="memory-enable-label" aria-checked={state.enabled}
                    disabled={busy || !loaded}
                    onClick={() => void update(() => window.memory?.setEnabled(!state.enabled))}>
                <span className="llm-switch-track" aria-hidden="true"><span/></span>
            </button>
        </div>
        <div className="trace-toolbar memory-toolbar">
            <button type="button" className="secondary-button" disabled={busy || !loaded} aria-haspopup="dialog"
                    onClick={() => setListOpen(true)}>记忆列表 <span className="memory-count">{state.items.length}</span></button>
            <button type="button" className="secondary-button" disabled={busy || !loaded}
                    onClick={() => {
                        setError('');
                        setNotice('')
                        void window.memory?.exportJson().then(result => {
                            if (result.ok) downloadJson(JSON.parse(result.data), 'fdunav-memories.json')
                            else setError(result.error)
                        }).catch(() => setError('导出记忆失败。'))
                    }}>导出 JSON
            </button>
            <button type="button" className="secondary-button" disabled={busy || !loaded}
                    onClick={() => importInput.current?.click()}>导入 JSON
            </button>
            <input ref={importInput} type="file" accept=".json,application/json" hidden
                   onChange={event => {
                       const file = event.target.files?.[0];
                       event.target.value = ''
                       if (file) void importFile(file)
                   }}/>
        </div>
        {notice && <p role="status">{notice}</p>}
        {error && <div role="alert"><p className="chat-error">{error}</p>{!loaded &&
            <button type="button" className="secondary-button"
                    onClick={() => setRetry(value => value + 1)}>重试</button>}</div>}
        {!loaded && !error && <p role="status">正在读取记忆…</p>}
        {listOpen && <MemoryListDialog items={state.items} busy={busy} error={error} nestedOpen={!!editing || !!deleting}
                                       onClose={() => setListOpen(false)} onEdit={item => setEditing({...item})}
                                       onRemove={item => setDeleting(item.id)}
                                       onPin={item => void update(() => window.memory?.save({...item, pinned: !item.pinned}))}/>}
        {deleting && <ConfirmDialog title="删除这条记忆" message="是否删除这条记忆？" confirmLabel="删除"
                                    danger busy={busy}
                                    onConfirm={() => void confirmRemove()}
                                    onCancel={() => setDeleting('')}/>}
        {editing && <MemoryDialog item={editing} onClose={() => setEditing(null)}
                                  onSaved={next => {
                                      setState(next);
                                      setNotice('')
                                  }}/>}
    </section>
}
