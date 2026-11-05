import {randomUUID} from 'node:crypto'
import {BrowserWindow, session} from 'electron'
import type {CookieJar} from 'tough-cookie'
import type {TimetableCourse} from '../shared/timetable'
import {browserCookieJar, browserCookies} from './auth-cookies'
import {AuthError, isAuthUrl, validateUrl} from './fudan-auth'
import {
    courseReplayLoginUrl,
    isReplayLoginPage,
    matchReplayCourse,
    parseReplaySchedule,
    type ReplayCourse,
    replayToken,
    replayUser,
    replayWeeks
} from './course-replay-data'

const origin = 'https://icourse.fudan.edu.cn'
const entry = courseReplayLoginUrl()

export async function resolveCourseReplay(course: TimetableCourse, startDate: string | null,
                                          username: string, jar: CookieJar, parent?: BrowserWindow) {
    let weeks: ReturnType<typeof replayWeeks>
    try {
        weeks = replayWeeks(startDate, course.weeks)
    } catch (error) {
        throw new AuthError(error instanceof Error ? error.message : '课表教学周无效，请刷新课表。')
    }
    if (!course.teachers.some(name => name.trim())) throw new AuthError('课表中缺少任课教师信息，请刷新课表后重试。')
    const reader = session.fromPartition(`fdunav-replay-${randomUUID()}`, {cache: false})
    reader.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    reader.setPermissionCheckHandler(() => false)
    reader.on('will-download', event => event.preventDefault())
    const controller = new AbortController()
    const cancel = () => controller.abort(new AuthError('已取消课程回放。'))
    const timeout = setTimeout(() => controller.abort(new AuthError('课程回放登录或查询超时，请重试。')), 300_000)
    parent?.once('closed', cancel)
    let window: BrowserWindow | undefined
    const getJson = async (path: string, token: string) => {
        const response = await reader.fetch(`${origin}${path}`, {
            credentials: 'include', redirect: 'error',
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]),
            headers: {Authorization: `Bearer ${token}`, Accept: 'application/json'},
        })
        if (!response.ok) throw new AuthError('无法读取 iCourse 本人课程，请检查登录状态后重试。')
        return response.json() as Promise<unknown>
    }
    try {
        for (const cookie of browserCookies(jar)) await reader.cookies.set(cookie)
        if (parent?.isDestroyed()) cancel()
        controller.signal.throwIfAborted()
        const loginWindow = new BrowserWindow({
            show: false, width: 1100, height: 820, title: '课程回放身份验证', autoHideMenuBar: true,
            ...(parent ? {parent, modal: true} : {}),
            webPreferences: {
                session: reader,
                sandbox: true,
                contextIsolation: true,
                nodeIntegration: false,
                webviewTag: false
            },
        })
        window = loginWindow
        loginWindow.setMenu(null)
        loginWindow.once('closed', cancel)
        loginWindow.webContents.setWindowOpenHandler(() => ({action: 'deny'}))
        const guard = (event: Electron.Event, url: string) => {
            try {
                validateUrl(url)
            } catch {
                event.preventDefault()
                controller.abort(new AuthError('学校登录跳转到了不受支持的地址。'))
            }
        }
        loginWindow.webContents.on('will-frame-navigate', event => {
            if (event.isMainFrame) guard(event, event.url)
        })
        loginWindow.webContents.on('will-redirect', (event, url, _inPlace, mainFrame) => {
            if (mainFrame) guard(event, url)
        })
        loginWindow.webContents.on('render-process-gone', () => controller.abort(new AuthError('学校认证窗口异常退出，请重试。')))
        const identity = await new Promise<{ token: string; userId: string }>((resolve, reject) => {
            let settled = false
            let checking = false
            let ready = false
            let authSince = 0
            let serviceSince = 0
            const finish = (error?: unknown, result?: { token: string; userId: string }) => {
                if (settled) return
                settled = true
                clearInterval(poll)
                controller.signal.removeEventListener('abort', aborted)
                if (error) reject(error)
                else resolve(result!)
            }
            const aborted = () => finish(controller.signal.reason)
            const check = async () => {
                if (settled || checking || !ready || loginWindow.isDestroyed()) return
                const current = loginWindow.webContents.getURL()
                if (isAuthUrl(current) || isReplayLoginPage(current)) {
                    serviceSince = 0
                    authSince ||= Date.now()
                    if (Date.now() - authSince > 1500 && !loginWindow.isVisible()) {
                        loginWindow.show()
                        loginWindow.focus()
                    }
                    return
                }
                authSince = 0
                if (!current.startsWith(`${origin}/`) || loginWindow.webContents.isLoading()) return
                serviceSince ||= Date.now()
                checking = true
                try {
                    const cookies = await reader.cookies.get({url: origin, name: '_token'})
                    const token = cookies.map(cookie => replayToken(cookie.value)).find(Boolean)
                    if (!token) {
                        if (Date.now() - serviceSince > 15_000) finish(new AuthError('未能完成 iCourse 登录，请重新登录学校账号后重试。'))
                        return
                    }
                    const userId = replayUser(await getJson('/userapi/v1/infosimple', token), username)
                    if (!userId) {
                        finish(new AuthError('iCourse 登录账号与应用账号不一致，请使用同一学校账号登录。'))
                        return
                    }
                    loginWindow.hide()
                    finish(undefined, {token, userId})
                } catch {
                    if (Date.now() - serviceSince > 15_000) finish(new AuthError('iCourse 登录验证失败，请检查网络并重新登录。'))
                } finally {
                    checking = false
                }
            }
            const poll = setInterval(() => void check(), 750)
            controller.signal.addEventListener('abort', aborted, {once: true})
            loginWindow.webContents.on('dom-ready', () => {
                ready = true;
                void check()
            })
            loginWindow.webContents.on('did-fail-load', (_event, code, _description, _url, mainFrame) => {
                if (mainFrame && code !== -3) finish(new AuthError('无法加载学校课程回放平台，请检查网络。'))
            })
            void loginWindow.loadURL(entry).catch(error => {
                if (error?.code !== 'ERR_ABORTED') finish(new AuthError('无法打开学校课程回放登录页面。'))
            })
        })
        const candidates: ReplayCourse[] = []
        for (const week of weeks) {
            controller.signal.throwIfAborted()
            const params = new URLSearchParams({
                user_id: identity.userId, tenant_id: '222',
                start_at: week.start, end_at: week.end, token: identity.token
            })
            candidates.push(...parseReplaySchedule(await getJson(`/courseapi/v2/schedule/get-week-schedules?${params}`, identity.token)))
        }
        const id = matchReplayCourse(candidates, course)
        if (!id) throw new AuthError('未在本学期的 iCourse 本人课表中找到唯一匹配的课程与任课教师，请确认课程已开通回放。')
        return {courseId: id, jar: await browserCookieJar(await reader.cookies.get({}))}
    } catch (error) {
        if (controller.signal.aborted) throw controller.signal.reason
        if (error instanceof AuthError) throw error
        throw new AuthError(error instanceof Error && error.message.startsWith('iCourse') ? error.message : '无法匹配课程回放，请检查网络并刷新课表后重试。')
    } finally {
        clearTimeout(timeout)
        parent?.removeListener('closed', cancel)
        if (window && !window.isDestroyed()) {
            window.removeListener('closed', cancel);
            window.destroy()
        }
        controller.abort()
        await reader.clearStorageData().catch(() => {
        })
        await reader.closeAllConnections().catch(() => {
        })
    }
}
