import {type FormEvent, useEffect, useRef, useState} from 'react'
import {
    type CampusHolePost,
    type CampusPage,
    type CampusPost,
    type DantaStatus,
    communityFeeds,
} from '../../shared/danta'
import {Icon} from './Icon'
import {PostContent} from './dx-emoji'
import './styles/danta.css'

const pageSize = 10
const formatTime = (value: string | null) => {
    if (!value) return ''
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', {dateStyle: 'short', timeStyle: 'short'})
}

/**
 * 树洞页：搜索命中楼层，左侧结果、右侧帖子上下文；摘要只把当前帖子楼层交给模型，不落库原文。
 */
export function DantaPage({onSettings}: { onSettings: () => void }) {
    const [status, setStatus] = useState<DantaStatus | null>(null)
    const [query, setQuery] = useState('')
    const [results, setResults] = useState<CampusPost[]>([])
    const [nextOffset, setNextOffset] = useState<number | null>(null)
    const [searched, setSearched] = useState(false)
    const [busy, setBusy] = useState('')
    const [error, setError] = useState('')
    const [thread, setThread] = useState<CampusPage | null>(null)
    const [summary, setSummary] = useState('')
    const [summaryError, setSummaryError] = useState('')
    const [mode, setMode] = useState<'feed' | 'search'>('feed')
    const [feedId, setFeedId] = useState(communityFeeds[0].id)
    const [feedResults, setFeedResults] = useState<CampusHolePost[]>([])
    const [feedCursor, setFeedCursor] = useState<string | null>(null)
    const [feedLoaded, setFeedLoaded] = useState(false)
    const [feedBusy, setFeedBusy] = useState('')
    const feedRequest = useRef(0)
    const api = window.danta
    const requestId = useRef(0)

    useEffect(() => {
        let active = true
        void api?.status().then(result => {
            if (!active) return
            if (result.ok) setStatus(result.data)
            else setError(result.error)
        }).catch(() => {
            if (active) setError('无法读取社区状态。')
        })
        return () => {
            active = false
        }
    }, [api])

    const connected = status?.account === 'connected'

    async function loadFeed(target: string, cursor: string | null) {
        if (!api || feedBusy) return
        const current = ++feedRequest.current
        setFeedBusy('正在加载分区…')
        try {
            const result = await api.feed({feedId: target, cursor, limit: pageSize})
            if (current !== feedRequest.current) return
            if (!result.ok) setError(result.error)
            else {
                setFeedResults(previous => {
                    if (!cursor) return result.data.results
                    const seen = new Set(previous.map(item => item.holeId))
                    return [...previous, ...result.data.results.filter(item => !seen.has(item.holeId))]
                })
                setFeedCursor(result.data.cursor)
                setFeedLoaded(true)
            }
        } catch {
            if (current === feedRequest.current) setError('分区加载失败，请稍后重试。')
        } finally {
            if (current === feedRequest.current) setFeedBusy('')
        }
    }

    useEffect(() => {
        if (!connected || mode !== 'feed') return
        // 切换分区时清空旧结果，避免把上一个分区的帖子留在列表里。
        setFeedResults([])
        setFeedCursor(null)
        setFeedLoaded(false)
        void loadFeed(feedId, null)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [connected, mode, feedId])

    async function search(event: FormEvent) {
        event.preventDefault()
        if (!api || busy) return
        const text = query.trim()
        if (!text) {
            setError('请输入搜索关键词。')
            return
        }
        const current = ++requestId.current
        setBusy('正在搜索树洞…')
        setError('')
        setThread(null)
        setSummary('')
        setSummaryError('')
        try {
            const result = await api.searchPosts({query: text, offset: 0, limit: pageSize})
            if (current !== requestId.current) return
            if (!result.ok) setError(result.error)
            else {
                setResults(result.data.results)
                setNextOffset(result.data.nextOffset)
                setSearched(true)
            }
        } catch {
            if (current === requestId.current) setError('搜索失败，请稍后重试。')
        } finally {
            if (current === requestId.current) setBusy('')
        }
    }

    async function moreResults() {
        if (!api || busy || nextOffset === null) return
        setBusy('正在加载更多结果…')
        setError('')
        try {
            const result = await api.searchPosts({query: query.trim(), offset: nextOffset, limit: pageSize})
            if (!result.ok) setError(result.error)
            else {
                const seen = new Set(results.map(item => `${item.holeId}:${item.floorId}`))
                setResults([...results, ...result.data.results.filter(item => !seen.has(`${item.holeId}:${item.floorId}`))])
                setNextOffset(result.data.nextOffset)
            }
        } catch {
            setError('加载失败，请稍后重试。')
        } finally {
            setBusy('')
        }
    }

    async function openThread(holeId: number) {
        if (!api || busy) return
        setBusy('正在读取帖子…')
        setError('')
        setSummary('')
        setSummaryError('')
        try {
            const result = await api.readThread({holeId, offset: 0, limit: pageSize})
            if (!result.ok) setError(result.error)
            else setThread(result.data)
        } catch {
            setError('读取帖子失败，请稍后重试。')
        } finally {
            setBusy('')
        }
    }

    async function moreFloors() {
        if (!api || busy || !thread || thread.nextOffset === null) return
        setBusy('正在加载更多楼层…')
        try {
            const result = await api.readThread({holeId: thread.thread!.id, offset: thread.nextOffset, limit: pageSize})
            if (!result.ok) setError(result.error)
            else {
                const seen = new Set(thread.results.map(item => item.floorId))
                setThread({...result.data, results: [...thread.results, ...result.data.results.filter(item => !seen.has(item.floorId))]})
            }
        } catch {
            setError('加载楼层失败，请稍后重试。')
        } finally {
            setBusy('')
        }
    }

    async function summarize() {
        if (!api || busy || !thread) return
        setBusy('正在生成摘要…')
        setSummaryError('')
        try {
            const result = await api.summarizeThread(thread.thread!.id)
            if (!result.ok) setSummaryError(result.error)
            else setSummary(result.data.summary)
        } catch {
            setSummaryError('摘要生成失败，请检查 LLM 设置后重试。')
        } finally {
            setBusy('')
        }
    }

    if (!api) return <div className="danta-page"><p className="danta-empty">请在桌面应用中使用树洞。</p></div>
    if (status && !connected) return <div className="danta-page">
        <header className="danta-head"><div>
            <h1>树洞</h1>
            <p className="danta-subtitle">搜索旦挞社区帖子，读取帖子上下文；只读，不会发帖或回复。</p>
        </div></header>
        <div className="danta-empty">
            <p>还没有连接旦挞社区账号。</p>
            <p className="danta-empty-note">先在设置里连接学校网络并登录社区账号，才能搜索树洞。</p>
            <button type="button" className="primary-button" onClick={onSettings}>去设置连接</button>
        </div>
    </div>

    return <div className="danta-page">
        <header className="danta-head">
            <div>
                <h1>树洞</h1>
                <p className="danta-subtitle">搜索旦挞社区帖子，读取帖子上下文；只读，不会发帖或回复。</p>
            </div>
            <button type="button" className="secondary-button" onClick={onSettings}>账号设置</button>
        </header>
        {error && <p className="danta-error" role="alert">{error}</p>}
        <div className="danta-body">
            <section className="danta-list" aria-busy={!!busy || !!feedBusy}>
                <div className="danta-tabs" role="tablist" aria-label="树洞分区">
                    {communityFeeds.map(feed => <button key={feed.id} type="button" role="tab"
                                                       aria-selected={mode === 'feed' && feedId === feed.id}
                                                       className={`danta-tab${mode === 'feed' && feedId === feed.id ? ' is-active' : ''}`}
                                                       onClick={() => {
                                                           setMode('feed')
                                                           setFeedId(feed.id)
                                                           setThread(null)
                                                       }}>{feed.label}</button>)}
                    <button type="button" role="tab" aria-selected={mode === 'search'}
                            className={`danta-tab${mode === 'search' ? ' is-active' : ''}`}
                            onClick={() => setMode('search')}>搜索</button>
                </div>
                {mode === 'search' && <>
                    <form className="danta-search" onSubmit={search}>
                        <input type="search" value={query} onChange={event => setQuery(event.target.value)}
                               placeholder="搜索帖子关键词，例如 图书馆" maxLength={200} aria-label="搜索树洞"/>
                        <button type="submit" className="primary-button"
                                disabled={!!busy || !query.trim()}>搜索
                        </button>
                    </form>
                    {!searched && <p className="danta-empty-note">输入关键词后回车搜索。命中的是楼层，点开可看完整帖子。</p>}
                    {searched && results.length === 0 && !busy &&
                        <p className="danta-empty-note">没有命中结果。可以换更具体的词。</p>}
                    <ul className="danta-results">
                        {results.map(item => <li key={`${item.holeId}:${item.floorId}`}>
                            <button type="button" className="danta-result" onClick={() => void openThread(item.holeId)}>
                                <span className="danta-result-meta">帖子 #{item.holeId} · 楼层 #{item.floorId} · {formatTime(item.timeCreated)}
                                    {item.redacted && <span className="danta-badge">已脱敏</span>}</span>
                                <span className="danta-result-content"><PostContent text={item.content}/></span>
                            </button>
                        </li>)}
                    </ul>
                    {nextOffset !== null && <button type="button" className="secondary-button danta-more"
                                                   disabled={!!busy} onClick={() => void moreResults()}>加载更多结果</button>}
                </>}
                {mode === 'feed' && <>
                    <p className="danta-empty-note">
                        {communityFeeds.find(feed => feed.id === feedId)?.hint ?? ''}
                        {feedLoaded ? ' · 只读列表，点开可看完整帖子。' : ''}
                    </p>
                    {feedLoaded && feedResults.length === 0 && !feedBusy &&
                        <p className="danta-empty-note">这个分区暂时没有内容。</p>}
                    <ul className="danta-results">
                        {feedResults.map(item => <li key={item.holeId}>
                            <button type="button" className="danta-result" onClick={() => void openThread(item.holeId)}>
                                <span className="danta-result-meta">帖子 #{item.holeId}
                                    {item.reply !== null && ` · ${item.reply} 条回复`}
                                    {item.view !== null && ` · ${item.view} 次浏览`}
                                    {` · ${formatTime(item.timeCreated)}`}
                                    {item.redacted && <span className="danta-badge">已脱敏</span>}</span>
                                <span className="danta-result-content"><PostContent text={item.content}/></span>
                                {item.tags.length > 0 && <span className="danta-tags">
                                    {item.tags.slice(0, 3).map(tag => <span key={tag} className="danta-tag">{tag}</span>)}
                                </span>}
                            </button>
                        </li>)}
                    </ul>
                    {feedBusy && <p className="danta-empty-note" role="status">{feedBusy}</p>}
                    {!feedBusy && feedCursor !== null && <button type="button" className="secondary-button danta-more"
                                                                onClick={() => void loadFeed(feedId, feedCursor)}>加载更多</button>}
                </>}
            </section>
            <aside className="danta-thread">
                {!thread && <p className="danta-empty-note">从左侧选择一条结果，查看帖子上下文。</p>}
                {thread && thread.thread && <>
                    <div className="danta-thread-head">
                        <div>
                            <h2>帖子 #{thread.thread.id}</h2>
                            <p className="danta-result-meta">
                                发布于 {formatTime(thread.thread.timeCreated)}
                                {thread.thread.reply !== null && ` · ${thread.thread.reply} 条回复`}
                            </p>
                        </div>
                        <button type="button" className="secondary-button" disabled={!!busy}
                                onClick={() => setThread(null)}>关闭
                        </button>
                    </div>
                    <p className="danta-notice">{thread.notice}</p>
                    <ol className="danta-floors">
                        {thread.results.map(floor => <li key={floor.floorId}>
                            <div className="danta-floor-meta">楼层 #{floor.floorId} · {formatTime(floor.timeCreated)}
                                {floor.redacted && <span className="danta-badge">已脱敏</span>}</div>
                            <p className="danta-floor-content"><PostContent text={floor.content}/></p>
                        </li>)}
                    </ol>
                    {thread.nextOffset !== null && <button type="button" className="secondary-button"
                                                          disabled={!!busy} onClick={() => void moreFloors()}>加载更多楼层</button>}
                    <div className="danta-summary">
                        <div className="danta-summary-head">
                            <h3>AI 摘要</h3>
                            <button type="button" className="secondary-button" disabled={!!busy}
                                    onClick={() => void summarize()}>
                                <Icon name="sparkles"/>{summary ? '重新生成' : '生成摘要'}
                            </button>
                        </div>
                        {summaryError && <p className="danta-error" role="alert">{summaryError}</p>}
                        {summary ? <p className="danta-summary-text">{summary}</p>
                            : <p className="danta-empty-note">摘要只使用当前已加载的楼层，可能不完整。</p>}
                    </div>
                </>}
            </aside>
        </div>
        {busy && <p className="danta-feedback" role="status">{busy}</p>}
    </div>
}
