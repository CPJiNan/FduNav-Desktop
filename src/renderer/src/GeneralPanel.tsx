import {type ComponentProps, useEffect, useState} from 'react'
import type {CloseAction, GeneralSettings, SidebarItem, SidebarItemId} from '../../shared/general-settings'
import type {Result} from '../../shared/accounts'
import {Icon} from './Icon'
import {readTheme, saveTheme, type Theme} from './theme'
import {applySidebarItems, onSidebarItemsChange, readSidebarItems} from './sidebar'
import './styles/general.css'
import './styles/llm.css'

const themes = [
    {value: 'light', label: '浅色主题', icon: 'sun'},
    {value: 'dark', label: '深色主题', icon: 'moon'},
    {value: 'auto', label: '跟随系统', icon: 'monitor'},
] as const

type IconName = ComponentProps<typeof Icon>['name']

const sidebarLabels: Record<SidebarItemId, { label: string; icon: IconName }> = {
    dashboard: {label: '仪表盘', icon: 'dashboard'},
    notices: {label: '通知', icon: 'notices'},
    chat: {label: '聊天', icon: 'chat'},
    mail: {label: '邮箱', icon: 'mail'},
    calendar: {label: '日历', icon: 'calendar'},
    todos: {label: '待办', icon: 'todo'},
}

export function GeneralPanel() {
    const [theme, setTheme] = useState<Theme>(readTheme)
    const [storageError, setStorageError] = useState(false)
    const [settings, setSettings] = useState<GeneralSettings | null>(null)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')
    const [retry, setRetry] = useState(0)
    const [sidebar, setSidebar] = useState(readSidebarItems)
    const [dragging, setDragging] = useState<SidebarItemId | null>(null)
    const [dropTarget, setDropTarget] = useState<{ id: SidebarItemId; after: boolean } | null>(null)
    const api = window.generalSettings

    useEffect(() => {
        if (!api) return
        let active = true
        setBusy(true)
        setError('')
        void api.get().then(result => {
            if (!active) return
            if (result.ok) setSettings(result.data)
            else setError(result.error)
        }).catch(() => {
            if (active) setError('无法读取通用设置，请重试。')
        }).finally(() => {
            if (active) setBusy(false)
        })
        return () => {
            active = false
        }
    }, [api, retry])

    useEffect(() => onSidebarItemsChange(setSidebar), [])

    useEffect(() => {
        if (settings) applySidebarItems(settings.sidebar)
    }, [settings])

    async function save(action: () => Promise<Result<GeneralSettings>>) {
        if (busy) return
        setBusy(true)
        setError('')
        try {
            const result = await action()
            if (result.ok) {
                setSettings(result.data)
            } else setError(result.error)
        } catch {
            setError('无法保存通用设置，请重试。')
        } finally {
            setBusy(false)
        }
    }

    async function saveSidebar(next: SidebarItem[]) {
        if (!api || busy) return
        const previous = settings?.sidebar ?? sidebar
        applySidebarItems(next)
        setBusy(true)
        setError('')
        try {
            const result = await api.setSidebar(next)
            if (result.ok) setSettings(result.data)
            else {
                setError(result.error)
                applySidebarItems(previous)
            }
        } catch {
            setError('无法保存侧边栏设置，请重试。')
            applySidebarItems(previous)
        } finally {
            setBusy(false)
        }
    }

    function move(id: SidebarItemId, target: SidebarItemId, after: boolean) {
        setDragging(null)
        setDropTarget(null)
        if (!api || busy || id === target) return
        const source = sidebar.find(item => item.id === id)
        if (!source) return
        const next = sidebar.filter(item => item.id !== id)
        const index = next.findIndex(item => item.id === target)
        if (index < 0) return
        next.splice(index + Number(after), 0, source)
        if (next.every((item, position) => item.id === sidebar[position].id)) return
        void saveSidebar(next)
    }

    function toggle(id: SidebarItemId, enabled: boolean) {
        void saveSidebar(sidebar.map(item => item.id === id ? {...item, enabled} : item))
    }

    async function selectTheme(next: Theme) {
        setTheme(next)
        setStorageError(!await saveTheme(next))
    }

    return <div className="general-panel">
        <fieldset className="general-setting-group" aria-busy={busy}>
            <legend>应用</legend>
            <div className="general-setting-row">
                <label id="launch-at-login-label" htmlFor="launch-at-login">开机后自动启动 FduNav</label>
                <button id="launch-at-login" type="button" className="llm-switch" role="switch"
                        aria-labelledby="launch-at-login-label" aria-checked={settings?.launchAtLogin ?? false}
                        disabled={!api || !settings?.launchAtLoginAvailable || busy}
                        onClick={() => void save(() => api!.setLaunchAtLogin(!settings!.launchAtLogin))}>
                    <span className="llm-switch-track" aria-hidden="true"><span/></span>
                </button>
            </div>
            <div className="general-setting-row">
                <label htmlFor="close-action">关闭 FduNav 时</label>
                <select id="close-action" value={settings?.closeAction ?? 'tray'} disabled={!api || !settings || busy}
                        onChange={event => void save(() => api!.setCloseAction(event.target.value as CloseAction))}>
                    <option value="tray">最小化至托盘</option>
                    <option value="quit">退出 FduNav</option>
                </select>
            </div>
            {!api && <p className="account-notice">请在桌面应用中设置。</p>}
            {busy && <p className="save-status" role="status">{settings ? '正在保存…' : '正在读取设置…'}</p>}
            {error && <p className="account-error" role="alert">{error}{!settings &&
                <button type="button" className="text-button" disabled={busy}
                        onClick={() => setRetry(value => value + 1)}>重试</button>}</p>}
        </fieldset>
        <fieldset className="general-setting-group theme-options">
            <legend>主题</legend>
            <div className="theme-grid">{themes.map(item => <label
                className={`theme-option ${theme === item.value ? 'is-selected' : ''}`} key={item.value}>
                <input type="radio" name="theme" value={item.value} checked={theme === item.value}
                       onChange={() => void selectTheme(item.value)}/>
                <div className={`theme-preview preview-${item.value}`} aria-hidden="true">
                    {(item.value === 'auto' ? ['light', 'dark'] : [item.value]).map(mode =>
                        <div key={mode} data-theme={mode} className="mini-app">
                            <div className="mini-rail"/>
                            <div className="mini-content">
                                <div className="mini-toolbar"/>
                                <div className="mini-bubble"/>
                                <div className="mini-input"/>
                            </div>
                        </div>)}
                </div>
                <div className="theme-option-title"><Icon name={item.icon}/><span>{item.label}</span>
                    <span className="radio-indicator">{theme === item.value && <Icon name="check"/>}</span>
                </div>
            </label>)}</div>
            {storageError && <p className="save-status has-error" role="alert">主题已生效，但无法保存偏好。</p>}
        </fieldset>
        <fieldset className="general-setting-group" aria-busy={busy}>
            <legend>侧边栏</legend>
            <ul className="sidebar-list" aria-label="侧边栏图标">
                {sidebar.map((item, index) => {
                    const meta = sidebarLabels[item.id]
                    const target = dropTarget?.id === item.id
                    return <li key={item.id}
                               className={`${dragging === item.id ? 'is-dragging' : ''} ${target ? dropTarget.after ? 'drop-after' : 'drop-before' : ''}`}
                               onDragOver={event => {
                                   if (!dragging || busy) return
                                   event.preventDefault()
                                   event.dataTransfer.dropEffect = 'move'
                                   const bounds = event.currentTarget.getBoundingClientRect()
                                   setDropTarget({
                                       id: item.id,
                                       after: event.clientY > bounds.top + bounds.height / 2
                                   })
                               }}
                               onDragLeave={event => {
                                   if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(null)
                               }}
                               onDrop={event => {
                                   event.preventDefault()
                                   if (!dragging) return
                                   const bounds = event.currentTarget.getBoundingClientRect()
                                   move(dragging, item.id, event.clientY > bounds.top + bounds.height / 2)
                               }}>
                        <button type="button" className="icon-button sidebar-drag-handle" draggable={!busy && !!api}
                                aria-label={`排序 ${meta.label}`} aria-disabled={busy || !api} title="拖动排序"
                                onDragStart={event => {
                                    if (busy || !api) {
                                        event.preventDefault()
                                        return
                                    }
                                    event.dataTransfer.effectAllowed = 'move'
                                    event.dataTransfer.setData('text/plain', item.id)
                                    setDragging(item.id)
                                }}
                                onDragEnd={() => {
                                    setDragging(null)
                                    setDropTarget(null)
                                }}
                                onKeyDown={event => {
                                    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
                                    event.preventDefault()
                                    const after = event.key === 'ArrowDown'
                                    const neighbour = sidebar[index + (after ? 1 : -1)]
                                    if (neighbour) move(item.id, neighbour.id, after)
                                }}><Icon name="grip"/></button>
                        <span className="sidebar-item-icon"><Icon name={meta.icon}/></span>
                        <div className="sidebar-item-info"><strong>{meta.label}</strong></div>
                        <label className="sidebar-item-enabled">
                            <input type="checkbox" checked={item.enabled} disabled={busy || !api || !settings}
                                   aria-label={`显示 ${meta.label}`}
                                   onChange={event => toggle(item.id, event.target.checked)}/>
                            显示
                        </label>
                    </li>
                })}
            </ul>
        </fieldset>
    </div>
}
