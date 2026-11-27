import type {AccountAPI, Result} from './accounts'
import type {AppInfoAPI} from './app-info'
import type {CalendarAPI, CalendarView} from './calendar'
import type {CampusCardAPI} from './campus-card'
import type {ChatAPI} from './chat'
import type {GeneralSettingsAPI} from './general-settings'
import type {LibraryAPI} from './library'
import type {LlmAPI} from './llm'
import type {MailAPI, MailItem} from './mail'
import type {MemoryAPI} from './memory'
import type {MessagePreferencesAPI} from './message-preferences'
import type {Notice, NoticesAPI} from './notices'
import type {NotificationSettingsAPI} from './notification-settings'
import type {ResearchAPI} from './research'
import type {SourcesAPI} from './sources'
import type {TimetableAPI} from './timetable'
import type {TodosAPI} from './todos'
import type {WeatherAPI} from './weather'

export const pluginApiVersion = 1
export const pluginScheme = 'fdunav-plugin'

export interface PluginServices {
    accounts: AccountAPI
    appInfo: AppInfoAPI
    calendar: CalendarAPI
    campusCard: CampusCardAPI
    chat: ChatAPI
    generalSettings: GeneralSettingsAPI
    library: LibraryAPI
    llm: LlmAPI
    mail: MailAPI
    memory: MemoryAPI
    messagePreferences: MessagePreferencesAPI
    notices: NoticesAPI
    notificationSettings: NotificationSettingsAPI
    research: ResearchAPI
    sources: SourcesAPI
    timetable: TimetableAPI
    todos: TodosAPI
    weather: WeatherAPI
}

export const pluginPermissions: Record<keyof PluginServices, string> = {
    accounts: '校园账号与主题',
    appInfo: '应用信息',
    calendar: '日历',
    campusCard: '校园卡',
    chat: '聊天与会话记录',
    generalSettings: '通用设置',
    library: '图书馆',
    llm: 'LLM 设置',
    mail: '邮箱与发信',
    memory: '聊天记忆',
    messagePreferences: '消息偏好',
    notices: '通知与摘要',
    notificationSettings: '通知设置',
    research: '旦挞与检索设置',
    sources: '消息来源',
    timetable: '课表',
    todos: '待办',
    weather: '天气'
}

type ServiceMethod<T> = Extract<keyof T, string>
type PluginMember = {
    [S in keyof PluginServices]: `${S}.${ServiceMethod<PluginServices[S]>}`
}[keyof PluginServices]
export type PluginMethod<T extends PluginMember> = T extends `${infer S extends keyof PluginServices}.${infer M}`
    ? M extends keyof PluginServices[S] ? PluginServices[S][M] : never : never
export type PluginArguments<T extends PluginMember> = Parameters<Extract<PluginMethod<T>, (...args: never[]) => unknown>>
export type PluginReturn<T extends PluginMember> = ReturnType<Extract<PluginMethod<T>, (...args: never[]) => unknown>>
export type PluginOperation = Exclude<PluginMember, `${string}.on${string}`>
export type PluginEvent = Exclude<PluginMember, PluginOperation>

export const pluginOverrides = [
    'calendar.list', 'calendar.save', 'calendar.remove', 'calendar.syncExams',
    'chat.get', 'chat.send', 'chat.retry',
    'library.crowding', 'notices.list', 'notices.detail', 'notices.summarize',
    'timetable.cached', 'timetable.get', 'todos.list', 'todos.save', 'todos.remove', 'weather.forecast'
] as const satisfies readonly PluginOperation[]
export type PluginOverride = typeof pluginOverrides[number]

export const pluginBuiltinPages = ['dashboard', 'notices', 'chat', 'mail', 'calendar', 'todos'] as const
export const pluginBuiltinSettings = [
    'general', 'notifications', 'account', 'messages', 'sources', 'llm', 'research', 'mail', 'about'
] as const
export type BuiltinPage = typeof pluginBuiltinPages[number]
export type BuiltinSetting = typeof pluginBuiltinSettings[number]
export type PluginView = 'app' | 'titlebar' | `page.${BuiltinPage}` | `settings.${BuiltinSetting}`
export const pluginViews: readonly PluginView[] = [
    'app', 'titlebar', ...pluginBuiltinPages.map(id => `page.${id}` as const),
    ...pluginBuiltinSettings.map(id => `settings.${id}` as const)
]
export type PluginRoute = `page.${BuiltinPage}` | `settings.${BuiltinSetting | 'plugins'}` | `plugin.${string}`
export type PluginSurface = PluginView | `plugin.${string}` | 'operations'

export interface PluginPage {
    id: string
    title: string
    entry: string
}

export interface PluginManifest {
    apiVersion: typeof pluginApiVersion
    id: string
    name: string
    version: string
    description?: string
    permissions: (keyof PluginServices)[]
    views?: Partial<Record<PluginView, string>>
    pages?: PluginPage[]
    operations?: {entry: string; overrides?: PluginOverride[]; commands?: string[]}
}

export interface InstalledPlugin {
    manifest: PluginManifest
    enabled: boolean
}

export interface PluginState {
    installed: InstalledPlugin[]
    application: string | null
    safeMode: boolean
}

export interface PluginManagerAPI {
    get(): Promise<Result<PluginState>>
    install(): Promise<Result<PluginState | null>>
    setEnabled(id: string, enabled: boolean): Promise<Result<PluginState>>
    selectApplication(id: string | null): Promise<Result<PluginState>>
    remove(id: string): Promise<Result<PluginState>>

    enterSafeMode(): Promise<Result<void>>

    exitSafeMode(): Promise<Result<void>>
}

export interface WindowControlsAPI {
    minimize(): void
    toggleMaximize(): void
    close(): void
    isMaximized(): Promise<boolean>
    onMaximizedChanged(callback: (maximized: boolean) => void): () => void
}

export interface PluginViewState {
    setup?: 'login' | 'preferences'
    calendarView?: CalendarView
    notice?: Notice | null
    mail?: MailItem | null
}

export interface PluginDragRegion {
    x: number
    y: number
    width: number
    height: number
}

export function pluginOrigin(id: string) {
    return `${pluginScheme}://${id}`
}
