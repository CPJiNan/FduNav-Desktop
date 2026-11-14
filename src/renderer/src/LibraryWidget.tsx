import {useCallback, useEffect, useRef, useState} from 'react'
import type {LibraryCrowding} from '../../shared/library'
import {Icon} from './Icon'

export function LibraryWidget({refreshVersion}: { refreshVersion: number }) {
    const [data, setData] = useState<LibraryCrowding | null>(null)
    const [busy, setBusy] = useState(true)
    const [error, setError] = useState('')
    const mounted = useRef(false)
    const pending = useRef(false)
    const previousVersion = useRef(refreshVersion)
    const api = window.library

    const load = useCallback(async (refresh = false) => {
        if (pending.current) return
        if (!api) {
            setBusy(false)
            setError('请在桌面应用中查询图书馆人数。')
            return
        }
        pending.current = true
        setBusy(true)
        setError('')
        try {
            const result = await api.crowding(refresh)
            if (!mounted.current) return
            if (result.ok) setData(result.data)
            else setError(result.error)
        } catch {
            if (mounted.current) setError('无法连接图书馆服务，请刷新重试。')
        } finally {
            pending.current = false
            if (mounted.current) setBusy(false)
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

    return <div aria-busy={busy}>
        <div className="dashboard-widget-heading">
            <h2><Icon name="book"/>图书馆人数</h2>
            <button type="button" disabled={busy || !api} onClick={() => void load(true)} aria-label="刷新图书馆人数">
                <Icon name="refresh"/>{busy ? '查询中…' : '刷新'}
            </button>
        </div>
        {busy && <p className="dashboard-widget-caption" role="status">正在查询在馆人数…</p>}
        {data && <>
            <dl className="dashboard-library-counts">{data.items.map(item => <div key={item.id}>
                <dt>{item.name}</dt>
                <dd aria-label={item.count === null ? '人数暂不可用' : `${item.count} 人在馆`}>
                    <strong>{item.count === null ? '—' : item.count.toLocaleString('zh-CN')}</strong>
                    {item.count !== null && <span>人</span>}
                </dd>
            </div>)}</dl>
            {!data.items.length && <p className="dashboard-empty">暂无图书馆人数数据</p>}
        </>}
        {error && <p className="dashboard-error" role="alert">{error}</p>}
    </div>
}
