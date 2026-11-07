import {useEffect, useState} from 'react'
import type {Memory, MemoryState} from '../../shared/memory'
import type {Result} from '../../shared/accounts'
import {downloadJson} from './ChatTracePanel'

const kinds = {fact: '事实', preference: '偏好', event: '事项'}
export function MemoryPanel({active}: {active: boolean}) {
    const [state, setState] = useState<MemoryState>({username: '', enabled: false, items: []})
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')
    const [loaded, setLoaded] = useState(false)
    const [editing, setEditing] = useState<Memory | null>(null)
    const [deleting, setDeleting] = useState('')
    const [retry, setRetry] = useState(0)
    useEffect(() => {
        if (!active) return
        if (!window.memory) {setError('记忆服务未加载，请重启应用。'); return}
        let current = true
        setLoaded(false); setError('')
        void window.memory?.get().then(result => {
            if (!current) return
            if (result.ok) {setState(result.data); setLoaded(true)} else setError(result.error)
        }).catch(() => {if (current) setError('无法读取记忆。')})
        return () => {current = false}
    }, [active, retry])
    async function update(action: () => Promise<Result<MemoryState> | undefined> | undefined) {
        if (busy) return
        setBusy(true); setError('')
        try {
            const result = await action()
            if (!result) throw new Error('记忆服务不可用。')
            if (result.ok) {setState(result.data); setEditing(null); setDeleting('')} else setError(result.error)
        } catch (error) {setError(error instanceof Error ? error.message : '记忆更新失败。')}
        finally {setBusy(false)}
    }
    return <section className="agent-settings" aria-label="记忆管理">
        <h3>记忆</h3>
        <p>默认关闭。启用后，选中的事实和偏好会随聊天发送给你配置的模型服务，单次最多 1200 字符。记忆保存在本机，按登录账号隔离。</p>
        <label className="memory-enable"><input type="checkbox" checked={state.enabled} disabled={busy || !loaded}
            onChange={event => void update(() => window.memory?.setEnabled(event.target.checked))}/>启用长期记忆</label>
        <p>关闭后聊天不再读取或新增记忆，仍可在这里管理。关闭或删除记忆不会清除旧会话中已有的副本；需要时可同时清空聊天记录。</p>
        <div className="trace-toolbar">
            <button type="button" className="secondary-button" disabled={busy || !loaded} onClick={() => {
                setError('')
                void window.memory?.exportJson().then(result => {
                    if (result.ok) downloadJson(JSON.parse(result.data), 'fdunav-memories.json')
                    else setError(result.error)
                }).catch(() => setError('导出记忆失败。'))
            }}>导出 JSON</button>
            <label className="secondary-button memory-import">导入 JSON<input type="file" accept=".json,application/json" disabled={busy || !loaded}
                onChange={event => {
                    const file = event.target.files?.[0]; event.target.value = ''
                    if (!file) return
                    if (file.size > 1024 * 1024) {setError('文件须小于 1 MiB。'); return}
                    void update(async () => window.memory?.importJson(await file.text(), state.username))
                }}/></label>
        </div>
        {!loaded && !error && <p role="status">正在读取记忆…</p>}
        {loaded && !state.items.length && <p>还没有记忆。你可以在聊天中请求记住一条偏好，并在卡片中允许保存。</p>}
        <ul className="memory-list">{state.items.map(item => <li key={item.id}>
            <div><small>{kinds[item.kind]} · {item.pinned ? '已置顶' : '未置顶'} · {item.status === 'archived' ? '已归档' : item.expiresAt && Date.parse(item.expiresAt) <= Date.now() ? '已到期' : '有效'}</small>
                <p>{item.text}</p><small>依据：{item.evidence}</small></div>
            <div className="trace-toolbar">
                <button type="button" className="secondary-button" disabled={busy} onClick={() => setEditing({...item})}>编辑</button>
                <button type="button" className="secondary-button" disabled={busy} onClick={() => void update(() => window.memory?.save({...item, pinned: !item.pinned}))}>{item.pinned ? '取消置顶' : '置顶'}</button>
                {deleting === item.id ? <><span>删除这条记忆？</span>
                    <button type="button" className="secondary-button" disabled={busy} onClick={() => void update(() => window.memory?.remove(item.id))}>确认删除</button>
                    <button type="button" className="secondary-button" onClick={() => setDeleting('')}>取消</button></> :
                    <button type="button" className="secondary-button" disabled={busy} onClick={() => setDeleting(item.id)}>删除</button>}
            </div>
        </li>)}</ul>
        {editing && <div className="memory-editor">
            <label>内容<textarea value={editing.text} maxLength={600} onChange={event => setEditing({...editing, text: event.target.value})}/></label>
            <label>依据<textarea value={editing.evidence} maxLength={1000} onChange={event => setEditing({...editing, evidence: event.target.value})}/></label>
            <label>类型<select value={editing.kind} onChange={event => setEditing({...editing, kind: event.target.value as Memory['kind']})}>
                <option value="fact">事实</option><option value="preference">偏好</option><option value="event">事项</option></select></label>
            <label>可信度<input type="number" min={0} max={1} step={0.1} value={editing.confidence} onChange={event => setEditing({...editing, confidence: Number(event.target.value)})}/></label>
            <label>到期时间（ISO 格式，留空永久）<input type="text" value={editing.expiresAt ?? ''} placeholder="2026-12-31T23:59:00+08:00"
                onChange={event => setEditing({...editing, expiresAt: event.target.value || null})}/></label>
            <label>状态<select value={editing.status} onChange={event => setEditing({...editing, status: event.target.value as Memory['status']})}>
                <option value="active">有效</option><option value="archived">归档</option></select></label>
            <div className="trace-toolbar"><button type="button" className="primary-button" disabled={busy} onClick={() => void update(() => window.memory?.save(editing))}>保存记忆</button>
                <button type="button" className="secondary-button" disabled={busy} onClick={() => setEditing(null)}>取消</button></div>
        </div>}
        {error && <div role="alert"><p className="chat-error">{error}</p>{!loaded && <button type="button" className="secondary-button" onClick={() => setRetry(value => value + 1)}>重试</button>}</div>}
    </section>
}
