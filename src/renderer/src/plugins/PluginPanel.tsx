import {useEffect, useState} from 'react'
import type {Result} from '../../../shared/accounts'
import {pluginPermissions, type InstalledPlugin, type PluginState, type PluginView} from '../../../shared/plugins'
import {ConfirmDialog} from '../ConfirmDialog'
import {Icon} from '../Icon'
import {emptyPluginState} from './runtime'

type Confirmation = {action: 'enable' | 'remove'; plugin: InstalledPlugin}

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

export function PluginPanel({startupError}: {startupError?: string}) {
    const api = window.plugins
    const [state, setState] = useState(emptyPluginState)
    const [loading, setLoading] = useState(!!api)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')
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
        return () => { active = false }
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

    const update = (action: () => Promise<Result<PluginState>>) => void run(action, reloadManager)
    const blocked = !api || loading || busy
    return <div className="plugins-panel" aria-busy={loading || busy}>
        <header className="plugins-heading">
            <h1>插件</h1>
            <button type="button" className="primary-button" disabled={blocked} onClick={() => void run(
                () => api!.install(), value => { if (value) setState(value) }
            )}><Icon name="plus"/>安装插件</button>
        </header>
        {startupError && <p role="alert" className="plugin-error">{startupError}</p>}
        {error && <p role="alert" className="plugin-error">{error}</p>}
        {state.recovery && <div className="plugins-actions">
            <p>恢复模式已暂停插件。</p>
            <button type="button" className="secondary-button" disabled={blocked}
                    onClick={() => void run(() => api!.resume(), reloadManager)}>退出恢复模式</button>
        </div>}
        {state.application && <div className="plugins-actions">
            <button type="button" className="secondary-button" disabled={blocked}
                    onClick={() => update(() => api!.selectApplication(null))}>恢复默认界面</button>
        </div>}
        {loading ? <p role="status">正在读取插件…</p> : !state.installed.length && !error &&
            <p>{api ? '尚未安装插件。' : '请在桌面应用中安装插件。'}</p>}
        {state.installed.length > 0 && <ul className="plugins-list" aria-label="已安装插件">
            {state.installed.map(plugin => {
                const {manifest, enabled} = plugin
                const current = state.application === manifest.id
                const views = Object.keys(manifest.views ?? {}).map(view => viewLabels[view as PluginView])
                const pages = manifest.pages?.map(page => page.title) ?? []
                const overrides = manifest.operations?.overrides ?? []
                const commands = manifest.operations?.commands ?? []
                return <li className="plugin-card" key={manifest.id}>
                    <div className="plugin-card-name"><Icon name="processor"/><h2>{manifest.name}</h2>
                        <span>v{manifest.version}</span></div>
                    {manifest.description && <p>{manifest.description}</p>}
                    {(views.length > 0 || pages.length > 0) && <p>界面与页面 · {[...views, ...pages].join('、')}</p>}
                    {overrides.length > 0 && <p>覆盖操作 · {overrides.join('、')}</p>}
                    {commands.length > 0 && <p>新增命令 · {commands.join('、')}</p>}
                    <p>服务权限 · {manifest.permissions.map(permission => pluginPermissions[permission]).join('、') || '无'}</p>
                    <div className="plugin-card-actions">
                        <span>{current ? '已选为整窗界面' : enabled ? '已启用' : '已停用'}</span>
                        <div className="plugins-actions">
                            {enabled && manifest.views?.app && !current &&
                                <button type="button" className="secondary-button" disabled={blocked}
                                        onClick={() => update(() => api!.selectApplication(manifest.id))}>使用整窗界面</button>}
                            <button type="button" className="secondary-button" disabled={blocked} onClick={() => {
                                if (enabled) update(() => api!.setEnabled(manifest.id, false))
                                else setConfirmation({action: 'enable', plugin})
                            }}>{enabled ? '停用' : '启用'}</button>
                            <button type="button" className="secondary-button plugin-remove" disabled={blocked}
                                    onClick={() => setConfirmation({action: 'remove', plugin})}>卸载</button>
                        </div>
                    </div>
                </li>
            })}
        </ul>}
        {confirmation && <ConfirmDialog
            title={confirmation.action === 'enable' ? '启用插件' : '卸载插件'}
            message={confirmation.action === 'enable'
                ? `启用后，${confirmation.plugin.manifest.name} 可使用卡片上列出的权限。请确认你信任此插件。`
                : `卸载后，${confirmation.plugin.manifest.name} 提供的界面和操作将停用。`}
            confirmLabel={confirmation.action === 'enable' ? '启用' : '卸载'} danger={confirmation.action === 'remove'} busy={busy}
            onCancel={() => setConfirmation(null)} onConfirm={() => update(() => confirmation.action === 'enable'
                ? api!.setEnabled(confirmation.plugin.manifest.id, true) : api!.remove(confirmation.plugin.manifest.id))}/>}
    </div>
}
