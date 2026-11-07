export const handlers = new Map<string, (event: unknown, input?: unknown) => unknown>()
export const ipcMain = {handle: (channel: string, action: (event: unknown, input?: unknown) => unknown) => handlers.set(channel, action)}
export const app = {once: () => {}}
