import {defaultSidebarItems, type SidebarItem} from '../../shared/general-settings'

let current: SidebarItem[] = defaultSidebarItems.map(item => ({...item}))
const listeners = new Set<(items: SidebarItem[]) => void>()

export function readSidebarItems(): SidebarItem[] {
    return current
}

export function applySidebarItems(items: SidebarItem[]) {
    current = items
    for (const listener of listeners) listener(current)
}

export function onSidebarItemsChange(listener: (items: SidebarItem[]) => void) {
    listeners.add(listener)
    return () => {
        listeners.delete(listener)
    }
}

export async function loadSidebarItems() {
    try {
        const result = await window.generalSettings?.get()
        if (result?.ok) applySidebarItems(result.data.sidebar)
    } catch {
        // 读取失败时保留默认布局。
    }
}
