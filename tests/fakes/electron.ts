export const handlers = new Map<string, (event: unknown, input?: unknown) => unknown>()
export const ipcMain = {
    handle: (channel: string, action: (event: unknown, input?: unknown) => unknown) => {
        if (handlers.has(channel)) throw new Error(`Attempted to register a second handler for '${channel}'`)
        handlers.set(channel, action)
    }
}
export const app = {once: () => {}}
