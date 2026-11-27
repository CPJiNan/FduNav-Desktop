import type {AccountState, Result, Theme} from '../../../shared/accounts'
import type {MessagePreferences} from '../../../shared/message-preferences'
import {
    type PluginManifest, type PluginServices, type PluginState, type PluginSurface, type PluginView
} from '../../../shared/plugins'
import {PluginConnection} from '../../../plugin-sdk/connection'
import {applyTheme} from '../theme'

export interface PluginFrameSpec {
    manifest: PluginManifest
    surface: PluginSurface
    entry: string
    title: string
}

interface Provider {
    frame: PluginFrameSpec
    connected: Promise<void>
    settle(): void
    connection?: PluginConnection
    error?: string
}

type ServiceChange = {type: 'account'; value: AccountState} | {type: 'preferences'; value: MessagePreferences}
type Method = (...args: unknown[]) => unknown

export const emptyPluginState: PluginState = {installed: [], application: null, recovery: false}

export class PluginRuntime {
    readonly views = new Map<PluginView, PluginFrameSpec>()
    readonly pages = new Map<string, PluginFrameSpec>()
    readonly providers = new Map<string, Provider>()
    readonly application?: PluginFrameSpec
    private readonly overrides = new Map<string, Provider>()
    private readonly listeners = new Set<(change: ServiceChange) => void>()

    constructor(readonly state: PluginState, private readonly services = window.fdunavServices) {
        if (state.recovery) return
        for (const {manifest, enabled} of state.installed) {
            if (!enabled) continue
            for (const [id, entry] of Object.entries(manifest.views ?? {})) {
                const surface = id as PluginView
                const frame = {manifest, surface, entry, title: manifest.name}
                if (surface !== 'app') this.views.set(surface, frame)
                else if (manifest.id === state.application) this.application = frame
            }
            for (const page of manifest.pages ?? []) this.pages.set(`plugin.${manifest.id}/${page.id}`, {
                manifest, surface: `plugin.${page.id}`, entry: page.entry, title: page.title
            })
            if (manifest.operations) {
                let settle!: () => void
                const connected = new Promise<void>(resolve => { settle = resolve })
                const provider: Provider = {connected, settle, frame: {
                    manifest, surface: 'operations', entry: manifest.operations.entry, title: manifest.name
                }}
                this.providers.set(manifest.id, provider)
                for (const method of manifest.operations.overrides ?? []) this.overrides.set(method, provider)
            }
        }
    }

    installServices() {
        if (!this.services) return
        for (const [service, api] of Object.entries(this.services)) {
            const facade = Object.fromEntries(Object.entries(api).map(([method, original]) => {
                const operation = `${service}.${method}`
                const provider = this.overrides.get(operation)
                return [method, provider ? (...args: unknown[]) => this.invokeOverride(provider, operation, original as Method, args) : original]
            }))
            Object.assign(window, {[service]: Object.freeze(facade)})
        }
    }

    private async invokeOverride(provider: Provider, operation: string, original: Method, args: unknown[]) {
        await provider.connected
        if (!provider.connection) return original(...args)
        try {
            const result = await provider.connection.request('override', [operation, args], 60_000) as Result<unknown> | null
            if (result && typeof result === 'object' && (result.ok === true && Object.hasOwn(result, 'data') ||
                result.ok === false && typeof result.error === 'string')) return result
            throw new Error('插件返回了无效的操作结果。')
        } catch (error) {
            return {ok: false, error: `${provider.frame.title}：${error instanceof Error ? error.message : '操作失败。'}`}
        }
    }

    providerStatus(id: string, connection?: PluginConnection, error?: string) {
        const provider = this.providers.get(id)
        if (!provider) return
        provider.connection = connection
        provider.error = error
        provider.settle()
    }

    async runCommand(manifest: PluginManifest, name: unknown, args: unknown) {
        const provider = this.providers.get(manifest.id)
        if (!provider || typeof name !== 'string' || !manifest.operations?.commands?.includes(name) || !Array.isArray(args)) {
            throw new Error('插件命令无效或尚未声明。')
        }
        await provider.connected
        if (!provider.connection) throw new Error(provider.error ?? '插件命令不可用。')
        return provider.connection.request('command', [name, args], 60_000)
    }

    onServiceChange(listener: (change: ServiceChange) => void) {
        this.listeners.add(listener)
        return () => { this.listeners.delete(listener) }
    }

    private serviceMember(manifest: PluginManifest, name: unknown, subscription: boolean): Method {
        if (typeof name !== 'string') throw new Error('插件服务无效。')
        const [service, method, extra] = name.split('.')
        const allowed = manifest.permissions.includes(service as keyof PluginServices)
        const api = this.services?.[service as keyof PluginServices] as Record<string, unknown> | undefined
        if (extra !== undefined || !allowed || !api || !method || method.startsWith('on') !== subscription ||
            !Object.hasOwn(api, method) || typeof api[method] !== 'function') throw new Error('插件缺少对应服务权限。')
        return api[method] as Method
    }

    async call(manifest: PluginManifest, name: unknown, args: unknown) {
        if (!Array.isArray(args)) throw new Error('插件服务参数无效。')
        const result = await this.serviceMember(manifest, name, false)(...args) as Result<unknown>
        if (result?.ok) {
            if (name === 'accounts.login' || name === 'accounts.verify' || name === 'accounts.logout') {
                for (const listener of this.listeners) listener({type: 'account', value: result.data as AccountState})
            } else if (name === 'messagePreferences.save') {
                for (const listener of this.listeners) listener({type: 'preferences', value: result.data as MessagePreferences})
            } else if (name === 'accounts.setTheme') applyTheme(result.data as Theme)
        }
        return result
    }

    subscribe(manifest: PluginManifest, name: unknown, callback: (...args: unknown[]) => void) {
        return this.serviceMember(manifest, name, true)(callback) as () => void
    }
}
