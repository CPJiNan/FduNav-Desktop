import {type ReactNode, useEffect, useRef, useState} from 'react'
import {PluginConnection} from '../../../plugin-sdk/connection'
import type {PluginHandshake} from '../../../plugin-sdk'
import {
    pluginApiVersion,
    type PluginDragRegion,
    pluginOrigin,
    type PluginRoute,
    type PluginViewState
} from '../../../shared/plugins'
import type {PluginFrameSpec, PluginRuntime} from './runtime'
import '../styles/plugins.css'

interface Props {
    runtime: PluginRuntime
    spec: PluginFrameSpec
    state?: PluginViewState
    onNavigate?: (route: PluginRoute, pluginId: string) => void
    fallback?: ReactNode | ((error: string) => ReactNode)
    keepFallback?: boolean
}

const startupTimeout = 8_000
const frameState = (state: PluginViewState | undefined, spec: PluginFrameSpec): PluginViewState => ({
    setup: state?.setup,
    calendarView: state?.calendarView,
    notice: spec.manifest.permissions.includes('notices') ? state?.notice : undefined,
    mail: spec.manifest.permissions.includes('mail') ? state?.mail : undefined
})

function dragRegions(input: unknown): PluginDragRegion[] {
    if (!Array.isArray(input) || input.length > 16) throw new Error('窗口拖动区无效。')
    return input.map(region => {
        const fields = ['x', 'y', 'width', 'height'] as const
        if (!region || fields.some(key => typeof region[key] !== 'number' || !Number.isFinite(region[key]) ||
            region[key] < 0 || region[key] > 20_000)) throw new Error('窗口拖动区坐标无效。')
        return {x: region.x, y: region.y, width: region.width, height: region.height}
    })
}

export function PluginFrame({runtime, spec, state, onNavigate, fallback, keepFallback}: Props) {
    const frame = useRef<HTMLIFrameElement>(null)
    const peer = useRef<PluginConnection | null>(null)
    const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
    const latest = useRef({state, onNavigate})
    const [ready, setReady] = useState(false)
    const [error, setError] = useState('')
    const [regions, setRegions] = useState<PluginDragRegion[]>([])
    const {manifest, surface} = spec
    const windowAccess = surface === 'app' || surface === 'titlebar'
    const background = surface === 'operations'

    useEffect(() => {
        latest.current = {state, onNavigate}
        peer.current?.signal('state', frameState(state, spec))
    }, [onNavigate, spec, state])

    function disconnect() {
        const connection = peer.current
        peer.current = null
        connection?.close()
    }

    function fail(message: string) {
        clearTimeout(timer.current)
        disconnect()
        if (background) runtime.providerStatus(manifest.id, undefined, message)
        setError(message)
    }

    useEffect(() => {
        timer.current = setTimeout(() => fail(`${spec.title} 未能启动。`), startupTimeout)
        return () => {
            clearTimeout(timer.current)
            disconnect()
        }
    }, [spec, runtime])

    function connect() {
        const child = frame.current?.contentWindow
        if (!child) return
        disconnect()
        clearTimeout(timer.current)
        timer.current = setTimeout(() => fail(`${spec.title} 未能启动。`), startupTimeout)
        setReady(false)
        setRegions([])
        const {port1, port2} = new MessageChannel()
        const subscriptions = new Map<number, () => void>()
        let started = false
        const connection = new PluginConnection(port1, async (request, [name, input]) => {
            switch (request) {
                case 'call':
                    return runtime.call(manifest, name, input)
                case 'command':
                    return runtime.runCommand(manifest, name, input)
                case 'navigate': {
                    if (typeof name !== 'string' || !latest.current.onNavigate) throw new Error('当前插件界面无法使用应用导航。')
                    return latest.current.onNavigate(name as PluginRoute, manifest.id)
                }
                case 'subscribe': {
                    if (typeof input !== 'number' || !Number.isSafeInteger(input) || input <= 0 ||
                        subscriptions.has(input) || subscriptions.size >= 32) throw new Error('插件订阅无效或过多。')
                    const publish = (...args: unknown[]) => connection.signal('subscription', {id: input, args})
                    const unsubscribe = name === 'window.maximized' && windowAccess && window.windowControls
                        ? window.windowControls.onMaximizedChanged(publish) : runtime.subscribe(manifest, name, publish)
                    subscriptions.set(input, unsubscribe)
                    return
                }
                case 'unsubscribe': {
                    if (typeof name === 'number') {
                        subscriptions.get(name)?.()
                        subscriptions.delete(name)
                    }
                    return
                }
                case 'window': {
                    const controls = window.windowControls
                    if (!windowAccess || !controls) throw new Error('窗口控制仅用于整窗界面或标题栏。')
                    switch (name) {
                        case 'minimize':
                            return controls.minimize()
                        case 'toggleMaximize':
                            return controls.toggleMaximize()
                        case 'close':
                            return controls.close()
                        case 'isMaximized':
                            return controls.isMaximized()
                        case 'setDragRegions':
                            return setRegions(dragRegions(input))
                        case 'openPluginManager': {
                            const result = await window.plugins?.enterSafeMode()
                            if (result && !result.ok) throw new Error(result.error)
                            return
                        }
                    }
                }
            }
            throw new Error('未知的插件请求。')
        }, signal => {
            if (signal !== 'ready' || started) return
            started = true
            clearTimeout(timer.current)
            if (background) runtime.providerStatus(manifest.id, connection)
            setReady(true)
        }, () => {
            for (const unsubscribe of subscriptions.values()) unsubscribe()
            subscriptions.clear()
            if (peer.current === connection) fail(`${spec.title} 的连接已关闭。`)
        })
        peer.current = connection
        const handshake: PluginHandshake = {
            type: 'fdunav:connect', apiVersion: pluginApiVersion, pluginId: manifest.id, surface,
            state: frameState(latest.current.state, spec)
        }
        child.postMessage(handshake, pluginOrigin(manifest.id), [port2])
    }

    const preserved = keepFallback && typeof fallback !== 'function' ? <div hidden={!error}>{fallback}</div> : null
    if (error) {
        if (preserved) return <>{preserved}</>
        if (typeof fallback === 'function') return <>{fallback(error)}</>
        if (fallback) return <>{fallback}</>
        if (background) return null
        return <p className="plugin-error" role="alert">{error}</p>
    }

    const source = `${pluginOrigin(manifest.id)}/${spec.entry.split('/').map(encodeURIComponent).join('/')}`
    return <>{preserved}
        <div
            className={`plugin-host plugin-host-${surface === 'app' || surface === 'titlebar' || background ? surface : 'view'}`}>
            {!ready && !background && <p className="plugin-loading" role="status">正在加载 {spec.title}…</p>}
            <iframe ref={frame} sandbox="allow-scripts allow-same-origin" referrerPolicy="no-referrer"
                    onLoad={connect} onError={() => fail(`无法加载 ${spec.title}。`)} src={source} title={spec.title}
                    className="plugin-frame" inert={!ready || background}/>
            {ready && regions.map(({x, y, width, height}, index) => <div aria-hidden="true"
                                                                         className="plugin-drag-region"
                                                                         key={index}
                                                                         style={{left: x, top: y, width, height}}/>)}
        </div>
    </>
}
