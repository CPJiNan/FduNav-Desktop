import {app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent, net, protocol, session} from 'electron'
import {extname, join} from 'node:path'
import {pathToFileURL} from 'node:url'
import type {Result} from '../shared/accounts'
import {pluginScheme} from '../shared/plugins'
import {isPluginId} from './plugin-manifest'
import {PluginStore} from './plugin-store'

const contentTypes: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json',
    '.wasm': 'application/wasm',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.svg': 'image/svg+xml'
}

const isPluginUrl = (url?: string) => url?.startsWith(`${pluginScheme}://`) === true

export function registerPluginScheme() {
    protocol.registerSchemesAsPrivileged([{
        scheme: pluginScheme,
        privileges: {standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true}
    }])
}

export async function registerPluginHandlers(trusted: (event: IpcMainInvokeEvent) => boolean) {
    const store = new PluginStore(join(app.getPath('userData'), 'plugins'))
    await store.load()
    let safeMode = app.commandLine.hasSwitch('safe-mode')
    const renderer = !app.isPackaged && process.env.ELECTRON_RENDERER_URL
    const hostOrigin = renderer ? new URL(renderer).origin : 'file:'
    const csp = `default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; ` +
        `img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' blob:; connect-src 'self'; ` +
        `worker-src 'self' blob:; base-uri 'none'; form-action 'none'; frame-ancestors ${hostOrigin}`

    protocol.handle(pluginScheme, async request => {
        if (safeMode) return new Response(null, {status: 403})
        if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, {status: 405})
        try {
            const url = new URL(request.url)
            const file = isPluginId(url.hostname) && !url.port && !url.username && !url.password
                ? await store.asset(url.hostname, decodeURIComponent(url.pathname.slice(1))) : null
            if (!file || safeMode) return new Response(null, {status: 404})
            const range = request.headers.get('range')
            const resource = await net.fetch(pathToFileURL(file).href, {
                method: request.method, headers: range ? {Range: range} : undefined
            })
            const headers = new Headers(resource.headers)
            const type = contentTypes[extname(file).toLowerCase()]
            if (type) headers.set('Content-Type', type)
            headers.set('Content-Security-Policy', csp)
            headers.set('Cache-Control', 'no-store')
            headers.set('X-Content-Type-Options', 'nosniff')
            return new Response(request.method === 'HEAD' ? null : resource.body, {status: resource.status, headers})
        } catch {
            return new Response(null, {status: 404})
        }
    })

    const rendererSession = session.defaultSession
    rendererSession.setPermissionRequestHandler((_contents, _permission, reply, details) => reply(!isPluginUrl(details.requestingUrl)))
    rendererSession.setPermissionCheckHandler((_contents, _permission, origin, details) =>
        ![origin, details.requestingUrl, details.securityOrigin].some(isPluginUrl))
    rendererSession.webRequest.onBeforeRequest({urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*']}, (details, reply) => {
        reply({cancel: isPluginUrl(details.initiatorOrigin) || isPluginUrl(details.frame?.url)})
    })

    const snapshot = () => store.snapshot(safeMode)
    const enterSafeMode = (window: BrowserWindow | null) => {
        if (!window || window.isDestroyed()) return
        safeMode = true
        window.webContents.reload()
    }

    function handle<T>(channel: string, action: (input: unknown, event: IpcMainInvokeEvent) => T | Promise<T>) {
        ipcMain.handle(`plugins:${channel}`, async (event, input): Promise<Result<T>> => {
            if (!trusted(event)) return {ok: false, error: '请求来源无效。'}
            try {
                return {ok: true, data: await action(input, event)}
            } catch (error) {
                return {ok: false, error: error instanceof Error ? error.message : '插件操作失败。'}
            }
        })
    }

    handle('get', snapshot)
    handle('install', async (_input, event) => {
        const window = BrowserWindow.fromWebContents(event.sender)
        if (!window) throw new Error('无法打开插件目录选择器。')
        const result = await dialog.showOpenDialog(window, {title: '选择插件包目录', properties: ['openDirectory']})
        if (result.canceled || !result.filePaths[0]) return null
        await store.install(result.filePaths[0])
        return snapshot()
    })
    handle('set-enabled', async input => {
        const value = input as { id?: unknown; enabled?: unknown } | null
        if (!isPluginId(value?.id) || typeof value.enabled !== 'boolean') throw new Error('插件状态无效。')
        await store.setEnabled(value.id, value.enabled)
        return snapshot()
    })
    handle('select-application', async id => {
        if (id !== null && !isPluginId(id)) throw new Error('插件 ID 无效。')
        await store.selectApplication(id)
        return snapshot()
    })
    handle('remove', async id => {
        if (!isPluginId(id)) throw new Error('插件 ID 无效。')
        await store.remove(id)
        return snapshot()
    })
    handle('enter-safe-mode', (_input, event) => enterSafeMode(BrowserWindow.fromWebContents(event.sender)))
    handle('exit-safe-mode', () => {
        safeMode = false
    })

    return {
        enterSafeMode,
        attach(window: BrowserWindow) {
            window.webContents.on('will-frame-navigate', event => {
                const previous = [event.frame?.url, event.initiator?.url].find(isPluginUrl)
                if (!previous) return
                const from = new URL(previous)
                const allowed = !event.isMainFrame && isPluginUrl(event.url) && new URL(event.url).host === from.host
                if (!allowed) event.preventDefault()
            })
            window.webContents.on('before-input-event', (event, input) => {
                if (input.type === 'keyDown' && !input.isAutoRepeat && (input.control || input.meta) && input.shift &&
                    !input.alt && input.key.toLowerCase() === 'p') {
                    event.preventDefault()
                    enterSafeMode(window)
                }
            })
        }
    }
}
