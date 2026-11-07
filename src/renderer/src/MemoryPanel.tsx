import {useEffect, useRef, useState} from 'react'
import type {ConsolidationPreview, Memory, MemoryState} from '../../shared/memory'
import type {Result} from '../../shared/accounts'
import {downloadJson} from './ChatTracePanel'
import {Icon} from './Icon'

const kinds = {fact: '事实', preference: '偏好', event: '事项'}
type Stage = 'idle' | 'scanning' | 'preview' | 'applying' | 'done'

export function MemoryPanel({active}: { active: boolean }) {
    const [state, setState] = useState<MemoryState>({username: '', enabled: false, items: []})
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')
    const [loaded, setLoaded] = useState(false)
    const [editing, setEditing] = useState<Memory | null>(null)
    const [deleting, setDeleting] = useState('')
    const [retry, setRetry] = useState(0)
    const [llmReady, setLlmReady] = useState(false)
    const [stage, setStage] = useState<Stage>('idle')
    const [preview, setPreview] = useState<ConsolidationPreview | null>(null)
    const [selectedGroups, setSelectedGroups] = useState<Set<string>>(new Set())
    const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set())
    const [consolidation, setConsolidation] = useState<{ id: string; groups: number; removed: number } | null>(null)
    const scanRevision = useRef(0)
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
    useEffect(() => {
        if (!active || !window.llm) return
        let current = true
        void window.llm.get().then(result => {
            if (!current || !result.ok) return
            setLlmReady(result.data.enabled && !!result.data.baseUrl && !!result.data.model)
        }).catch(() => {
        })
        return () => {
            current = false
        }
    }, [active])

    async function update(action: () => Promise<Result<MemoryState> | undefined> | undefined) {
        if (busy) return
        setBusy(true);
        setError('')
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

    const eligibleItems = state.items.filter(item => item.status === 'active' && (!item.expiresAt || Date.parse(item.expiresAt) > Date.now()))
    const readyStage = stage === 'idle' || stage === 'done'
    const canConsolidate = loaded && state.enabled && llmReady && eligibleItems.length >= 2 && readyStage && !busy
    const disabledReason = !state.enabled ? '' : !llmReady ? '请先启用并配置模型服务'
        : eligibleItems.length < 2 ? '至少需要 2 条有效记忆才能整理' : ''

    function toggleItem(id: string) {
        setSelectedItems(current => {
            const next = new Set(current)
            if (next.has(id)) next.delete(id); else next.add(id)
            return next
        })
    }

    async function scan(ids?: string[]) {
        if (!canConsolidate || !window.memory) return
        const revision = ++scanRevision.current
        setStage('scanning');
        setError('')
        try {
            const result = await window.memory.consolidatePreview(ids ? {ids} : undefined)
            if (revision !== scanRevision.current) return
            if (!result.ok) {
                setStage('idle');
                setError(result.error);
                return
            }
            const data = result.data
            if (!data.previewId || !data.groups.length) {
                setStage('idle');
                setError('没有找到可以合并的记忆。');
                return
            }
            setPreview(data)
            setSelectedGroups(new Set(data.groups.filter(group => group.status === 'ok').map(group => group.id)))
            setStage('preview')
        } catch (error) {
            if (revision !== scanRevision.current) return
            setStage('idle');
            setError(error instanceof Error ? error.message : '整理记忆失败。')
        }
    }

    async function cancelScan() {
        scanRevision.current++
        await window.memory?.consolidateCancel().catch(() => undefined)
        setStage('idle')
    }

    async function applySelected() {
        if (!preview || !window.memory) return
        const groupIds = [...selectedGroups]
        if (!groupIds.length) {
            setError('请至少选择一组。');
            return
        }
        setStage('applying');
        setError('')
        try {
            const result = await window.memory.consolidateApply({previewId: preview.previewId, groupIds})
            if (!result.ok) {
                setStage('preview');
                setError(result.error);
                return
            }
            setState(result.data.state)
            setConsolidation({
                id: result.data.consolidationId,
                groups: result.data.groups,
                removed: result.data.removed
            })
            setPreview(null);
            setSelectedGroups(new Set());
            setSelectedItems(new Set())
            setStage('done')
        } catch (error) {
            setStage('preview');
            setError(error instanceof Error ? error.message : '应用整理失败。')
        }
    }

    async function discardPreview() {
        if (!preview) return
        await window.memory?.consolidateDiscard(preview.previewId).catch(() => undefined)
        setPreview(null);
        setSelectedGroups(new Set());
        setStage('idle')
    }

    async function undoConsolidation() {
        if (!consolidation || !window.memory) return
        setBusy(true);
        setError('')
        try {
            const result = await window.memory.consolidateUndo(consolidation.id)
            if (result.ok) {
                setState(result.data.state);
                setConsolidation(null);
                setStage('idle')
            } else setError(result.error)
        } catch (error) {
            setError(error instanceof Error ? error.message : '撤销整理失败。')
        } finally {
            setBusy(false)
        }
    }

    return <section className="agent-settings" aria-label="记忆管理">
        <h3>记忆</h3>
        <label className="memory-enable"><input type="checkbox" checked={state.enabled} disabled={busy || !loaded}
                                                onChange={event => void update(() => window.memory?.setEnabled(event.target.checked))}/>启用长期记忆</label>
        <p>关闭后聊天不再读取或新增记忆，仍可在这里管理。关闭或删除记忆不会清除旧会话中已有的副本；需要时可同时清空聊天记录。</p>
        <div className="trace-toolbar memory-toolbar">
            <button type="button" className="primary-button" disabled={!canConsolidate}
                    title={disabledReason || '调用模型扫描并合并重复记忆'}
                    onClick={() => void scan()}><Icon name="sparkles"/>重新整理记忆
            </button>
            {selectedItems.size >= 2 && <button type="button" className="secondary-button" disabled={!canConsolidate}
                                                onClick={() => void scan([...selectedItems])}>合并所选（{selectedItems.size}）</button>}
            <button type="button" className="secondary-button" disabled={busy || !loaded} onClick={() => {
                setError('')
                void window.memory?.exportJson().then(result => {
                    if (result.ok) downloadJson(JSON.parse(result.data), 'fdunav-memories.json')
                    else setError(result.error)
                }).catch(() => setError('导出记忆失败。'))
            }}>导出 JSON
            </button>
            <label className="secondary-button memory-import">导入 JSON<input type="file"
                                                                              accept=".json,application/json"
                                                                              disabled={busy || !loaded}
                                                                              onChange={event => {
                                                                                  const file = event.target.files?.[0];
                                                                                  event.target.value = ''
                                                                                  if (!file) return
                                                                                  if (file.size > 1024 * 1024) {
                                                                                      setError('文件须小于 1 MiB。');
                                                                                      return
                                                                                  }
                                                                                  void update(async () => window.memory?.importJson(await file.text(), state.username))
                                                                              }}/></label>
        </div>
        {loaded && readyStage && state.enabled &&
            <p role="status">{disabledReason || '先展示整理预览，确认后才修改记忆。'}</p>}
        {stage === 'scanning' && <div className="memory-consolidate" role="status">
            <p>正在扫描 {state.items.length} 条记忆…</p>
            <div className="trace-toolbar">
                <button type="button" className="secondary-button" onClick={() => void cancelScan()}>取消</button>
            </div>
        </div>}
        {(stage === 'preview' || stage === 'applying') && preview && <div className="memory-consolidate">
            <h4>整理预览</h4>
            {preview.skipped > 0 && <p>记忆较多，已合并前 8 组，可再次整理。</p>}
            {preview.failed > 0 && <p>{preview.failed} 组未能生成合并结果，可取消后重试。</p>}
            <ul className="memory-groups">{preview.groups.map(group => <li key={group.id} data-status={group.status}>
                <label><input type="checkbox" disabled={group.status !== 'ok'} checked={selectedGroups.has(group.id)}
                              onChange={() => setSelectedGroups(current => {
                                  const next = new Set(current)
                                  if (next.has(group.id)) next.delete(group.id); else next.add(group.id)
                                  return next
                              })}/>旧 {group.before.length} 条 → 新 1 条</label>
                {group.status === 'ok' ? <>
                    <ul className="memory-group-old">{group.before.map(item => <li key={item.id}><s>{item.text}</s>
                    </li>)}</ul>
                    <p className="memory-diff-new">＋ {group.after.text}</p>
                </> : <p className="chat-error">{group.error ?? '合并失败。'}</p>}
            </li>)}</ul>
            <div className="trace-toolbar">
                <button type="button" className="primary-button" disabled={!selectedGroups.size || stage === 'applying'}
                        onClick={() => void applySelected()}>{stage === 'applying' ? '正在应用…' : `应用所选（${selectedGroups.size} 组）`}</button>
                <button type="button" className="secondary-button" disabled={stage === 'applying'}
                        onClick={() => void discardPreview()}>取消
                </button>
            </div>
        </div>}
        {stage === 'done' && consolidation && <div className="memory-consolidate">
            <p role="status">已合并 {consolidation.groups} 组，记忆减少 {consolidation.removed} 条。</p>
            <div className="trace-toolbar">
                <button type="button" className="secondary-button" disabled={busy}
                        onClick={() => void undoConsolidation()}>撤销本次整理
                </button>
            </div>
        </div>}
        {!loaded && !error && <p role="status">正在读取记忆…</p>}
        <ul className="memory-list">{state.items.map(item => <li key={item.id}>
            <div className="memory-select">
                <input type="checkbox" aria-label="选择这条记忆" checked={selectedItems.has(item.id)}
                       disabled={!readyStage || !eligibleItems.some(value => value.id === item.id)}
                       onChange={() => toggleItem(item.id)}/>
                <div>
                    <small>{kinds[item.kind]} · {item.pinned ? '已置顶' : '未置顶'} · {item.status === 'archived' ? '已归档' : item.expiresAt && Date.parse(item.expiresAt) <= Date.now() ? '已到期' : '有效'}</small>
                    <p>{item.text}</p><small>依据：{item.evidence}</small></div>
            </div>
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
        {error && <div role="alert"><p className="chat-error">{error}</p>{!loaded &&
            <button type="button" className="secondary-button"
                    onClick={() => setRetry(value => value + 1)}>重试</button>}</div>}
    </section>
}
