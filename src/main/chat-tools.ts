import {ToolError} from '../shared/agent'
import {validateMemory, presentMemory} from '../shared/memory'
import {type ChatToolName, defaultToolDescriptions} from '../shared/llm-prompts'
import {
    calendarDate,
    type CalendarEvent,
    calendarOccurrences,
    timeLabel,
    validateCalendarEvent
} from '../shared/calendar'
import {type Todo, validateTodo} from '../shared/todos'
import type {ChatAction, ChatCard} from '../shared/chat'
import type {Notice} from '../shared/notices'
import type {AppDatabase} from './database'
import type {registerNoticeHandlers} from './notices'
import type {ChatTool} from './llm-connection'

type Fields = Record<string, unknown>
const str = (description: string) => ({type: 'string', description})
const ref = {sourceId: str('通知来源 ID，来自检索结果'), url: str('通知 URL，来自检索结果')}
const eventFields = {
    title: str('日程名称'), startDate: str('开始日期 YYYY-MM-DD'), endDate: str('结束日期 YYYY-MM-DD'),
    startTime: str('开始时间 HH:mm'), endTime: str('结束时间 HH:mm'), allDay: {type: 'boolean'},
    location: str('地点'), notes: str('备注'),
    reminderMinutes: {
        type: 'integer',
        enum: [-1, 0, 5, 10, 15, 30, 60, 120, 1440, 2880, 10080],
        description: '提前提醒分钟数，-1 不提醒；省略使用用户默认值'
    },
}
const pagination = {offset: {type: 'integer', minimum: 0}, limit: {type: 'integer', minimum: 1, maximum: 10}}

function tool(name: ChatToolName, properties: Fields, required: string[] = []): ChatTool {
    return {
        type: 'function',
        function: {
            name,
            description: defaultToolDescriptions[name],
            parameters: {type: 'object', properties, required, additionalProperties: false}
        }
    }
}

export const chatTools: ChatTool[] = [
    tool('recall', {query: str('记忆关键词，可留空'), ...pagination}),
    tool('remember', {kind: {type: 'string', enum: ['fact', 'preference', 'event']}, text: str('长期事实或偏好，最多 600 字'),
        evidence: str('用户明确陈述的原话与上下文，不得猜测'),
        confidence: {type: 'number', minimum: 0, maximum: 1, description: '0–1，省略按 0.6 处理'},
        pinned: {type: 'boolean', description: '省略按 false 处理'},
        expiresAt: {type: 'string', description: 'ISO 到期时间；空字符串表示永久'}},
        ['kind', 'text', 'evidence']),
    tool('forget', {id: str('记忆 ID，来自 recall；可使用短 id')}, ['id']),
    tool('search_notices', {
        query: str('标题或来源关键词，空字符串查询最新通知'), sourceId: str('可选来源 ID'),
        from: str('最早发布日期 YYYY-MM-DD'), to: str('最晚发布日期 YYYY-MM-DD'),
        relevance: {type: 'string', enum: ['related', 'maybe', 'none']}, ...pagination,
    }),
    tool('get_notice', ref, ['sourceId', 'url']),
    tool('generate_notice_summary', ref, ['sourceId', 'url']),
    tool('list_events', {
        from: str('开始日期 YYYY-MM-DD'),
        to: str('结束日期 YYYY-MM-DD'),
        query: str('名称、地点、备注或授课教师关键词'), ...pagination,
    }),
    tool('get_event', {id: str('个人日程 ID')}, ['id']),
    tool('create_event', eventFields,
        ['title', 'startDate', 'endDate', 'allDay']),
    tool('list_todos', {
        query: str('标题或备注关键词'), completed: {type: 'boolean', description: '可选，是否已完成'}, ...pagination,
    }),
    tool('create_todo', {
        title: str('待办名称'), notes: str('备注'), dueDate: str('截止日期 YYYY-MM-DD，未指定可省略'),
        dueTime: str('截止时间 HH:mm，有截止日期时必填'), reminderMinutes: eventFields.reminderMinutes,
    }, ['title']),
    tool('update_todo', {
        id: str('待办 ID，来自 list_todos'), title: str('新名称，可省略'), notes: str('新备注，可省略'),
        dueDate: str('新截止日期 YYYY-MM-DD，可省略'), dueTime: str('新截止时间 HH:mm，可省略'),
        completed: {type: 'boolean', description: '是否完成，可省略'}, reminderMinutes: eventFields.reminderMinutes,
    }, ['id']),
    tool('delete_todo', {id: str('待办 ID，来自 list_todos')}, ['id']),
    tool('update_event', {
        ...eventFields, id: str('日程 ID，来自 list_events'),
        title: str('新名称，可省略'), startDate: str('新开始日期，可省略'), endDate: str('新结束日期，可省略'),
        startTime: str('新开始时间，可省略'), endTime: str('新结束时间，可省略'),
        allDay: {type: 'boolean', description: '是否全天，可省略'}, location: str('新地点，可省略'),
        notes: str('新备注，可省略'),
    }, ['id']),
    tool('delete_event', {id: str('日程 ID，来自 list_events')}, ['id']),
]

export function configuredChatTools(descriptions: Record<ChatToolName, string>): ChatTool[] {
    return chatTools.map(item => ({
        ...item, function: {
            ...item.function,
            description: descriptions[item.function.name as ChatToolName] ?? item.function.description,
        }
    }))
}

export const chatToolLabels: Record<string, string> = {
    remember: '请求保存记忆', recall: '查询记忆', forget: '请求删除记忆',
    search_notices: '检索通知', get_notice: '读取通知',
    generate_notice_summary: '请求通知摘要',
    list_events: '获取日程', get_event: '读取日程', create_event: '请求新增日程',
    list_todos: '查询待办', create_todo: '请求新增待办',
    update_todo: '请求修改待办', delete_todo: '请求删除待办',
    update_event: '请求修改日程', delete_event: '请求删除日程',
}

/**
 * Model-facing views: ids and the fields the model needs, without timestamps, database-only ids or
 * UI state. Persisted records stay internal and are never passed through to the model verbatim.
 */
export function presentTodo(todo: Todo) {
    const elearning = todo.elearning
    const base = {
        id: todo.id, kind: 'todo' as const, title: todo.title, notes: todo.notes,
        dueDate: todo.dueDate, dueTime: todo.dueTime, completed: todo.completed,
        source: elearning ? 'elearning' as const : 'manual' as const,
    }
    if (!elearning) return base
    return {
        ...base,
        elearning: {
            courseName: elearning.courseName, status: elearning.status, url: elearning.url,
            submittedAt: elearning.submittedAt, attempts: elearning.attempts,
            label: `eLearning 作业 · ${elearning.courseName}`,
        }
    }
}

export function presentEvent(event: CalendarEvent) {
    return {
        id: event.id, kind: 'event' as const, title: event.title,
        startDate: event.startDate, endDate: event.endDate,
        startTime: event.startTime, endTime: event.endTime, allDay: event.allDay,
        location: event.location, notes: event.notes,
    }
}

export function presentNotice(notice: Notice) {
    return {
        sourceId: notice.sourceId, sourceName: notice.sourceName, title: notice.title,
        url: notice.url, published: notice.published, relevance: notice.relevance ?? 'none',
    }
}

function textArg(args: Fields, key: string, required = false, max = 500): string {
    const value = args[key]
    if (value === undefined && !required) return ''
    if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw new ToolError('invalid_args', `${key} 参数无效。`)
    return value.trim()
}

function range(args: Fields) {
    const from = textArg(args, 'from'), to = textArg(args, 'to')
    if ((from && !calendarDate(from)) || (to && !calendarDate(to)) || (from && to && from > to)) throw new ToolError('invalid_args', '日期范围无效。')
    return {from, to}
}

function page<T>(items: T[], args: Fields) {
    const offset = args.offset ?? 0, limit = args.limit ?? 5
    if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0 ||
        typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 10) throw new ToolError('invalid_args', '分页参数无效。')
    return {total: items.length, items: items.slice(offset, offset + limit), hasMore: offset + limit < items.length}
}

export function createChatToolRunner(db: AppDatabase, username: string,
                                     notices: ReturnType<typeof registerNoticeHandlers>,
                                     addCard: (card: ChatCard) => void, assertCurrent: () => void,
                                     requestSummary: (notice: Notice) => unknown, requestAction: (action: ChatAction) => unknown) {
    const seenNotices = new Set<string>()
    const noticeKey = (item: { sourceId: string; url: string }) => JSON.stringify([item.sourceId, item.url])

    function noticeCard(notice: Notice) {
        seenNotices.add(noticeKey(notice));
        addCard({kind: 'notice', notice})
    }

    function eventCard(event: CalendarEvent, deleted = false) {
        addCard({kind: 'event', event, deleted})
    }

    function knownNotice(args: Fields) {
        const sourceId = textArg(args, 'sourceId', true), url = textArg(args, 'url', true, 2048)
        const notice = notices.list().items.find(item => item.sourceId === sourceId && item.url === url)
        if (!notice) throw new ToolError('not_found', '通知不存在或来源已停用。')
        if (!seenNotices.has(noticeKey(notice))) throw new ToolError('forbidden', '请先检索这条通知，再进行读取或摘要。')
        return notice
    }

    function getEvent(args: Fields) {
        const id = textArg(args, 'id', true)
        if (id.startsWith('course:')) throw new ToolError('invalid_args', '课表课程只读，请使用日程查询获取课程安排，不能修改或删除。')
        const event = db.getCalendarEvents(username).find(item => item.id === id)
        if (!event) {
            if (db.getTodo(username, id)) throw new ToolError('invalid_args', '该 ID 属于待办，不能使用日程工具操作。请使用待办查询工具。')
            throw new ToolError('not_found', '日程不存在或已被删除。')
        }
        return event
    }

    return async (name: string, raw: string): Promise<unknown> => {
        assertCurrent()
        const schema = chatTools.find(item => item.function.name === name)?.function.parameters
        if (!schema) throw new ToolError('forbidden', '不支持的工具。')
        let args: unknown
        try {args = JSON.parse(raw)} catch {throw new ToolError('invalid_args', '工具参数不是有效 JSON。')}
        if (!args || typeof args !== 'object' || Array.isArray(args)) throw new ToolError('invalid_args', '工具参数必须是对象。')
        const input = args as Fields
        const properties = schema.properties as Fields
        if (Object.keys(input).some(key => !Object.hasOwn(properties, key)) || (schema.required as string[]).some(key => !Object.hasOwn(input, key))) throw new ToolError('invalid_args', '工具参数缺失或包含未知字段。')
        for (const [key, value] of Object.entries(input)) {
            const rule = properties[key] as {type?: string | string[]; enum?: unknown[]; minimum?: number; maximum?: number}
            const types = Array.isArray(rule.type) ? rule.type : [rule.type]
            const valid = types.some(type => type === 'null' ? value === null : type === 'integer' ? Number.isSafeInteger(value) : typeof value === type)
            if (!valid || (rule.enum && !rule.enum.includes(value)) ||
                (typeof value === 'number' && (!Number.isFinite(value) || (rule.minimum !== undefined && value < rule.minimum) || (rule.maximum !== undefined && value > rule.maximum)))) {
                throw new ToolError('invalid_args', `${key} 参数类型或范围无效。`)
            }
        }
        if (name === 'recall' || name === 'remember' || name === 'forget') {
            if (!db.getMemoryEnabled(username)) throw new ToolError('forbidden', '记忆已关闭，可在设置中管理。')
            if (name === 'recall') {
                const query = textArg(input, 'query').toLocaleLowerCase()
                const result = page(db.getMemories(username).filter(item => item.status === 'active' &&
                    (!item.expiresAt || Date.parse(item.expiresAt) > Date.now()) && item.text.toLocaleLowerCase().includes(query)), input)
                return {...result, items: result.items.map(presentMemory)}
            }
            if (name === 'forget') {
                const id = textArg(input, 'id', true)
                const matches = db.getMemories(username).filter(item => item.id === id || (id.length >= 4 && item.id.startsWith(id)))
                if (!matches.length) throw new ToolError('not_found', '记忆不存在，请先查询后再请求删除。')
                if (matches.length > 1) throw new ToolError('invalid_args', '记忆 ID 前缀不唯一，请使用 recall 返回的短 id。')
                return requestAction({kind: 'forget', memory: matches[0]})
            }
            // Optional fields default here instead of failing the call: models routinely omit them.
            // `expiresAt: ''` means permanent — a single string type keeps older gateways from 400ing
            // on the former ["string","null"] union.
            const result = validateMemory({confidence: 0.6, pinned: false, ...input,
                expiresAt: input.expiresAt === '' ? null : input.expiresAt ?? null, status: 'active'})
            if (!result.ok) throw new ToolError('invalid_args', result.error)
            return requestAction({kind: 'remember', memory: result.data})
        }
        if (name === 'search_notices') {
            const words = textArg(input, 'query').toLocaleLowerCase().split(/\s+/).filter(Boolean)
            const sourceId = textArg(input, 'sourceId'), {from, to} = range(input)
            if (input.relevance !== undefined && !['related', 'maybe', 'none'].includes(String(input.relevance))) throw new ToolError('invalid_args', '相关性参数无效。')
            const items = notices.list().items.filter(item => (!sourceId || item.sourceId === sourceId) &&
                (!from || item.published >= from) && (!to || item.published <= to) &&
                (input.relevance === undefined || (item.relevance || 'none') === input.relevance) &&
                words.every(word => `${item.title} ${item.sourceName}`.toLocaleLowerCase().includes(word)))
                .sort((a, b) => b.published.localeCompare(a.published))
            const result = page(items, input)
            result.items.forEach(noticeCard)
            return {...result, items: result.items.map(presentNotice)}
        }
        if (name === 'get_notice') {
            const notice = knownNotice(input)
            const detail = await notices.detail(notice)
            assertCurrent()
            if (detail.requiresLogin) throw new ToolError('forbidden', '通知需要登录，请在通知详情中登录后再试。')
            noticeCard(notice)
            return {notice: presentNotice(notice), content: detail.content}
        }
        if (name === 'generate_notice_summary') {
            const notice = knownNotice(input)
            assertCurrent()
            return requestSummary(notice)
        }
        if (name === 'list_events') {
            const {from, to} = range(input), query = textArg(input, 'query').toLocaleLowerCase()
            const preferences = db.getMessagePreferences()
            const supported = preferences.identity === 'student' && ['undergraduate', 'master', 'doctoral'].includes(preferences.educationLevel)
            const timetable = supported ? db.getTimetable(username, preferences.educationLevel === 'undergraduate' ? 'undergraduate' : 'postgraduate') : null
            const timetableWarning = preferences.identity !== 'student' ? '当前身份不支持课表查询。'
                : !supported ? '请先设置学历阶段，才能查询课表。'
                    : !timetable ? '尚未获取课表，当前仅返回个人日程，请刷新课表后重试。'
                        : !timetable.startDate ? '课表缺少开学日期，请在日历设置第一周起始日期后查询具体上课日期。' : ''
            const events = db.getCalendarEvents(username).filter(item => (!from || item.endDate >= from) && (!to || item.startDate <= to) &&
                `${item.title} ${item.location} ${item.notes}`.toLocaleLowerCase().includes(query))
                .map(event => ({...event, kind: 'event' as const, readOnly: false, event}))
            const courses = calendarOccurrences(timetable, [], from || '1900-01-01', to || '2100-12-31')
                .filter(item => `${item.title} ${item.location} ${item.course!.teachers.join(' ')}`.toLocaleLowerCase().includes(query))
                .map(occurrence => ({
                    kind: 'course' as const, readOnly: true, id: occurrence.key, title: occurrence.title,
                    startDate: occurrence.date, endDate: occurrence.date, startTime: timeLabel(occurrence.startMinute),
                    endTime: timeLabel(occurrence.endMinute), allDay: false, location: occurrence.location,
                    teachers: occurrence.course!.teachers, startUnit: occurrence.course!.startUnit,
                    endUnit: occurrence.course!.endUnit, occurrence
                }))
            const items = [...events, ...courses]
                .sort((a, b) => a.startDate.localeCompare(b.startDate) || Number(b.allDay) - Number(a.allDay) ||
                    a.startTime.localeCompare(b.startTime) || a.id.localeCompare(b.id))
            const result = page(items, input)
            result.items.forEach(item => {
                if (item.kind === 'course') addCard({kind: 'course', occurrence: item.occurrence})
                else eventCard(item.event)
            })
            return {
                ...result, items: result.items.map(item => item.kind === 'course'
                    ? {kind: 'course' as const, readOnly: true, id: item.id, title: item.title, date: item.startDate,
                        startTime: item.startTime, endTime: item.endTime, location: item.location,
                        teachers: item.teachers, startUnit: item.startUnit, endUnit: item.endUnit}
                    : {...presentEvent(item.event), readOnly: false}), timetableUpdatedAt: timetable?.updatedAt ?? null, timetableWarning
            }
        }
        if (name === 'get_event') {
            const event = getEvent(input);
            eventCard(event);
            return presentEvent(event)
        }
        if (name === 'create_event') {
            // Non-empty times are required for timed events; an empty string must fail here rather
            // than relying on the downstream calendar validator.
            if (input.allDay === false && (!input.startTime || !input.endTime)) {
                throw new ToolError('invalid_args', '请先明确日程的起止时间。')
            }
            const checked = validateCalendarEvent({
                startTime: '00:00', endTime: '00:00', location: '', notes: '',
                reminderMinutes: db.getCalendarDefaultReminder(), ...input,
            })
            if (!checked.ok) throw new ToolError('invalid_args', checked.error)
            return requestAction({kind: 'create_event', after: checked.data})
        }
        if (name === 'list_todos') {
            const query = textArg(input, 'query').toLocaleLowerCase()
            if (input.completed !== undefined && typeof input.completed !== 'boolean') throw new ToolError('invalid_args', '待办状态无效。')
            const result = page(db.getTodos(username).filter(todo =>
                (input.completed === undefined || todo.completed === input.completed) &&
                `${todo.title} ${todo.notes}`.toLocaleLowerCase().includes(query)), input)
            return {...result, items: result.items.map(presentTodo)}
        }
        if (name === 'create_todo') {
            if (input.dueDate && input.dueTime === undefined) throw new ToolError('invalid_args', '请先明确待办截止时间（时、分）。')
            if (!input.dueDate && input.dueTime) throw new ToolError('invalid_args', '请先明确待办截止日期。')
            const checked = validateTodo({
                notes: '', dueDate: '', dueTime: '00:00',
                reminderMinutes: db.getTodoDefaultReminder(), ...input, completed: false
            })
            if (!checked.ok) throw new ToolError('invalid_args', checked.error)
            return requestAction({kind: 'create_todo', todo: checked.data})
        }
        if (name === 'update_todo') {
            const id = textArg(input, 'id', true)
            const before = db.getTodo(username, id)
            if (!before) throw new ToolError('not_found', '待办不存在或已被删除。')
            const checked = validateTodo({
                title: input.title === undefined ? before.title : textArg(input, 'title', true, 200),
                notes: input.notes === undefined ? before.notes : textArg(input, 'notes', false, 5000),
                dueDate: input.dueDate === undefined ? before.dueDate : textArg(input, 'dueDate'),
                dueTime: input.dueTime === undefined ? before.dueTime : textArg(input, 'dueTime'),
                reminderMinutes: input.reminderMinutes === undefined ? before.reminderMinutes : input.reminderMinutes,
                completed: input.completed === undefined ? before.completed : input.completed,
                id,
            })
            if (!checked.ok) throw new ToolError('invalid_args', checked.error)
            return requestAction({kind: 'update_todo', before, after: checked.data})
        }
        if (name === 'delete_todo') {
            const before = db.getTodo(username, textArg(input, 'id', true))
            if (!before) throw new ToolError('not_found', '待办不存在或已被删除。')
            return requestAction({kind: 'delete_todo', before})
        }
        if (name === 'update_event') {
            const before = getEvent(input)
            const pick = <T>(key: string, fallback: T): T => (input[key] === undefined ? fallback : input[key] as T)
            const checked = validateCalendarEvent({
                title: pick('title', before.title),
                startDate: pick('startDate', before.startDate), endDate: pick('endDate', before.endDate),
                startTime: pick('startTime', before.startTime), endTime: pick('endTime', before.endTime),
                allDay: pick('allDay', before.allDay), location: pick('location', before.location),
                notes: pick('notes', before.notes), reminderMinutes: pick('reminderMinutes', before.reminderMinutes),
                id: before.id,
            })
            if (!checked.ok) throw new ToolError('invalid_args', checked.error)
            return requestAction({kind: 'update_event', before, after: checked.data})
        }
        if (name === 'delete_event') {
            return requestAction({kind: 'delete_event', before: getEvent(input)})
        }
        throw new ToolError('forbidden', '不支持的工具。')
    }
}
