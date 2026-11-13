import {type FormEvent, useEffect, useState} from 'react'
import type {ResearchSettings, ResearchSettingsInput} from '../../shared/research'
import './styles/research.css'

type SearchDraft = Pick<ResearchSettings,
    'searchDepth' | 'searchMaxResults' | 'searchMaxSnippetChars' | 'searchTimeoutSeconds' |
    'researchMaxToolCalls' | 'requestBudgetSeconds' | 'httpTimeoutSeconds'>

const toSearchDraft = (settings: ResearchSettings): SearchDraft => ({
    searchDepth: settings.searchDepth,
    searchMaxResults: settings.searchMaxResults,
    searchMaxSnippetChars: settings.searchMaxSnippetChars,
    searchTimeoutSeconds: settings.searchTimeoutSeconds,
    researchMaxToolCalls: settings.researchMaxToolCalls,
    requestBudgetSeconds: settings.requestBudgetSeconds,
    httpTimeoutSeconds: settings.httpTimeoutSeconds,
})

export function WebSearchPanel({active}: { active: boolean }) {
    const api = window.research
    const [settings, setSettings] = useState<ResearchSettings | null>(null)
    const [draft, setDraft] = useState<SearchDraft>({
        searchDepth: 'advanced', searchMaxResults: 5, searchMaxSnippetChars: 2000, searchTimeoutSeconds: 15,
        researchMaxToolCalls: 12, requestBudgetSeconds: 300, httpTimeoutSeconds: 15,
    })
    const [searchApiKey, setSearchApiKey] = useState('')
    const [clearSearchApiKey, setClearSearchApiKey] = useState(false)
    const [reviewEnabled, setReviewEnabled] = useState(false)
    const [loaded, setLoaded] = useState(false)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')

    useEffect(() => {
        if (!active || !api || loaded) return
        let cancelled = false
        setBusy(true)
        setError('')
        void api.get().then(result => {
            if (cancelled) return
            if (result.ok) {
                setSettings(result.data)
                setDraft(toSearchDraft(result.data))
                setReviewEnabled(result.data.reviewEnabled)
                setLoaded(true)
            } else setError(result.error)
        }).catch(() => {
            if (!cancelled) setError('无法读取网页搜索设置。')
        }).finally(() => {
            if (!cancelled) setBusy(false)
        })
        return () => {
            cancelled = true
        }
    }, [active, api, loaded])

    function edited() {
        setError('')
    }

    async function save(event: FormEvent) {
        event.preventDefault()
        if (!api || !settings || busy) return
        setBusy(true)
        setError('')
        try {
            const current = await api.get()
            if (!current.ok) {
                setError(current.error)
                return
            }
            const input: ResearchSettingsInput = {
                searchDepth: draft.searchDepth,
                searchMaxResults: draft.searchMaxResults,
                searchMaxSnippetChars: draft.searchMaxSnippetChars,
                searchTimeoutSeconds: draft.searchTimeoutSeconds,
                httpTimeoutSeconds: draft.httpTimeoutSeconds,
                campusMaxContentChars: current.data.campusMaxContentChars,
                researchMaxToolCalls: draft.researchMaxToolCalls,
                maxCampusPages: current.data.maxCampusPages,
                requestBudgetSeconds: draft.requestBudgetSeconds,
                reviewEnabled,
                searchApiKey,
                clearSearchApiKey,
            }
            const result = await api.save(input)
            if (result.ok) {
                setSettings(result.data)
                setDraft(toSearchDraft(result.data))
                setReviewEnabled(result.data.reviewEnabled)
                setSearchApiKey('')
                setClearSearchApiKey(false)
            } else setError(result.error)
        } catch {
            setError('无法保存网页搜索设置。')
        } finally {
            setBusy(false)
        }
    }

    return <form className="llm-panel llm-search-panel" onSubmit={save} aria-busy={busy}>
        <h3 className="llm-section-heading">网页搜索</h3>
        <div className="llm-field">
            <label htmlFor="llm-search-api-key">Tavily API Key</label>
            <div className="llm-key-control">
                <input id="llm-search-api-key" type="password" value={searchApiKey} maxLength={4096}
                       autoComplete="new-password" autoCapitalize="none" spellCheck={false}
                       disabled={clearSearchApiKey}
                       placeholder={settings?.hasSearchApiKey ? '已配置密钥' : '可选'}
                       onChange={event => {
                           setSearchApiKey(event.target.value)
                           edited()
                       }}/>
                {settings?.hasSearchApiKey && <label className="llm-clear-key">
                    <input type="checkbox" checked={clearSearchApiKey} onChange={event => {
                        setClearSearchApiKey(event.target.checked)
                        setSearchApiKey('')
                        edited()
                    }}/>清除已保存的密钥
                </label>}
            </div>
        </div>
        <div className="llm-field">
            <label htmlFor="llm-search-depth">搜索深度</label>
            <select id="llm-search-depth" value={draft.searchDepth}
                    onChange={event => {
                        setDraft({...draft, searchDepth: event.target.value as SearchDraft['searchDepth']})
                        edited()
                    }}>
                <option value="basic">基础</option>
                <option value="advanced">深入</option>
            </select>
        </div>
        <div className="llm-field">
            <label htmlFor="llm-search-results">每次搜索结果数</label>
            <input id="llm-search-results" type="number" min={1} max={10} required value={draft.searchMaxResults}
                   onChange={event => {
                       setDraft({...draft, searchMaxResults: Number(event.target.value)})
                       edited()
                   }}/>
        </div>
        <div className="llm-field">
            <label htmlFor="llm-search-snippet">网页摘要字数上限</label>
            <input id="llm-search-snippet" type="number" min={100} max={10000} required
                   value={draft.searchMaxSnippetChars}
                   onChange={event => {
                       setDraft({...draft, searchMaxSnippetChars: Number(event.target.value)})
                       edited()
                   }}/>
        </div>
        <div className="llm-field">
            <label htmlFor="llm-search-timeout">搜索超时（秒）</label>
            <input id="llm-search-timeout" type="number" min={5} max={120} step={1} required
                   value={draft.searchTimeoutSeconds}
                   onChange={event => {
                       setDraft({...draft, searchTimeoutSeconds: Number(event.target.value)})
                       edited()
                   }}/>
        </div>
        <div className="llm-field llm-enable-field">
            <label id="llm-review-label" htmlFor="llm-review">答案核对</label>
            <button id="llm-review" type="button" role="switch" className="llm-switch"
                    aria-labelledby="llm-review-label" aria-checked={reviewEnabled}
                    onClick={() => {
                        setReviewEnabled(value => !value)
                        edited()
                    }}>
                <span className="llm-switch-track" aria-hidden="true"><span/></span>
            </button>
        </div>
        <div className="llm-field">
            <label htmlFor="llm-research-calls">每轮检索调用上限</label>
            <input id="llm-research-calls" type="number" min={1} max={30} required
                   value={draft.researchMaxToolCalls}
                   onChange={event => {
                       setDraft({...draft, researchMaxToolCalls: Number(event.target.value)})
                       edited()
                   }}/>
        </div>
        <div className="llm-field">
            <label htmlFor="llm-request-budget">单轮总时限（秒）</label>
            <input id="llm-request-budget" type="number" min={30} max={600} step={1} required
                   value={draft.requestBudgetSeconds}
                   onChange={event => {
                       setDraft({...draft, requestBudgetSeconds: Number(event.target.value)})
                       edited()
                   }}/>
        </div>
        <div className="llm-field">
            <label htmlFor="llm-http-timeout">通用请求超时（秒）</label>
            <input id="llm-http-timeout" type="number" min={5} max={120} step={1} required
                   value={draft.httpTimeoutSeconds}
                   onChange={event => {
                       setDraft({...draft, httpTimeoutSeconds: Number(event.target.value)})
                       edited()
                   }}/>
        </div>
        <div className="llm-actions">
            <button type="submit" className="primary-button" disabled={!loaded || !api || busy}>
                {busy && loaded ? '保存中…' : '保存'}
            </button>
        </div>
        {!api && <p className="account-error" role="alert">网页搜索设置服务不可用。</p>}
        {error && <p className="account-error" role="alert">{error}</p>}
    </form>
}
