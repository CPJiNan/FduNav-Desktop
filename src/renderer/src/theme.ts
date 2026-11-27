import type {Theme} from '../../shared/accounts'

export type {Theme} from '../../shared/accounts'
let currentTheme: Theme = 'auto'

export function readTheme(): Theme {
    return currentTheme
}

export async function initializeTheme() {
    if (window.accounts) {
        try {
            const stored = await window.accounts.getTheme()
            if (stored.ok) {
                if (stored.data) currentTheme = stored.data
                else await saveTheme(currentTheme)
            }
        } catch {
        }
    }
    applyTheme(currentTheme)
}

export function applyTheme(theme: Theme) {
    currentTheme = theme
    document.documentElement.dataset.theme = theme
}

export async function saveTheme(theme: Theme): Promise<boolean> {
    applyTheme(theme)
    if (!window.accounts) return false
    try {
        return (await window.accounts.setTheme(theme)).ok
    } catch {
        return false
    }
}

