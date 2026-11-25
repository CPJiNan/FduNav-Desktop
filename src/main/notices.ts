import {app, ipcMain, type IpcMainInvokeEvent, Notification, shell, type WebContents} from 'electron'
import {AppDatabase} from './database'
import {AccountService} from './accounts'
import {AuthError} from './fudan-auth'
import {parseNoticeDetail} from './notice-parser'
import {isSourceId, sourceUrl} from '../shared/sources'
import {SourceRefreshService} from './source-service'
import {readNoticePdfs} from './notice-pdf'
import {noticeImageUrls} from './notice-body'
import {NoticeSummaryService} from './notice-summary'
import type {LlmSettingsService} from './llm-settings'
import type {NoticeRef} from '../shared/notices'
import type {Result} from '../shared/accounts'
import {isNoticeRefreshInterval, isNoticeReminderMode, shouldRemindNotice} from '../shared/notification-settings'
import {isCalendarReminderMinutes} from '../shared/calendar-reminders'
import {validateRequiredMessagePreferences} from '../shared/message-preferences'

export function registerNoticeHandlers(db: AppDatabase, accounts: AccountService, llm: LlmSettingsService,
                                       trusted: (event: IpcMainInvokeEvent) => boolean, onReminderClick: () => void) {
    const refresh = new SourceRefreshService(db)
    const listSubscribers = new Set<WebContents>()
    const unreadSubscribers = new Set<WebContents>()

    function unreadState() {
        const username = db.getAccount()?.username ?? null
        return {username, unread: username !== null && db.hasUnreadNotices(username)}
    }

    function publishUnreadState() {
        const state = unreadState()
        for (const sender of unreadSubscribers) {
            if (sender.isDestroyed()) unreadSubscribers.delete(sender)
            else sender.send('notices:unread-changed', state)
        }
    }

    let refreshTimer: ReturnType<typeof setInterval> | undefined
    let autoRefreshing = false
    const detailImages = new Map<string, Set<string>>()
    const detailKey = (notice: NoticeRef) => JSON.stringify([notice.sourceId, notice.url])
    let refreshing: Promise<void> | null = null
    let autoSummaryGeneration = 0
    const pendingAutoSummaries = new Map<string, { notice: NoticeRef; username: string }>()
    const pendingReminders = new Map<string, { notice: NoticeRef; username: string; receivedAt: number }>()
    const activeReminders = new Set<Notification>()

    function notificationSettings() {
        return {
            calendarDefaultReminder: db.getCalendarDefaultReminder(),
            todoDefaultReminder: db.getTodoDefaultReminder(),
            reminderMode: db.getNoticeReminderMode(),
            refreshInterval: db.getNoticeRefreshInterval(),
            autoSummary: db.getNoticeAutoSummary(),
        }
    }

    function remindNotice(key: string, classified = false) {
        const pending = pendingReminders.get(key)
        if (!pending) return
        const mode = db.getNoticeReminderMode()
        const notice = db.getNotice(pending.notice.sourceId, pending.notice.url, pending.username)
        if (mode === 'off' || db.getAccount()?.username !== pending.username || !notice || notice.read ||
            !db.getSource(notice.sourceId)?.enabled || Date.now() - pending.receivedAt > 24 * 60 * 60_000) {
            pendingReminders.delete(key)
            return
        }
        if (!shouldRemindNotice(mode, summaries.relevanceFor(notice))) {
            if (classified) pendingReminders.delete(key)
            return
        }
        pendingReminders.delete(key)
        if (!Notification.isSupported()) return
        try {
            const reminder = new Notification({title: notice.sourceName, body: notice.title})
            activeReminders.add(reminder)
            reminder.once('click', () => {
                activeReminders.delete(reminder)
                if (db.getAccount()?.username === pending.username) onReminderClick()
            })
            reminder.once('close', () => activeReminders.delete(reminder))
            reminder.once('failed', (_event, error) => {
                activeReminders.delete(reminder)
                console.warn('新通知提醒未能显示。', error)
            })
            reminder.show()
        } catch (error) {
            console.warn('无法显示新通知提醒。', error)
        }
    }

    function drainAutoSummaries() {
        if (!pendingAutoSummaries.size) return
        const username = db.getAccount()?.username
        const settings = llm.get()
        if (!db.getNoticeAutoSummary() || !username || !settings.enabled || !settings.model) {
            pendingAutoSummaries.clear()
            return
        }
        for (const [key, pending] of pendingAutoSummaries) {
            if (summaries.queue.activeCount >= 200) break
            pendingAutoSummaries.delete(key)
            if (pending.username !== username) continue
            try {
                requireReady()
                if (!summaries.needsSummary(pending.notice)) continue
                void summaries.summarize(pending.notice).catch(() => {
                })
            } catch (error) {
                console.warn('无法加入自动摘要队列。', error)
            }
        }
    }

    function refreshNotices(source?: ReturnType<AppDatabase['getSource']>): Promise<void> {
        if (source && refreshing) return refreshing.then(() => {
            const current = db.getSource(source.id)
            if (current?.enabled && current.revision === source.revision) return refreshNotices(current)
        })
        if (!refreshing) {
            const known = new Set(db.getNotices().items.map(detailKey))
            const username = db.getAccount()?.username
            const autoSummary = db.getNoticeAutoSummary()
            const generation = autoSummaryGeneration
            const request = source ? refresh.refreshSource(source).then(() => db.getNotices()) : refresh.refresh()
            refreshing = request.then(list => {
                if (!username || db.getAccount()?.username !== username) return
                for (const [key, pending] of pendingReminders) {
                    if (pending.username !== username || Date.now() - pending.receivedAt > 24 * 60 * 60_000) pendingReminders.delete(key)
                }
                for (const notice of list.items) {
                    const key = detailKey(notice)
                    if (known.has(key)) continue
                    if (db.getNoticeReminderMode() !== 'off') {
                        pendingReminders.set(key, {notice, username, receivedAt: Date.now()})
                        remindNotice(key)
                    }
                    if (autoSummary && generation === autoSummaryGeneration && db.getNoticeAutoSummary()) {
                        pendingAutoSummaries.set(key, {notice, username})
                    }
                }
                drainAutoSummaries()
            }).finally(() => {
                refreshing = null
                publishUnreadState()
            })
        }
        return refreshing
    }

    function requireReady() {
        if (!db.getAccount()) throw new AuthError('请先登录。')
        if (!validateRequiredMessagePreferences(db.getMessagePreferences()).ok) throw new AuthError('请先完善消息偏好。')
    }

    function handle<T>(name: string, action: (input: any, event: IpcMainInvokeEvent) => Promise<T>, ready = true) {
        ipcMain.handle(name, async (event, input): Promise<Result<T>> => {
            if (!trusted(event)) return {ok: false, error: '请求来源无效。'}
            try {
                if (ready) requireReady()
                return {ok: true, data: await action(input, event)}
            } catch (error) {
                return {ok: false, error: error instanceof AuthError ? error.message : '通知加载失败，请稍后重试。'}
            }
        })
    }

    async function autoRefresh() {
        if (autoRefreshing) return
        try {
            requireReady()
        } catch {
            return
        }
        autoRefreshing = true
        try {
            await refreshNotices()
            for (const sender of listSubscribers) {
                if (sender.isDestroyed()) listSubscribers.delete(sender)
                else sender.send('notices:changed')
            }
        } catch (error) {
            console.warn('自动刷新通知失败。', error)
        } finally {
            autoRefreshing = false
        }
    }

    function scheduleRefresh() {
        clearInterval(refreshTimer)
        refreshTimer = undefined
        const interval = db.getNoticeRefreshInterval()
        if (interval) {
            refreshTimer = setInterval(() => void autoRefresh(), interval * 60_000)
            refreshTimer.unref()
        }
    }

    handle('settings:get-notifications', async () => notificationSettings(), false)
    handle('notices:unread-state', async (_input, event) => {
        unreadSubscribers.add(event.sender)
        return unreadState()
    }, false)
    handle('settings:set-todo-default-reminder', async (input: unknown) => {
        if (!isCalendarReminderMinutes(input)) throw new AuthError('默认提醒时间无效。')
        db.setTodoDefaultReminder(input)
        return notificationSettings()
    }, false)
    handle('settings:set-calendar-default-reminder', async (input: unknown) => {
        if (!isCalendarReminderMinutes(input)) throw new AuthError('默认提醒时间无效。')
        db.setCalendarDefaultReminder(input)
        return notificationSettings()
    }, false)
    handle('settings:set-notice-reminder-mode', async (input: unknown) => {
        if (!isNoticeReminderMode(input)) throw new AuthError('新通知提醒设置无效。')
        db.setNoticeReminderMode(input)
        if (input === 'off') {
            pendingReminders.clear()
            for (const reminder of activeReminders) reminder.close()
            activeReminders.clear()
        }
        return notificationSettings()
    }, false)
    handle('settings:set-notice-refresh-interval', async (input: unknown) => {
        if (!isNoticeRefreshInterval(input)) throw new AuthError('自动刷新间隔无效。')
        db.setNoticeRefreshInterval(input)
        scheduleRefresh()
        return notificationSettings()
    }, false)
    handle('settings:set-notice-auto-summary', async (input: unknown) => {
        if (typeof input !== 'boolean') throw new AuthError('自动 AI 摘要设置无效。')
        if (input) {
            requireReady()
            const settings = llm.get()
            if (!settings.enabled || !settings.model || !settings.baseUrl) throw new AuthError('请先在 LLM 设置中配置模型并启用 LLM。')
        }
        db.setNoticeAutoSummary(input)
        autoSummaryGeneration++
        if (!input) pendingAutoSummaries.clear()
        return notificationSettings()
    }, false)
    scheduleRefresh()
    app.once('before-quit', () => {
        clearInterval(refreshTimer)
        pendingReminders.clear()
        for (const reminder of activeReminders) reminder.close()
        activeReminders.clear()
    })

    function knownUrl(input: unknown) {
        if (!input || typeof input !== 'object') throw new AuthError('通知参数无效。')
        const value = input as Record<string, unknown>
        if (typeof value.url !== 'string' || typeof value.sourceId !== 'string' || !db.hasNotice(value.url, value.sourceId)) {
            throw new AuthError('未找到这条通知，请刷新列表。')
        }
        return sourceUrl(value.url)
    }

    const summaries = new NoticeSummaryService(db, llm, async ref => readNoticePdfs(await readDetail(ref)))
    const subscribers = new Set<WebContents>()
    const queueSnapshot = () => summaries.queue.snapshot(db.getAccount()?.username ?? '')
    summaries.queue.subscribe(() => {
        const tasks = queueSnapshot()
        for (const sender of subscribers) {
            if (sender.isDestroyed()) subscribers.delete(sender)
            else sender.send('notices:summary-queue-changed', tasks)
        }
        for (const task of tasks) {
            if (task.status === 'completed') remindNotice(detailKey(task), true)
        }
        queueMicrotask(drainAutoSummaries)
    })
    ipcMain.handle('notices:summary-queue', event => {
        if (!trusted(event)) return {ok: false, error: '请求来源无效。'}
        subscribers.add(event.sender)
        return {ok: true, data: queueSnapshot()}
    })
    handle('notices:enqueue-summaries', async (input: unknown) => {
        if (!Array.isArray(input) || !input.length || input.length > 200) throw new AuthError('请选择 1–200 条通知。')
        input.forEach(knownUrl)
        const unique = new Map(input.map((ref: NoticeRef) => [detailKey(ref), ref]))
        const notices = [...unique.values()].filter(ref => summaries.needsSummary(ref))
        if (!notices.length) return
        const settings = llm.get()
        if (!settings.enabled || !settings.model) throw new AuthError('请先配置并启用 LLM。')
        if (summaries.queue.activeCount + notices.length > 200) throw new AuthError('队列最多容纳 200 条待完成任务，请减少选择或等待任务完成。')
        for (const ref of notices) void summaries.summarize(ref).catch(() => {
        })
    })
    handle('notices:cancel-summaries', async (input: unknown) => {
        if (!Array.isArray(input) || input.length > 400 || !input.every(id => typeof id === 'string')) {
            throw new AuthError('摘要任务参数无效。')
        }
        summaries.queue.cancel(input, db.getAccount()?.username ?? '')
    }, false)
    handle('notices:clear-summary-queue', async () => summaries.queue.clear(db.getAccount()?.username ?? ''), false)
    handle('notices:remove-summaries', async (input: unknown) => {
        if (!Array.isArray(input) || input.length > 400 || !input.every(id => typeof id === 'string')) {
            throw new AuthError('摘要任务参数无效。')
        }
        summaries.queue.remove(input, db.getAccount()?.username ?? '')
    }, false)
    handle('notices:get', async (input: unknown) => {
        knownUrl(input)
        const ref = input as NoticeRef
        const notice = db.getNotice(ref.sourceId, ref.url)!
        return {...notice, relevance: summaries.relevanceFor(notice)}
    })

    function setRelevance(input: unknown) {
        requireReady()
        knownUrl(input)
        const value = input as NoticeRef & { relevance?: unknown }
        if (value.relevance !== 'related' && value.relevance !== 'maybe' && value.relevance !== 'none') {
            throw new AuthError('相关性选项无效。')
        }
        db.setNoticeRelevanceChoice(db.getAccount()!.username, value.sourceId, value.url, value.relevance)
        remindNotice(detailKey(value), true)
        for (const sender of listSubscribers) {
            if (sender.isDestroyed()) listSubscribers.delete(sender)
            else sender.send('notices:changed')
        }
        return value.relevance === 'none' ? null : value.relevance
    }

    handle('notices:set-relevance', async input => setRelevance(input))

    handle('notices:mark-read', async (input: unknown) => {
        knownUrl(input)
        const ref = input as NoticeRef
        db.markNoticeRead(db.getAccount()!.username, ref.sourceId, ref.url)
        publishUnreadState()
    })

    handle('notices:mark-many-read', async (input: unknown) => {
        if (!Array.isArray(input) || !input.length) throw new AuthError('请选择需要标记已读的通知。')
        input.forEach(knownUrl)
        try {
            db.markNoticesRead(db.getAccount()!.username, input as NoticeRef[])
        } catch {
            throw new AuthError('已读状态保存失败，请重试。')
        }
        publishUnreadState()
    })

    handle('notices:list', async (force: unknown, event) => {
        listSubscribers.add(event.sender)
        if (force === true) await refreshNotices()
        return listNotices()
    })

    function listNotices() {
        const profile = summaries.profile()
        return db.getNotices(profile.username, profile.key)
    }

    async function readDetail(input: unknown) {
        const url = knownUrl(input)
        const source = db.getSource((input as NoticeRef).sourceId)!
        const isJwc = new URL(url).hostname === 'jwc.fudan.edu.cn'
        let html = isJwc ? await accounts.readNotice(url) : await accounts.readPage(url)
        if (html === null && !isJwc) html = await accounts.readPageWithBrowser(url)
        if (html === null) return {content: '', body: [], imageCount: 0, requiresLogin: true, attachments: []}
        const detail = parseNoticeDetail(html, url, source.id)
        if (!detail) throw new AuthError('无法读取通知正文，请查看学校原文。')
        const key = detailKey(input as NoticeRef)
        detailImages.delete(key)
        detailImages.set(key, new Set(noticeImageUrls(detail.body)))
        if (detailImages.size > 64) detailImages.delete(detailImages.keys().next().value!)
        return detail
    }

    handle('notices:detail', async (input: unknown) => {
        return summaries.detail(input as NoticeRef)
    })

    async function summarize(input: unknown) {
        requireReady()
        knownUrl(input)
        try {
            const summary = await summaries.summarize(input as NoticeRef, (input as { force?: unknown }).force === true)
            for (const sender of listSubscribers) {
                if (sender.isDestroyed()) listSubscribers.delete(sender)
                else sender.send('notices:changed')
            }
            return summary
        } catch (error) {
            if (error instanceof AuthError) throw error
            throw new AuthError(error instanceof Error ? error.message : '摘要生成失败，请稍后重试。')
        }
    }

    handle('notices:summary', summarize)
    handle('notices:image', async (input: unknown) => {
        const referer = knownUrl(input)
        const imageUrl = (input as Record<string, unknown>).imageUrl
        if (typeof imageUrl !== 'string' || !detailImages.get(detailKey(input as NoticeRef))?.has(imageUrl)) {
            throw new AuthError('未找到这张通知图片，请重新打开通知。')
        }
        try {
            const image = await accounts.readImage(imageUrl, referer)
            requireReady()
            return image
        } catch {
            throw new AuthError('图片加载失败，请重试。')
        }
    })
    handle('notices:open-source', async (input: unknown) => {
        await shell.openExternal(knownUrl(input))
    })
    handle('notices:open-attachment', async (input: unknown) => {
        const detail = await readDetail(input)
        const url = (input as Record<string, unknown>).urlToOpen
        if (typeof url !== 'string' || !detail.attachments.some(attachment => attachment.url === url)) {
            throw new AuthError('未找到这份通知附件。')
        }
        await shell.openExternal(sourceUrl(url))
    })

    handle('sources:list', async () => {
        if (!db.getAccount()) throw new AuthError('请先登录。')
        return db.getSources()
    }, false)
    handle('sources:reorder', async (input: unknown) => {
        if (!db.getAccount()) throw new AuthError('请先登录。')
        if (!Array.isArray(input) || input.length !== db.getSources().length ||
            new Set(input).size !== input.length || !input.every(isSourceId)) {
            throw new AuthError('消息来源排序无效。')
        }
        return db.reorderSources(input)
    }, false)
    handle('sources:set-enabled', async (input: unknown) => {
        if (!db.getAccount()) throw new AuthError('请先登录。')
        const value = input as Record<string, unknown> | null
        if (!value || !isSourceId(value.id) || typeof value.enabled !== 'boolean') {
            throw new AuthError('来源设置无效。')
        }
        const previous = db.getSource(value.id)
        const sources = db.setSourceEnabled(value.id, value.enabled)
        const source = sources.find(item => item.id === value.id)
        if (source?.enabled && source.revision !== previous?.revision) {
            void refreshNotices(source).then(() => {
                for (const sender of listSubscribers) if (!sender.isDestroyed()) sender.send('notices:changed')
            }).catch(() => {
            })
        }
        publishUnreadState()
        return sources
    }, false)
    return {
        list: listNotices, detail: async (ref: NoticeRef) => {
            requireReady()
            return summaries.detail(ref)
        }, setRelevance, summarize
    }
}
