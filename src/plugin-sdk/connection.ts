type Handler = (method: string, args: unknown[]) => unknown
type SignalHandler = (name: string, value: unknown) => void

interface PendingRequest {
    timer: ReturnType<typeof setTimeout>

    resolve(value: unknown): void

    reject(reason: Error): void
}

export class PluginConnection {
    private lastId = 0
    private receiving = 0
    private closed = false
    private readonly pending = new Map<number, PendingRequest>()

    constructor(private readonly port: MessagePort, private readonly handle: Handler,
                private readonly onSignal: SignalHandler, private readonly onClose?: () => void) {
        port.onmessage = event => void this.receive(event.data)
        port.onmessageerror = () => this.close()
        port.addEventListener('close', () => this.close())
        port.start()
    }

    request(method: string, args: unknown[], timeout = 300_000): Promise<unknown> {
        if (this.closed || this.pending.size >= 64) return Promise.reject(new Error('插件连接不可用或请求过多。'))
        const id = ++this.lastId
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => this.finish(id, false, '插件请求超时。'), timeout)
            this.pending.set(id, {resolve, reject, timer})
            try {
                this.port.postMessage({type: 'request', id, method, args})
            } catch {
                this.finish(id, false, '无法传输插件请求。')
            }
        })
    }

    signal(name: string, value?: unknown) {
        if (!this.closed) this.port.postMessage({type: 'signal', name, value})
    }

    close() {
        if (this.closed) return
        this.closed = true
        this.port.close()
        for (const id of this.pending.keys()) this.finish(id, false, '插件连接已关闭。')
        this.onClose?.()
    }

    private finish(id: number, ok: boolean, data: unknown) {
        const request = this.pending.get(id)
        if (!request) return
        clearTimeout(request.timer)
        this.pending.delete(id)
        if (ok) request.resolve(data)
        else request.reject(new Error(typeof data === 'string' ? data : '插件请求失败。'))
    }

    private async receive(value: unknown) {
        if (this.closed || !value || typeof value !== 'object') return
        const message = value as Record<string, unknown>
        if (message.type === 'signal' && typeof message.name === 'string') {
            this.onSignal(message.name, message.value)
            return
        }
        const id = message.id
        if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) return
        if (message.type === 'result') {
            this.finish(id, message.ok === true, message.value)
            return
        }
        if (message.type !== 'request' || typeof message.method !== 'string' || !Array.isArray(message.args)) return
        if (this.receiving >= 64) {
            this.port.postMessage({type: 'result', id, ok: false, value: '插件请求过多。'})
            return
        }
        this.receiving++
        try {
            const result = await this.handle(message.method, message.args)
            if (!this.closed) this.port.postMessage({type: 'result', id, ok: true, value: result})
        } catch (error) {
            if (!this.closed) this.port.postMessage({
                type: 'result', id, ok: false,
                value: error instanceof Error ? error.message : '插件请求失败。'
            })
        } finally {
            this.receiving--
        }
    }
}
