import {useEffect, useRef, useState} from 'react'
import type {Memory, MemoryState} from '../../shared/memory'
import type {Result} from '../../shared/accounts'
import {downloadJson} from './ChatTracePanel'
import {Icon} from './Icon'

export function MemoryPanel({active}: { active: boolean }) {
    const [state, setState] = useState<MemoryState>({username: '', enabled: false, items: []})
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')
    const [loaded, setLoaded] = useState(false)
    const [editing, setEditing] = useState<Memory | null>(null)
    const [deleting, setDeleting] = useState('')
    const [retry, setRetry] = useState(0)
    const [notice, setNotice] = useState('')
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
        <ul className="memory-list">{state.items.map(item => <li key={item.id}>
            <div>
                <p>{item.pinned && <span className="memory-pin" role="img" aria-label="已置顶"><Icon
                    name="pin"/></span>}{item.text}</p><small>依据：{item.evidence}</small></div>
            <div className="trace-toolbar">
                <button type="button" className="secondary-button" disabled={busy}
                        onClick={() => setEditing({...item})}>编辑
                </button>
                <button type="button" className="secondary-button" disabled={busy}
                        onClick={() => void update(() => window.memory?.save({
                            ...item,
                            pinned: !item.pinned
                        }))}>{item.pinned ? '取消置顶' : '置顶'}</button>
                {deleting === item.id ? <><span>删除这条记忆？</span>
                        <button type="button" className="secondary-button" disabled={busy}
                                onClick={() => void update(() => window.memory?.remove(item.id))}>确认删除
                        </button>
                        <button type="button" className="secondary-button" onClick={() => setDeleting('')}>取消</button>
                    </> :
                    <button type="button" className="secondary-button" disabled={busy}
                            onClick={() => setDeleting(item.id)}>删除</button>}
            </div>
        </li>)}</ul>
        {editing && <div className="memory-editor">
            <label>内容<textarea value={editing.text} maxLength={600}
                                 onChange={event => setEditing({...editing, text: event.target.value})}/></label>
            <label>依据<textarea value={editing.evidence} maxLength={1000}
                                 onChange={event => setEditing({...editing, evidence: event.target.value})}/></label>
            <label>类型<select value={editing.kind}
                               onChange={event => setEditing({...editing, kind: event.target.value as Memory['kind']})}>
                <option value="fact">事实</option>
                <option value="preference">偏好</option>
                <option value="event">事项</option>
            </select></label>
            <label>可信度<input type="number" min={0} max={1} step={0.1} value={editing.confidence}
                                onChange={event => setEditing({
                                    ...editing,
                                    confidence: Number(event.target.value)
                                })}/></label>
            <label>到期时间（ISO 格式，留空永久）<input type="text" value={editing.expiresAt ?? ''}
                                                     placeholder="2026-12-31T23:59:00+08:00"
                                                     onChange={event => setEditing({
                                                         ...editing,
                                                         expiresAt: event.target.value || null
                                                     })}/></label>
            <label>状态<select value={editing.status} onChange={event => setEditing({
                ...editing,
                status: event.target.value as Memory['status']
            })}>
                <option value="active">有效</option>
                <option value="archived">归档</option>
            </select></label>
            <div className="trace-toolbar">
                <button type="button" className="primary-button" disabled={busy}
                        onClick={() => void update(() => window.memory?.save(editing))}>保存记忆
                </button>
                <button type="button" className="secondary-button" disabled={busy}
                        onClick={() => setEditing(null)}>取消
                </button>
            </div>
        </div>}
    </section>
}
