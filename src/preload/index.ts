import {contextBridge, ipcRenderer, type IpcRendererEvent} from 'electron'
import type {AccountAPI} from '../shared/accounts'
import type {NoticesAPI, SummaryTask} from '../shared/notices'
import type {MessagePreferencesAPI} from '../shared/message-preferences'
import type {SourcesAPI} from '../shared/sources'
import type {LlmAPI} from '../shared/llm'
import type {TimetableAPI} from '../shared/timetable'
import type {CalendarAPI} from '../shared/calendar'
import type {TodosAPI} from '../shared/todos'
import type {GeneralSettingsAPI} from '../shared/general-settings'
import type {NotificationSettingsAPI} from '../shared/notification-settings'
import type {AppInfoAPI} from '../shared/app-info'
import type {MemoryAPI} from '../shared/memory'
import type {ChatAPI, ChatPushState} from '../shared/chat'
import type {CampusCardAPI} from '../shared/campus-card'
import type {LibraryAPI} from '../shared/library'
import type {DantaAPI} from '../shared/danta'

const danta: DantaAPI = {
    status: () => ipcRenderer.invoke('danta:state'),
    connectSchool: () => ipcRenderer.invoke('danta:connect-school'),
    checkSchool: () => ipcRenderer.invoke('danta:check-school'),
    login: input => ipcRenderer.invoke('danta:login', input),
    logout: () => ipcRenderer.invoke('danta:logout'),
    setAgentEnabled: enabled => ipcRenderer.invoke('danta:set-agent-enabled', enabled),
    searchPosts: input => ipcRenderer.invoke('danta:search-posts', input),
    readThread: input => ipcRenderer.invoke('danta:read-thread', input),
    searchCourses: input => ipcRenderer.invoke('danta:search-courses', input),
    getCourseGroup: id => ipcRenderer.invoke('danta:course-group', {id}),
    getCourseReviews: courseId => ipcRenderer.invoke('danta:course-reviews', {courseId}),
    summarizeThread: holeId => ipcRenderer.invoke('danta:summarize-thread', {holeId}),
    summarizeCourse: courseId => ipcRenderer.invoke('danta:summarize-course', {courseId}),
    getPlan: () => ipcRenderer.invoke('danta:plan-get'),
    savePlan: items => ipcRenderer.invoke('danta:plan-save', {items}),
}
contextBridge.exposeInMainWorld('danta', danta)

const library: LibraryAPI = {
    crowding: refresh => ipcRenderer.invoke('library:crowding', refresh),
}
contextBridge.exposeInMainWorld('library', library)

const campusCard: CampusCardAPI = {
    balance: refresh => ipcRenderer.invoke('campus-card:balance', refresh),
    openRecords: () => ipcRenderer.invoke('campus-card:open-records'),
}
contextBridge.exposeInMainWorld('campusCard', campusCard)

const memory: MemoryAPI = {
    get: () => ipcRenderer.invoke('memory:get'),
    save: input => ipcRenderer.invoke('memory:save', input),
    remove: id => ipcRenderer.invoke('memory:remove', id),
    setEnabled: enabled => ipcRenderer.invoke('memory:set-enabled', enabled),
    importJson: (json, username) => ipcRenderer.invoke('memory:import', {json, username}),
    exportJson: () => ipcRenderer.invoke('memory:export'),
    consolidatePreview: input => ipcRenderer.invoke('memory:consolidate-preview', input),
    consolidateApply: input => ipcRenderer.invoke('memory:consolidate-apply', input),
    consolidateUndo: consolidationId => ipcRenderer.invoke('memory:consolidate-undo', consolidationId),
    consolidateDiscard: previewId => ipcRenderer.invoke('memory:consolidate-discard', previewId),
    consolidateCancel: () => ipcRenderer.invoke('memory:consolidate-cancel'),
}
contextBridge.exposeInMainWorld('memory', memory)

const chat: ChatAPI = {
    get: () => ipcRenderer.invoke('chat:get'),
    trace: turnId => ipcRenderer.invoke('chat:trace', turnId),
    traceEvent: (turnId, eventId) => ipcRenderer.invoke('chat:trace-event', {turnId, eventId}),
    sessionTrace: () => ipcRenderer.invoke('chat:session-trace'),
    usage: () => ipcRenderer.invoke('chat:usage'),
    undo: (turnId, requestId) => ipcRenderer.invoke('chat:undo', {turnId, requestId}),
    send: text => ipcRenderer.invoke('chat:send', text),
    retry: (turnId, text) => ipcRenderer.invoke('chat:retry', {turnId, text}),
    cancel: () => ipcRenderer.invoke('chat:cancel'),
    clear: () => ipcRenderer.invoke('chat:clear'),
    decideSummary: (turnId, requestId, allow) => ipcRenderer.invoke('chat:decide-summary', {turnId, requestId, allow}),
    decideAction: (turnId, requestId, allow) => ipcRenderer.invoke('chat:decide-action', {turnId, requestId, allow}),
    onChanged: callback => {
        const listener = (_event: IpcRendererEvent, state: ChatPushState) => callback(state)
        ipcRenderer.on('chat:changed', listener)
        return () => ipcRenderer.removeListener('chat:changed', listener)
    },
}
contextBridge.exposeInMainWorld('chat', chat)

const appInfo: AppInfoAPI = {
    get: () => ipcRenderer.invoke('app:info'),
    openRepository: () => ipcRenderer.invoke('app:open-repository'),
}
contextBridge.exposeInMainWorld('appInfo', appInfo)

const notificationSettings: NotificationSettingsAPI = {
    get: () => ipcRenderer.invoke('settings:get-notifications'),
    setReminderMode: mode => ipcRenderer.invoke('settings:set-notice-reminder-mode', mode),
    setRefreshInterval: interval => ipcRenderer.invoke('settings:set-notice-refresh-interval', interval),
    setAutoSummary: enabled => ipcRenderer.invoke('settings:set-notice-auto-summary', enabled),
    setCalendarDefaultReminder: minutes => ipcRenderer.invoke('settings:set-calendar-default-reminder', minutes),
    setTodoDefaultReminder: minutes => ipcRenderer.invoke('settings:set-todo-default-reminder', minutes),
}
contextBridge.exposeInMainWorld('notificationSettings', notificationSettings)

const generalSettings: GeneralSettingsAPI = {
    get: () => ipcRenderer.invoke('settings:get-general'),
    setLaunchAtLogin: enabled => ipcRenderer.invoke('settings:set-launch-at-login', enabled),
    setCloseAction: action => ipcRenderer.invoke('settings:set-close-action', action),
}
contextBridge.exposeInMainWorld('generalSettings', generalSettings)

const todos: TodosAPI = {
    syncElearning: interactive => ipcRenderer.invoke('todos:sync-elearning', interactive),
    openElearning: id => ipcRenderer.invoke('todos:open-elearning', id),
    list: () => ipcRenderer.invoke('todos:list'),
    save: input => ipcRenderer.invoke('todos:save', input),
    remove: id => ipcRenderer.invoke('todos:remove', id),
}
contextBridge.exposeInMainWorld('todos', todos)

const calendar: CalendarAPI = {
    list: () => ipcRenderer.invoke('calendar:list'),
    save: input => ipcRenderer.invoke('calendar:save', input),
    remove: id => ipcRenderer.invoke('calendar:remove', id),
    syncExams: () => ipcRenderer.invoke('calendar:sync-exams'),
}
contextBridge.exposeInMainWorld('calendar', calendar)

const timetable: TimetableAPI = {
    cached: () => ipcRenderer.invoke('timetable:cached'),
    get: options => ipcRenderer.invoke('timetable:get', options),
    setStartDate: date => ipcRenderer.invoke('timetable:set-start-date', date),
    openSyllabus: courseId => ipcRenderer.invoke('timetable:open-syllabus', courseId),
    openReplay: courseId => ipcRenderer.invoke('timetable:open-replay', courseId),
}
contextBridge.exposeInMainWorld('timetable', timetable)

const llm: LlmAPI = {
    get: () => ipcRenderer.invoke('llm:get'),
    setEnabled: enabled => ipcRenderer.invoke('llm:set-enabled', enabled),
    save: input => ipcRenderer.invoke('llm:save', input),
    test: input => ipcRenderer.invoke('llm:test', input),
    models: input => ipcRenderer.invoke('llm:models', input),
}
contextBridge.exposeInMainWorld('llm', llm)

const sources: SourcesAPI = {
    list: () => ipcRenderer.invoke('sources:list'),
    setEnabled: (id, enabled) => ipcRenderer.invoke('sources:set-enabled', {id, enabled}),
    reorder: ids => ipcRenderer.invoke('sources:reorder', ids),
}
contextBridge.exposeInMainWorld('sources', sources)

const messagePreferences: MessagePreferencesAPI = {
    get: () => ipcRenderer.invoke('preferences:get-messages'),
    save: input => ipcRenderer.invoke('preferences:set-messages', input),
}
contextBridge.exposeInMainWorld('messagePreferences', messagePreferences)

const notices: NoticesAPI = {
    unreadState: () => ipcRenderer.invoke('notices:unread-state'),
    onUnreadChanged: callback => {
        const listener = (_event: IpcRendererEvent, state: {
            username: string | null;
            unread: boolean
        }) => callback(state)
        ipcRenderer.on('notices:unread-changed', listener)
        return () => ipcRenderer.removeListener('notices:unread-changed', listener)
    },
    onChanged: callback => {
        const listener = () => callback()
        ipcRenderer.on('notices:changed', listener)
        return () => ipcRenderer.removeListener('notices:changed', listener)
    },
    summaryQueue: () => ipcRenderer.invoke('notices:summary-queue'),
    enqueueSummaries: notices => ipcRenderer.invoke('notices:enqueue-summaries', notices),
    cancelSummaries: ids => ipcRenderer.invoke('notices:cancel-summaries', ids),
    clearSummaryQueue: () => ipcRenderer.invoke('notices:clear-summary-queue'),
    removeSummaries: ids => ipcRenderer.invoke('notices:remove-summaries', ids),
    getNotice: notice => ipcRenderer.invoke('notices:get', notice),
    markRead: notice => ipcRenderer.invoke('notices:mark-read', notice),
    markManyRead: notices => ipcRenderer.invoke('notices:mark-many-read', notices),
    setRelevance: (notice, relevance) => ipcRenderer.invoke('notices:set-relevance', {...notice, relevance}),
    onSummaryQueueChanged: callback => {
        const listener = (_event: IpcRendererEvent, tasks: SummaryTask[]) => callback(tasks)
        ipcRenderer.on('notices:summary-queue-changed', listener)
        return () => ipcRenderer.removeListener('notices:summary-queue-changed', listener)
    },
    list: refresh => ipcRenderer.invoke('notices:list', refresh),
    detail: notice => ipcRenderer.invoke('notices:detail', notice),
    summarize: (notice, force = false) => ipcRenderer.invoke('notices:summary', {...notice, force}),
    image: notice => ipcRenderer.invoke('notices:image', notice),
    openSource: notice => ipcRenderer.invoke('notices:open-source', notice),
    openAttachment: notice => ipcRenderer.invoke('notices:open-attachment', notice),
}
contextBridge.exposeInMainWorld('notices', notices)

const accounts: AccountAPI = {
    getState: () => ipcRenderer.invoke('account:state'),
    login: input => ipcRenderer.invoke('account:login', input),
    verify: () => ipcRenderer.invoke('account:verify'),
    logout: () => ipcRenderer.invoke('account:logout'),
    getTheme: () => ipcRenderer.invoke('preferences:get-theme'),
    setTheme: theme => ipcRenderer.invoke('preferences:set-theme', theme),
}
contextBridge.exposeInMainWorld('accounts', accounts)

contextBridge.exposeInMainWorld('windowControls', {
    minimize: () => ipcRenderer.send('window:minimize'),
    toggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
    close: () => ipcRenderer.send('window:close'),
    isMaximized: (): Promise<boolean> => ipcRenderer.invoke('window:is-maximized'),
    onMaximizedChanged: (callback: (maximized: boolean) => void) => {
        const listener = (_event: IpcRendererEvent, maximized: boolean) => callback(maximized)
        ipcRenderer.on('window:maximized-changed', listener)
        return () => ipcRenderer.removeListener('window:maximized-changed', listener)
    },
})
