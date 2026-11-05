import {BrowserWindow, ipcMain, type IpcMainInvokeEvent, shell} from 'electron'
import type {AppDatabase} from './database'
import type {AccountService} from './accounts'
import {AuthError} from './fudan-auth.ts'
import type {Result} from '../shared/accounts'
import {courseSyllabusUrl, type Timetable, validDate} from '../shared/timetable.ts'
import {parsePostgraduateCourses, parseSemesters, parseUndergraduateCourses} from './timetable-parser.ts'

const timetableUrl = 'https://fdjwgl.fudan.edu.cn/student/for-std/course-table'
const postgraduateUrl = 'https://yjsxk.fudan.edu.cn/yjsxkapp/sys/xsxkappfudan/xsxkCourse/loadKbxx.do'

export function registerTimetableHandlers(db: AppDatabase, accounts: AccountService, trusted: (event: IpcMainInvokeEvent) => boolean) {
    let pending: {
        username: string;
        kind: Timetable['kind'];
        semesterId: unknown;
        promise: Promise<Result<Timetable>>
    } | null = null

    function context() {
        const account = accounts.getState()
        if (account.status !== 'signed-in' || !account.username) throw new AuthError('请先登录账号。')
        const preferences = db.getMessagePreferences()
        if (preferences.identity !== 'student') throw new AuthError('暂不支持教职员工课表。')
        if (!['undergraduate', 'master', 'doctoral'].includes(preferences.educationLevel)) throw new AuthError('请先设置学历阶段。')
        const kind: Timetable['kind'] = preferences.educationLevel === 'undergraduate' ? 'undergraduate' : 'postgraduate'
        return {username: account.username, kind}
    }

    ipcMain.handle('timetable:cached', (event): Result<Timetable | null> => {
        if (!trusted(event)) return {ok: false, error: '请求来源无效。'}
        try {
            const account = accounts.getState()
            if (account.status !== 'signed-in') throw new AuthError('请先登录账号。')
            if (db.getMessagePreferences().identity !== 'student') return {ok: true, data: null}
            const {username, kind} = context()
            return {ok: true, data: db.getTimetable(username, kind)}
        } catch (error) {
            return {ok: false, error: error instanceof AuthError ? error.message : '无法读取课表。'}
        }
    })

    ipcMain.handle('timetable:get', async (event, input: unknown): Promise<Result<Timetable>> => {
        if (!trusted(event)) return {ok: false, error: '请求来源无效。'}
        try {
            const options = input == null ? {} : input
            if (typeof options !== 'object' || Array.isArray(options)) throw new AuthError('课表请求无效。')
            const {refresh, semesterId} = options as Record<string, unknown>
            if (refresh !== undefined && typeof refresh !== 'boolean') throw new AuthError('课表请求无效。')
            if (semesterId !== undefined && (typeof semesterId !== 'string' || !/^\d{1,12}$/.test(semesterId))) throw new AuthError('学期无效。')
            const {username, kind} = context()
            if (pending) {
                if (pending.username === username && pending.kind === kind && (!semesterId || pending.semesterId === semesterId)) return pending.promise
                throw new AuthError('正在获取课表，请稍候。')
            }
            const cached = db.getTimetable(username, kind)
            if (!refresh && cached && (!semesterId || semesterId === cached.semesterId)) return {ok: true, data: cached}
            const parent = BrowserWindow.fromWebContents(event.sender) ?? undefined
            const promise = accounts.withServiceSession<Timetable>(async read => {
                if (kind === 'postgraduate') {
                    const courses = await read(`${postgraduateUrl}?_=${Date.now()}`, parsePostgraduateCourses)
                    return {
                        kind,
                        semesters: [],
                        semesterId: '',
                        startDate: cached?.startDate ?? null,
                        courses,
                        updatedAt: new Date().toISOString()
                    }
                }
                const {semesters, defaultId} = await read(timetableUrl, parseSemesters)
                const selected = semesters.find(item => item.id === (semesterId ?? cached?.semesterId ?? defaultId))
                    ?? semesters.find(item => item.id === defaultId)!
                const courses = await read(`${timetableUrl}/semester/${selected.id}/print-data`, parseUndergraduateCourses)
                return {
                    kind, semesters, semesterId: selected.id,
                    startDate: cached?.semesterId === selected.id ? cached.startDate ?? selected.startDate : selected.startDate,
                    courses, updatedAt: new Date().toISOString()
                }
            }, parent).then((data): Result<Timetable> => {
                const current = context()
                if (current.username !== username || current.kind !== kind) throw new AuthError('账号或消息偏好已变更，请重新获取课表。')
                db.saveTimetable(username, data)
                return {ok: true, data}
            }).catch((error): Result<Timetable> => ({
                ok: false,
                error: error instanceof AuthError ? error.message : '获取课表失败，请稍后重试。'
            }))
                .finally(() => {
                    pending = null
                })
            pending = {username, kind, semesterId, promise}
            return promise
        } catch (error) {
            return {ok: false, error: error instanceof AuthError ? error.message : '获取课表失败，请稍后重试。'}
        }
    })
    ipcMain.handle('timetable:open-syllabus', async (event, courseId: unknown): Promise<Result<void>> => {
        if (!trusted(event)) return {ok: false, error: '请求来源无效。'}
        try {
            if (typeof courseId !== 'string' || !courseId || courseId.length > 500) throw new AuthError('课程编号无效。')
            const {username, kind} = context()
            const course = db.getTimetable(username, kind)?.courses.find(item => item.id === courseId)
            if (!course) throw new AuthError('未找到这门课程，请刷新课表后重试。')
            const url = courseSyllabusUrl(course)
            if (!url) throw new AuthError('这门课程缺少教学班编号，暂时无法直接打开教学大纲。')
            await shell.openExternal(url)
            return {ok: true, data: undefined}
        } catch (error) {
            return {
                ok: false,
                error: error instanceof AuthError ? error.message : '无法打开教学大纲，请稍后重试。'
            }
        }
    })
    ipcMain.handle('timetable:open-replay', async (event, courseId: unknown): Promise<Result<void>> => {
        if (!trusted(event)) return {ok: false, error: '请求来源无效。'}
        try {
            if (typeof courseId !== 'string' || !courseId || courseId.length > 500) throw new AuthError('课程编号无效。')
            const {username, kind} = context()
            const timetable = db.getTimetable(username, kind)
            const course = timetable?.courses.find(item => item.id === courseId)
            if (!course) throw new AuthError('未找到这门课程，请刷新课表后重试。')
            await accounts.openCourseReplay(course, timetable?.startDate ?? null, BrowserWindow.fromWebContents(event.sender) ?? undefined)
            return {ok: true, data: undefined}
        } catch (error) {
            return {ok: false, error: error instanceof AuthError ? error.message : '无法打开课程回放，请检查网络后重试。'}
        }
    })
    ipcMain.handle('timetable:set-start-date', (event, value: unknown): Result<Timetable> => {
        if (!trusted(event)) return {ok: false, error: '请求来源无效。'}
        try {
            if (pending) throw new AuthError('请等待课表获取完成。')
            if (!validDate(value) || new Date(`${value}T00:00:00Z`).getUTCDay() !== 0) throw new AuthError('请选择第一周的星期日。')
            const {username, kind} = context()
            const data = db.getTimetable(username, kind)
            if (!data) throw new AuthError('请先获取课表。')
            data.startDate = value
            db.saveTimetable(username, data)
            return {ok: true, data}
        } catch (error) {
            return {ok: false, error: error instanceof AuthError ? error.message : '无法保存开学日期。'}
        }
    })
}
