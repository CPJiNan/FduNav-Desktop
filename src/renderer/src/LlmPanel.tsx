import {type FormEvent, type ReactNode, useEffect, useRef, useState} from 'react'
import {emptyLlmSettings, type LlmSettings, summaryPromptMaxLength, validateLlmSettings} from '../../shared/llm'
import {type ChatToolName, defaultToolDescriptions} from '../../shared/llm-prompts'
import {Icon} from './Icon'
import {MemoryPanel} from './MemoryPanel'
import {UsagePanel} from './UsagePanel'
import './styles/llm.css'

const promptFields = [
    {key: 'chatPrompt', label: '聊天提示词'},
    {key: 'summaryPrompt', label: '通知摘要提示词'},
    {key: 'connectionTestPrompt', label: '测试连接提示词'},
] as const


function ResetPromptButton({label, onReset}: { label: string; onReset: () => void }) {
    return <button type="button" className="icon-button llm-prompt-reset" title="恢复默认"
                   aria-label={`恢复默认${label}`} onClick={onReset}><Icon name="reset"/></button>
}

function PromptSection({id, label, onReset, children}: {
    id: string; label: string; onReset?: () => void; children: ReactNode
}) {
    const [expanded, setExpanded] = useState(false)
    return <section className={`llm-prompt-section${expanded ? ' is-expanded' : ''}`}>
        <div className="llm-prompt-heading">
            <h4>
                <button type="button" id={`${id}-label`} className="llm-prompt-toggle"
                        aria-expanded={expanded} aria-controls={`${id}-body`}
                        onClick={() => setExpanded(value => !value)}>
                    <Icon name="chevron"/><span>{label}</span>
                </button>
            </h4>
            {onReset && <ResetPromptButton label={label} onReset={onReset}/>}
        </div>
        <div id={`${id}-body`} className="llm-prompt-body" hidden={!expanded}>{children}</div>
    </section>
}

export function LlmPanel({active}: { active: boolean }) {
    const [settings, setSettings] = useState<LlmSettings>(emptyLlmSettings)
    const [apiKey, setApiKey] = useState('')
    const [clearApiKey, setClearApiKey] = useState(false)
    const [loaded, setLoaded] = useState(false)
    const [busy, setBusy] = useState(false)
    const [toggling, setToggling] = useState(false)
    const [error, setError] = useState('')
    const [testing, setTesting] = useState(false)
    const [testResult, setTestResult] = useState('')
    const [models, setModels] = useState<string[] | null>(null)
    const [fetchingModels, setFetchingModels] = useState(false)
    const [modelStatus, setModelStatus] = useState('')
    const initialModelsRequested = useRef(false)
    const requestVersion = useRef(0)
    const [retry, setRetry] = useState(0)
    const api = window.llm

    useEffect(() => {
        if (!active || loaded || !api) return
        let cancelled = false
        setBusy(true)
        setError('')
        void api.get().then(result => {
            if (cancelled) return
            setBusy(false)
            if (result.ok) {
                setSettings(result.data);
                setLoaded(true)
            } else setError(result.error)
        }).catch(() => {
            if (!cancelled) {
                setBusy(false);
                setError('无法读取 LLM 设置。')
            }
        })
        return () => {
            cancelled = true
        }
    }, [active, loaded, api, retry])

    useEffect(() => {
        if (!active || !loaded || !settings.enabled || busy || toggling || initialModelsRequested.current) return
        initialModelsRequested.current = true
        if (settings.baseUrl) void loadModels()
    }, [active, loaded, settings.enabled, busy, toggling])

    function edited() {
        setError('');
        setTestResult('');
        setModelStatus('')
    }

    async function toggleEnabled() {
        if (!api || !loaded || toggling) return
        setToggling(true)
        setError('')
        try {
            const response = await api.setEnabled(!settings.enabled)
            if (!response.ok) {
                setError(response.error);
                return
            }
            setSettings(value => ({...value, enabled: response.data.enabled}))
            edited()
            if (!response.data.enabled) {
                requestVersion.current++
                initialModelsRequested.current = false
                setBusy(false)
                setTesting(false)
                setFetchingModels(false)
            }
        } catch {
            setError('无法更新 LLM 启用状态，请重试。')
        } finally {
            setToggling(false)
        }
    }

    async function loadModels() {
        if (!api || busy || toggling || !loaded || !settings.enabled) return
        edited()
        const result = validateLlmSettings({...settings, apiKey, clearApiKey}, false)
        if (!result.ok) {
            setError(result.error);
            return
        }
        setBusy(true)
        setFetchingModels(true)
        const version = ++requestVersion.current
        try {
            const response = await api.models(result.data)
            if (version !== requestVersion.current) return
            if (response.ok) {
                setModels(response.data)
                setSettings(value => ({...value, model: response.data.includes(value.model) ? value.model : ''}))
                setModelStatus(`已获取 ${response.data.length} 个模型`)
            } else setError(response.error)
        } catch {
            if (version === requestVersion.current) setError('获取模型失败，请重试。')
        } finally {
            result.data.apiKey = ''
            if (version === requestVersion.current) {
                setBusy(false);
                setFetchingModels(false)
            }
        }
    }

    async function save(event: FormEvent) {
        event.preventDefault()
        if (!api || busy || toggling || !loaded || !settings.enabled) return
        setTestResult('')
        const result = validateLlmSettings({...settings, apiKey, clearApiKey})
        if (!result.ok) {
            setError(result.error);
            return
        }
        setBusy(true)
        setError('')
        try {
            const response = await api.save(result.data)
            if (response.ok) {
                setSettings(value => ({...response.data, enabled: value.enabled}))
                setApiKey('')
                setClearApiKey(false)
            } else setError(response.error)
        } catch {
            setError('无法保存 LLM 设置，请重试。')
        } finally {
            result.data.apiKey = '';
            setBusy(false)
        }
    }

    async function testConnection() {
        if (!api || busy || toggling || !loaded || !settings.enabled) return
        setTestResult('')
        const result = validateLlmSettings({...settings, apiKey, clearApiKey})
        if (!result.ok) {
            setError(result.error);
            return
        }
        setBusy(true)
        setTesting(true)
        setError('')
        const version = ++requestVersion.current
        try {
            const response = await api.test(result.data)
            if (version !== requestVersion.current) return
            if (response.ok) setTestResult(`连接成功 · ${response.data.elapsedMs} ms`)
            else setError(response.error)
        } catch {
            if (version === requestVersion.current) setError('连接测试失败，请重试。')
        } finally {
            result.data.apiKey = ''
            if (version === requestVersion.current) {
                setBusy(false);
                setTesting(false)
            }
        }
    }

    return <div className="llm-settings"><form className="llm-panel" onSubmit={save} aria-busy={busy || toggling}>
        <div className="llm-field llm-enable-field">
            <label id="llm-enable-label" htmlFor="llm-enable">启用</label>
            <button id="llm-enable" type="button" role="switch" className="llm-switch"
                    aria-labelledby="llm-enable-label" aria-checked={settings.enabled}
                    disabled={!api || !loaded || toggling} onClick={() => void toggleEnabled()}>
                <span className="llm-switch-track" aria-hidden="true"><span/></span>
            </button>
        </div>
        <fieldset disabled={!api || !loaded || busy || toggling || !settings.enabled}>
            <div className="llm-field">
                <label htmlFor="llm-base-url">接口地址</label>
                <input id="llm-base-url" type="url" value={settings.baseUrl} required maxLength={2048}
                       placeholder="https://example.com/v1" autoCapitalize="none" spellCheck={false}
                       onChange={event => {
                           setSettings({...settings, baseUrl: event.target.value, model: ''});
                           setModels(null);
                           edited()
                       }}/>
            </div>
            <div className="llm-field">
                <label htmlFor="llm-api-key">API Key</label>
                <div className="llm-key-control">
                    <input id="llm-api-key" type="password" value={apiKey} maxLength={4096} autoComplete="new-password"
                           autoCapitalize="none" spellCheck={false} disabled={clearApiKey}
                           placeholder={settings.hasApiKey ? '已配置密钥' : '可选'}
                           onChange={event => {
                               setApiKey(event.target.value);
                               setModels(null);
                               edited()
                           }}/>
                    {settings.hasApiKey && <label className="llm-clear-key">
                        <input type="checkbox" checked={clearApiKey} onChange={event => {
                            setClearApiKey(event.target.checked);
                            setApiKey('');
                            setModels(null);
                            edited()
                        }}/>清除已保存的密钥
                    </label>}
                </div>
            </div>
            <div className="llm-field">
                <label htmlFor="llm-model">模型名称</label>
                <div className="llm-model-control">
                    <select id="llm-model" value={settings.model} required
                            onChange={event => {
                                setSettings({...settings, model: event.target.value});
                                edited()
                            }}>
                        <option value="">请选择模型</option>
                        {(models ?? (settings.model ? [settings.model] : [])).map(model => <option key={model}
                                                                                                   value={model}>{model}</option>)}
                    </select>
                    <button type="button" className="secondary-button"
                            onClick={() => void loadModels()}>{fetchingModels ? '获取中…' : '获取模型'}</button>
                </div>
            </div>
            <section className="llm-prompts" aria-labelledby="llm-prompts-heading">
                <h3 id="llm-prompts-heading">提示词</h3>
                {promptFields.map(({key, label}) => <PromptSection key={key} id={`llm-${key}`} label={label}
                                                                   onReset={() => {
                                                                       setSettings(value => ({
                                                                           ...value,
                                                                           [key]: emptyLlmSettings()[key]
                                                                       }));
                                                                       edited()
                                                                   }}>
                    <div className="llm-prompt-control">
                        <textarea aria-labelledby={`llm-${key}-label`} value={settings[key]}
                                  maxLength={summaryPromptMaxLength} spellCheck={false}
                                  onChange={event => {
                                      setSettings({...settings, [key]: event.target.value});
                                      edited()
                                  }}/>
                    </div>
                </PromptSection>)}
                <PromptSection id="llm-tools" label="工具提示词">
                    <div className="llm-tool-prompts">
                        {(Object.keys(defaultToolDescriptions) as ChatToolName[]).map(name => <div
                            className="llm-prompt-control llm-tool-prompt" key={name}>
                            <div className="llm-prompt-toolbar">
                                <label htmlFor={`llm-tool-${name}`}>{name}</label>
                                <ResetPromptButton label={`${name} 提示词`} onReset={() => {
                                    setSettings(value => ({
                                        ...value, toolDescriptions: {
                                            ...value.toolDescriptions, [name]: defaultToolDescriptions[name],
                                        }
                                    }));
                                    edited()
                                }}/>
                            </div>
                            <textarea id={`llm-tool-${name}`} value={settings.toolDescriptions[name]}
                                      maxLength={2000} spellCheck={false}
                                      onChange={event => {
                                          setSettings({
                                              ...settings, toolDescriptions: {
                                                  ...settings.toolDescriptions, [name]: event.target.value,
                                              }
                                          });
                                          edited()
                                      }}/>
                        </div>)}
                    </div>
                </PromptSection>
            </section>
            <div className="llm-actions">
                <button type="submit"
                        className="primary-button">{busy && loaded && !testing && !fetchingModels ? '保存中…' : '保存'}</button>
                <button type="button" className="secondary-button"
                        onClick={() => void testConnection()}>{testing ? '测试中…' : '测试连接'}</button>
            </div>
        </fieldset>
        {!api && <p className="account-error" role="alert">LLM 设置服务不可用。</p>}
        {busy && !loaded && <p className="llm-status" role="status">读取中…</p>}
        {testing && <p className="llm-status" role="status">正在测试连接…</p>}
        {fetchingModels && <p className="llm-status" role="status">正在获取模型…</p>}
        {modelStatus && <p className="llm-status" role="status">{modelStatus}</p>}
        {testResult && <p className="llm-status" role="status">{testResult}</p>}
        {error && <div><p className="account-error" role="alert">{error}</p>
            {!loaded && api && <button type="button" className="secondary-button" disabled={busy}
                                       onClick={() => setRetry(value => value + 1)}>重试</button>}
        </div>}
    </form><UsagePanel active={active}/><MemoryPanel active={active}/></div>
}
