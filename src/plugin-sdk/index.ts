import {
    pluginApiVersion, pluginScheme, type PluginArguments, type PluginDragRegion, type PluginEvent, type PluginManifest,
    type PluginOperation, type PluginOverride, type PluginReturn, type PluginRoute, type PluginSurface, type PluginViewState
} from '../shared/plugins'
import {PluginConnection} from './connection'

export type {PluginManifest, PluginViewState} from '../shared/plugins'

export interface PluginHandshake {
    type: 'fdunav:connect'
    apiVersion: typeof pluginApiVersion
    pluginId: PluginManifest['id']
    surface: PluginSurface
    state: PluginViewState
}

export type PluginOverrides = {
    [K in PluginOverride]?: (...args: PluginArguments<K>) => PluginReturn<K> | Awaited<PluginReturn<K>>
}

type EventCallback<T extends PluginEvent> = Extract<PluginArguments<T>[0], (...args: never[]) => void>

export interface PluginClient {
    readonly pluginId: string
    readonly surface: PluginSurface
    readonly state: PluginViewState
    ready(): void
    call<T extends PluginOperation>(operation: T, ...args: PluginArguments<T>): PluginReturn<T>
    on<T extends PluginEvent>(event: T, callback: EventCallback<T>): Promise<() => void>
    onState(callback: (state: PluginViewState) => void): () => void
    navigate(route: PluginRoute): Promise<void>
    runCommand<T = unknown>(name: string, ...args: unknown[]): Promise<T>
    window: {
        minimize(): Promise<void>
        toggleMaximize(): Promise<void>
        close(): Promise<void>
        isMaximized(): Promise<boolean>
        onMaximizedChanged(callback: (maximized: boolean) => void): Promise<() => void>
        setDragRegions(regions: PluginDragRegion[]): Promise<void>
        openPluginManager(): Promise<void>
    }
}

export function connectPlugin(options: {
    overrides?: PluginOverrides
    commands?: Record<string, (...args: unknown[]) => unknown>
} = {}): Promise<PluginClient> {
    return new Promise(resolve => {
        const connect = (event: MessageEvent<PluginHandshake>) => {
            const handshake = event.data
            if (window.parent === window || event.source !== window.parent || !handshake || handshake.type !== 'fdunav:connect' ||
                handshake.apiVersion !== pluginApiVersion || window.location.protocol !== `${pluginScheme}:` ||
                window.location.hostname !== handshake.pluginId ||
                !event.ports[0]) return
            window.removeEventListener('message', connect)

            let state = handshake.state
            let lastSubscription = 0
            const subscribers = new Map<number, (...args: never[]) => void>()
            const stateListeners = new Set<(state: PluginViewState) => void>()
            const connection = new PluginConnection(event.ports[0], (method, [name, args]) => {
                if (typeof name !== 'string' || !Array.isArray(args)) throw new Error('插件调用参数无效。')
                const handlers = method === 'override' ? options.overrides : method === 'command' ? options.commands : undefined
                const handler = handlers && Object.hasOwn(handlers, name) ? (handlers as Record<string, unknown>)[name] : undefined
                if (typeof handler !== 'function') throw new Error(`插件未实现 ${name}。`)
                return handler(...args)
            }, (name, value) => {
                if (name === 'state') {
                    state = value as PluginViewState
                    for (const listener of stateListeners) listener(state)
                } else if (name === 'subscription') {
                    const {id, args} = value as {id: number; args: never[]}
                    subscribers.get(id)?.(...args)
                }
            })

            async function subscribe(eventName: string, callback: (...args: never[]) => void) {
                const id = ++lastSubscription
                subscribers.set(id, callback)
                try {
                    await connection.request('subscribe', [eventName, id])
                } catch (error) {
                    subscribers.delete(id)
                    throw error
                }
                return () => {
                    if (subscribers.delete(id)) void connection.request('unsubscribe', [id]).catch(() => undefined)
                }
            }

            const windowAction = <T,>(action: string, ...args: unknown[]) => connection.request('window', [action, ...args]) as Promise<T>
            const client: PluginClient = {
                pluginId: handshake.pluginId,
                surface: handshake.surface,
                get state() { return state },
                ready: () => connection.signal('ready'),
                call: <T extends PluginOperation>(operation: T, ...args: PluginArguments<T>) =>
                    connection.request('call', [operation, args]) as PluginReturn<T>,
                on: subscribe,
                onState: callback => {
                    stateListeners.add(callback)
                    return () => stateListeners.delete(callback)
                },
                navigate: route => connection.request('navigate', [route]) as Promise<void>,
                runCommand: <T,>(name: string, ...args: unknown[]) => connection.request('command', [name, args]) as Promise<T>,
                window: {
                    minimize: () => windowAction('minimize'),
                    toggleMaximize: () => windowAction('toggleMaximize'),
                    close: () => windowAction('close'),
                    isMaximized: () => windowAction('isMaximized'),
                    onMaximizedChanged: callback => subscribe('window.maximized', callback),
                    setDragRegions: regions => windowAction('setDragRegions', regions),
                    openPluginManager: () => windowAction('openPluginManager')
                }
            }
            resolve(client)
        }
        window.addEventListener('message', connect)
    })
}
