import {useEffect, useMemo, useState} from 'react'
import type {Result} from '../../../shared/accounts'
import {type InstalledPlugin, pluginPermissions, type PluginState, type PluginView} from '../../../shared/plugins'
import {ConfirmDialog} from '../ConfirmDialog'
import {Icon} from '../Icon'
import {emptyPluginState} from './runtime'
import '../styles/plugins.css'

type Confirmation = {action: 'enable' | 'remove'; plugin: InstalledPlugin}
type Filter = 'all' | 'enabled' | 'disabled'

const filters: { id: Filter; label: string }[] = [
    {id: 'all', label: '全部'},
    {id: 'enabled', label: '已启用'},
    {id: 'disabled', label: '已停用'}
]

const viewLabels: Record<PluginView, string> = {
    app: '整窗界面', titlebar: '标题栏', 'page.dashboard': '仪表盘', 'page.notices': '通知', 'page.chat': '聊天',
    'page.mail': '邮箱', 'page.calendar': '日历', 'page.todos': '待办', 'settings.general': '通用设置',
    'settings.notifications': '通知设置', 'settings.account': '账号设置', 'settings.messages': '消息偏好',
    'settings.sources': '消息来源', 'settings.llm': 'LLM 设置', 'settings.research': '旦挞设置',
    'settings.mail': '邮箱设置', 'settings.about': '关于'
}

function reloadManager() {
    window.location.hash = 'plugins'
    window.location.reload()
}

type PluginTag = { label: string; value?: string }

function pluginTags(plugin: InstalledPlugin) {
    const {manifest} = plugin
    const tags: PluginTag[] = []
    if (manifest.views?.app) tags.push({label: '整窗界面'})
    for (const view of Object.keys(manifest.views ?? {})) {
        if (view !== 'app') tags.push({label: '替换', value: viewLabels[view as PluginView]})
    }
    for (const page of manifest.pages ?? []) tags.push({label: '页面', value: page.title})
    for (const override of manifest.operations?.overrides ?? []) tags.push({label: '覆盖', value: override})
    for (const command of manifest.operations?.commands ?? []) tags.push({label: '命令', value: command})
    return tags
}

export function PluginPanel({startupError}: {startupError?: string}) {
    const api = window.plugins
    const [state, setState] = useState(emptyPluginState)
    const [loading, setLoading] = useState(!!api)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')
    const [query, setQuery] = useState('')
    const [filter, setFilter] = useState<Filter>('all')
    const [confirmation, setConfirmation] = useState<Confirmation | null>(null)

    useEffect(() => {
        let active = true
        if (api) void api.get().then(result => {
            if (!active) return
            if (result.ok) setState(result.data)
            else setError(result.error)
        }).catch(() => {
            if (active) setError('无法读取已安装的插件。')
        }).finally(() => {
            if (active) setLoading(false)
        })
        return () => {
            active = false
        }
    }, [api])

    async function run<T>(action: () => Promise<Result<T>>, onSuccess: (value: T) => void) {
        if (busy) return
        setBusy(true)
        setError('')
        try {
            const result = await action()
            setConfirmation(null)
            if (!result.ok) setError(result.error)
            else onSuccess(result.data)
        } catch {
            setConfirmation(null)
            setError('插件操作失败，请重试。')
        } finally {
            setBusy(false)
        }
    }

    async function refresh() {
        if (!api || busy) return
        setBusy(true)
        setError('')
        try {
            const result = await api.get()
            if (!result.ok) setError(result.error)
            else setState(result.data)
        } catch {
            setError('无法读取已安装的插件。')
        } finally {
            setBusy(false)
        }
    }

    const update = (action: () => Promise<Result<PluginState>>) => void run(action, reloadManager)
    const blocked = !api || loading || busy
    const search = query.trim().toLocaleLowerCase()
    const counts = {
        all: state.installed.length,
        enabled: state.installed.filter(plugin => plugin.enabled).length,
        disabled: state.installed.filter(plugin => !plugin.enabled).length
    }
    const visible = useMemo(() => state.installed.filter(plugin => {
        if (filter === 'enabled' && !plugin.enabled) return false
        if (filter === 'disabled' && plugin.enabled) return false
        if (!search) return true
        const {manifest} = plugin
        return `${manifest.name} ${manifest.id} ${manifest.description ?? ''}`.toLocaleLowerCase().includes(search)
    }), [filter, search, state.installed])

    return <div className="plugins-panel" aria-busy={loading || busy}>
        <header className="plugins-header">
            <div className="plugins-heading">
                <h1>插件</h1>
            </div>
            <div className="plugins-header-actions">
                <button type="button" className="secondary-button" disabled={blocked}
                        onClick={() => void refresh()}><Icon name="refresh"/>{busy && !loading ? '刷新中…' : '刷新'}
                </button>
                <button type="button" className="primary-button" disabled={blocked} onClick={() => void run(
                    () => api!.install(), value => {
                        if (value) setState(value)
                    }
                )}><Icon name="plus"/>安装插件
                </button>
            </div>
        </header>
        {startupError && <p className="account-error" role="alert">{startupError}</p>}
        {error && <p className="account-error" role="alert">{error}</p>}
        {state.safeMode && <div className="plugins-banner">
            <p>FduNav 正处于安全模式，所有插件将被禁用。</p>
            <button type="button" className="secondary-button" disabled={blocked}
                    onClick={() => void run(() => api!.exitSafeMode(), reloadManager)}>退出安全模式
            </button>
        </div>}
        {state.application && <div className="plugins-banner">
            <p>正在使用 <strong>{state.installed.find(plugin => plugin.manifest.id === state.application)?.manifest.name}</strong> 的整窗界面。
            </p>
            <button type="button" className="secondary-button" disabled={blocked}
                    onClick={() => update(() => api!.selectApplication(null))}>恢复默认界面</button>
        </div>}
        {!api && <p className="account-notice">请在桌面应用中管理插件。</p>}
        <div className="plugins-layout">
            <nav className="plugins-filters" aria-label="筛选已安装插件">
                {filters.map(item => <button type="button" key={item.id} className="plugins-filter"
                                             aria-pressed={filter === item.id}
                                             onClick={() => setFilter(item.id)}>
                    <span>{item.label}</span>
                    <span className="plugins-filter-count">{counts[item.id]}</span>
                </button>)}
            </nav>
            <div className="plugins-main">
                <div className="plugins-search">
                    <Icon name="search"/>
                    <input type="search" aria-label="搜索插件" placeholder="搜索插件名称、ID 或说明"
                           value={query} disabled={!state.installed.length}
                           onChange={event => setQuery(event.target.value)}/>
                </div>
                {loading ? <p className="plugins-status" role="status">正在读取插件…</p> : <>
                    {visible.length > 0 && <ul className="plugins-grid" aria-label="已安装插件">
                        {visible.map(plugin => {
                            const {manifest, enabled} = plugin
                            const current = state.application === manifest.id
                            const tags = pluginTags(plugin)
                            const permissions = manifest.permissions.map(permission => pluginPermissions[permission])
                            return <li className={`plugin-card ${enabled ? 'is-enabled' : ''}`} key={manifest.id}>
                                <div className="plugin-card-head">
                                    <span className="plugin-card-icon"><Icon name="puzzle"/></span>
                                    <div className="plugin-card-heading">
                                        <h2>{manifest.name}</h2>
                                        <span className="plugin-card-meta">v{manifest.version} {manifest.id}</span>
                                    </div>
                                    <span className={`plugin-state ${enabled ? 'is-enabled' : ''}`}>
                                        <span className="plugin-state-dot" aria-hidden="true"/>
                                        {enabled ? '已启用' : '已停用'}
                                    </span>
                                </div>
                                <p className="plugin-card-description">{manifest.description ?? '该插件未提供说明。'}</p>
                                <ul className="plugin-card-tags">
                                    {tags.map(tag => <li className="plugin-card-tag"
                                                         key={`${tag.label}${tag.value ?? ''}`}>
                                        <span
                                            className="plugin-card-tag-label">{tag.label}</span>{tag.value ? ` ${tag.value}` : ''}
                                    </li>)}
                                    <li className="plugin-card-tag">
                                        <span
                                            className="plugin-card-tag-label">权限</span>{` ${permissions.length ? permissions.join('、') : '无'}`}
                                    </li>
                                </ul>
                                <div className="plugin-card-actions">
                                    {enabled && manifest.views?.app && !current &&
                                        <button type="button" className="secondary-button" disabled={blocked}
                                                onClick={() => update(() => api!.selectApplication(manifest.id))}>使用整窗界面</button>}
                                    <button type="button" className="secondary-button" disabled={blocked}
                                            onClick={() => {
                                                if (enabled) update(() => api!.setEnabled(manifest.id, false))
                                                else setConfirmation({action: 'enable', plugin})
                                            }}>{enabled ? '停用' : '启用'}</button>
                                    <button type="button" className="secondary-button plugin-remove" disabled={blocked}
                                            onClick={() => setConfirmation({action: 'remove', plugin})}>卸载
                                    </button>
                                </div>
                            </li>
                        })}
                    </ul>}
                    {!state.installed.length && !error && <div className="plugins-empty">
                        <Icon name="puzzle"/>
                        <h2>{api ? '尚未安装插件' : '插件服务不可用'}</h2>
                        <p>{api ? '插件以独立网页运行，可替换界面或扩展服务。安装前请确认来源可信。' : '请在桌面应用中使用插件功能。'}</p>
                        {api && <button type="button" className="primary-button" disabled={blocked}
                                        onClick={() => void run(() => api!.install(), value => {
                                            if (value) setState(value)
                                        })}><Icon name="plus"/>安装插件</button>}
                    </div>}
                    {!!state.installed.length && !visible.length && <div className="plugins-empty">
                        <Icon name="search"/>
                        <h2>没有匹配的插件</h2>
                    </div>}
                </>}
            </div>
        </div>
        {confirmation && <ConfirmDialog
            title={confirmation.action === 'enable' ? '启用插件' : '卸载插件'}
            message={confirmation.action === 'enable' ? '是否启用插件？'
                : `卸载后，${confirmation.plugin.manifest.name} 提供的界面和操作将停用。`}
            confirmLabel={confirmation.action === 'enable' ? '启用' : '卸载'} danger={confirmation.action === 'remove'}
            busy={busy} onCancel={() => setConfirmation(null)}
            onConfirm={() => update(() => confirmation.action === 'enable'
                ? api!.setEnabled(confirmation.plugin.manifest.id, true) : api!.remove(confirmation.plugin.manifest.id))}/>}
    </div>
}
