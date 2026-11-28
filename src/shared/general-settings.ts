import type {Result} from './accounts'

export type CloseAction = 'tray' | 'quit'

export function isCloseAction(value: unknown): value is CloseAction {
    return value === 'tray' || value === 'quit'
}

export const sidebarItemIds = ['dashboard', 'notices', 'chat', 'mail', 'calendar', 'todos'] as const
export type SidebarItemId = typeof sidebarItemIds[number]

export interface SidebarItem {
    id: SidebarItemId
    enabled: boolean
}

export const defaultSidebarItems: readonly SidebarItem[] = sidebarItemIds.map(id => ({id, enabled: true}))

export function isSidebarItemId(value: unknown): value is SidebarItemId {
    return typeof value === 'string' && (sidebarItemIds as readonly string[]).includes(value)
}

/** 按 id 去重并补齐缺失项，保证顺序、数量与类型始终有效。 */
export function normalizeSidebarItems(value: unknown): SidebarItem[] {
    const items: SidebarItem[] = []
    if (Array.isArray(value)) {
        for (const entry of value) {
            if (!entry || typeof entry !== 'object') continue
            const {id, enabled} = entry as { id?: unknown; enabled?: unknown }
            if (!isSidebarItemId(id) || typeof enabled !== 'boolean' || items.some(item => item.id === id)) continue
            items.push({id, enabled})
        }
    }
    for (const item of defaultSidebarItems) {
        if (!items.some(entry => entry.id === item.id)) items.push({...item})
    }
    return items
}

export interface GeneralSettings {
    launchAtLogin: boolean
    launchAtLoginAvailable: boolean
    closeAction: CloseAction
    sidebar: SidebarItem[]
}

export interface GeneralSettingsAPI {
    get(): Promise<Result<GeneralSettings>>

    setLaunchAtLogin(enabled: boolean): Promise<Result<GeneralSettings>>

    setCloseAction(action: CloseAction): Promise<Result<GeneralSettings>>

    setSidebar(items: SidebarItem[]): Promise<Result<GeneralSettings>>
}
