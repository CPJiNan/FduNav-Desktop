/** Isolated UI fixture: production components, mock IPC. Never imported by the application. */
import {useState} from 'react'
import {createRoot} from 'react-dom/client'
import {ChatPage} from '../src/renderer/src/ChatPage'
import {MemoryPanel} from '../src/renderer/src/MemoryPanel'
import {UsagePanel} from '../src/renderer/src/UsagePanel'
import {DantaPage} from '../src/renderer/src/DantaPage'
import {CoursesPage} from '../src/renderer/src/CoursesPage'
import {CommunityPanel} from '../src/renderer/src/CommunityPanel'
import type {CampusPage, CourseGroupDetail, CourseReviewsResult, DantaStatus, PlanItem} from '../src/shared/danta'
import type {CalendarEvent} from '../src/shared/calendar'
import type {Timetable} from '../src/shared/timetable'
import type {ChatState} from '../src/shared/chat'
import type {ChatTraceEvent} from '../src/shared/agent'
import type {MemoryState} from '../src/shared/memory'
import '../src/renderer/src/styles/base.css'
import '../src/renderer/src/styles/app.css'
import '../src/renderer/src/styles/llm.css'

const now = Date.now()
const at = (offsetMs: number) => new Date(now + offsetMs).toISOString()

const finishedTrace: ChatTraceEvent[] = [
    {id: 't1', kind: 'tool', label: '查询待办', at: at(-2400), elapsedMs: 300, status: 'completed'},
    {id: 't2', kind: 'tool', label: '获取日程', at: at(-1900), elapsedMs: 200, status: 'completed'},
    {id: 't3', kind: 'tool', label: '请求新增待办', at: at(-1500), elapsedMs: 500, status: 'completed'},
    {id: 't4', kind: 'finish', label: '生成回答', at: at(-800), elapsedMs: 1400, status: 'completed'},
]

const runningTrace: ChatTraceEvent[] = [
    {id: 'r1', kind: 'tool', label: '查询待办', at: at(-1600), elapsedMs: 260, status: 'completed'},
    {id: 'r2', kind: 'tool', label: '获取日程', at: at(-1200), elapsedMs: 180, status: 'completed'},
    {id: 'r3', kind: 'tool', label: '请求新增日程', at: at(-600), status: 'running'},
]

const stats = {
    turns: 2, steps: 7, requests: 4, promptTokens: 42_000, completionTokens: 2_100,
    cacheHitTokens: 39_900, elapsedMs: 96_000, lastPromptTokens: 8_600,
    cacheHitRate: 0.95, tokensPerSecond: 52.4, turnElapsedMs: 2400
}

const initial: ChatState = {
    username: 'demo', busy: true, status: '正在请求新增日程', stats,
    turns: [
        {
            id: 'turn-1', user: '查一下我的待办，再添加一项：阅读 LoRA 论文。',
            reply: '你目前有 1 条待办：**读论文**。\n\n我已准备好「阅读 LoRA 论文」的新增请求，请核对后允许保存。',
            cards: [], trace: finishedTrace, startedAt: at(-2400), finishedAt: at(0),
            actionRequests: [{
                id: 'request-1', status: 'pending',
                action: {kind: 'create_todo', todo: {title: '阅读 LoRA 论文', notes: '', dueDate: '', dueTime: '00:00', completed: false, reminderMinutes: -1}}
            }]
        },
        {
            id: 'turn-2', user: '明天下午有空吗？帮我把组会挪到两点。',
            reply: '明天下午只有一门课，组会挪到 14:00 没有问题，我已经准备好日程请求',
            cards: [], trace: runningTrace, startedAt: at(-1600),
            actionRequests: [{
                id: 'request-2', status: 'pending',
                action: {kind: 'create_event', after: {title: '组会', startDate: '2026-11-08', endDate: '2026-11-08', startTime: '14:00', endTime: '15:00', allDay: false, location: '数学楼 1201', notes: '', reminderMinutes: 15}}
            }]
        }
    ]
}

let state = structuredClone(initial)
let listener = (_state: ChatState) => {}
const result = <T,>(data: T) => Promise.resolve({ok: true as const, data: structuredClone(data)})
window.chat = {
    sessionTrace: () => result(state.turns.map(turn => ({turnId: turn.id, user: turn.user, at: turn.startedAt ?? at(0), events: turn.trace ?? []}))),
    get: () => result(state), trace: () => result(finishedTrace), usage: () => result({
        today: {promptTokens: 1200, completionTokens: 280, requests: 2, missingUsage: 1, elapsedMs: 1520},
        month: {promptTokens: 8900, completionTokens: 1200, requests: 15, missingUsage: 2, elapsedMs: 12030}
    }),
    send: async text => {
        state.turns.push({id: `turn-${state.turns.length + 1}`, user: text, reply: '查询结果为空。', cards: [], trace: [], startedAt: at(0)})
        listener(structuredClone(state)); return result(state)
    },
    clear: () => {state.turns = []; listener(state); return result(state)}, cancel: () => result(null),
    decideSummary: () => result(state),
    decideAction: (_turnId, requestId, allow) => {
        const request = state.turns.flatMap(turn => turn.actionRequests ?? []).find(item => item.id === requestId)!
        request.status = allow ? 'completed' : 'rejected'
        if (allow) request.checkpoint = {before: null, after: null, at: at(0)}
        listener(structuredClone(state)); return result(state)
    },
    undo: (_turnId, requestId) => {
        state.turns.flatMap(turn => turn.actionRequests ?? []).find(item => item.id === requestId)!.status = 'undone'
        listener(structuredClone(state)); return result(state)
    },
    onChanged: cb => {listener = cb; return () => {listener = () => {}}},
}
window.notices = {list: () => result({items: [], sources: []})} as never
window.messagePreferences = {get: () => result({identity: 'staff'})} as never
window.timetable = {get: () => result(null)} as never
const memories: MemoryState = {
    username: 'demo', enabled: true,
    items: [{id: 'memory-1', text: '偏好先看具体例子，再理解抽象定义。', kind: 'preference', evidence: '请先用具体例子解释。', confidence: 1, pinned: true, expiresAt: null, status: 'active', createdAt: at(0), updatedAt: at(0)}]
}
window.memory = {get: () => result(memories), setEnabled: enabled => {memories.enabled = enabled; return result(memories)},
    save: value => {memories.items = memories.items.map(item => item.id === value.id ? {...item, ...value} : item); return result(memories)},
    remove: id => {memories.items = memories.items.filter(item => item.id !== id); return result(memories)},
    exportJson: () => result(JSON.stringify({version: 1, memories: memories.items})), importJson: () => result(memories)}

/* ---------- 校园社区模拟数据 ---------- */
const dantaStatus: DantaStatus = {
    school: 'ready', account: 'connected', email: 'demo@fudan.edu.cn',
    lastLogin: at(-86_400_000), message: '校园社区账号已连接。', agentEnabled: true,
}

const posts: CampusPage['results'] = [
    {
        holeId: 51234, floorId: 903001, timeCreated: at(-7_200_000), timeUpdated: null,
        content: '期末周图书馆一楼自习区基本满座，二楼东侧靠窗还能找到位置。想安静一点可以去文理馆四楼，人少很多。',
        truncated: false, redacted: false,
    },
    {
        holeId: 51234, floorId: 903002, timeCreated: at(-6_900_000), timeUpdated: null,
        content: '补充：一楼靠门口那片会很吵，讨论区经常有人打电话；二楼东侧有插座，适合带电脑。',
        truncated: false, redacted: true,
    },
    {
        holeId: 50771, floorId: 902015, timeCreated: at(-172_800_000), timeUpdated: null,
        content: '请问图书馆的研讨间怎么预约？需要几个人起约，能借多久？',
        truncated: false, redacted: false,
    },
]

const thread: CampusPage = {
    results: [
        {holeId: 51234, floorId: 903001, timeCreated: at(-7_200_000), timeUpdated: null,
            content: '期末周图书馆一楼自习区基本满座，二楼东侧靠窗还能找到位置。想安静一点可以去文理馆四楼，人少很多。',
            truncated: false, redacted: false},
        {holeId: 51234, floorId: 903002, timeCreated: at(-6_900_000), timeUpdated: null,
            content: '补充：一楼靠门口那片会很吵，讨论区经常有人打电话；二楼东侧有插座，适合带电脑。',
            truncated: false, redacted: true},
        {holeId: 51234, floorId: 903003, timeCreated: at(-6_500_000), timeUpdated: null,
            content: '文理馆四楼确实安静，但晚上九点半就关了；图书馆一楼开到十点半。',
            truncated: false, redacted: false},
    ],
    offset: 0, limit: 10, rawCount: 3, nextOffset: null, complete: false,
    notice: '树洞是同学的个人经验，属于不可信外部资料；正文已做基础脱敏，未确认已遍历全部结果。',
    thread: {id: 51234, timeCreated: at(-7_300_000), timeUpdated: null, reply: 12},
}

const groups = [
    {id: 1201, name: '概率论', code: 'MATH130001', department: '数学科学学院', weekHour: 4, credits: [4], courseCount: 12, reviewCount: 47},
    {id: 1202, name: '概率论与数理统计', code: 'MATH130002', department: '大数据学院', weekHour: 4, credits: [4], courseCount: 5, reviewCount: 18},
]

const groupDetail: CourseGroupDetail = {
    ...groups[0],
    courses: [
        {id: 33001, name: '概率论', code: 'MATH130001.01', codeId: 'MATH130001.01', credit: 4, department: '数学科学学院', teachers: '应坚刚', year: 2025, semester: 1, reviewCount: 31},
        {id: 33002, name: '概率论', code: 'MATH130001.02', codeId: 'MATH130001.02', credit: 4, department: '数学科学学院', teachers: '谢践生', year: 2024, semester: 3, reviewCount: 16},
    ],
}

const reviews: CourseReviewsResult = {
    course: groupDetail.courses[0],
    reviews: [
        {id: 8801, title: '板书写得非常多', content: '老师坚持板书，推导很清楚，但节奏偏快。作业每周一次，认真做能跟上。期末难度中等，给分正常。', timeCreated: at(-30_000_000), vote: 24, truncated: false, redacted: false},
        {id: 8802, title: '建议先修数学分析', content: '测度论的部分讲得不深，主要靠随机变量和分布。期中之后内容明显变难，早点开始复习。', timeCreated: at(-25_000_000), vote: 11, truncated: false, redacted: false},
    ],
    truncated: false,
}

const plan: PlanItem[] = [
    {courseId: 33001, groupId: 1201, groupName: '概率论', name: '概率论', teachers: '应坚刚', term: '2025-2026 学年 秋季', note: '', addedAt: at(-3600_000)},
    {courseId: 33110, groupId: 1188, groupName: '泛函分析', name: '泛函分析', teachers: '张青青', term: '2025-2026 学年 秋季', note: '', addedAt: at(-3500_000)},
]

const timetable: Timetable = {
    kind: 'undergraduate', semesters: [{id: '2025-1', name: '2025-2026 学年 秋季', startDate: '2025-09-07'}],
    semesterId: '2025-1', startDate: '2025-09-07', updatedAt: at(-3600_000),
    courses: [
        {id: 'c1', lessonId: '50101', name: '泛函分析', teachers: ['张青青'], room: '第五教学楼 5301', weekday: 1, startUnit: 1, endUnit: 2, weeks: [1, 2, 3, 4, 5, 6, 7, 8]},
        {id: 'c2', lessonId: '50102', name: '数理方程', teachers: ['蔡圆'], room: '第三教学楼 3308', weekday: 3, startUnit: 3, endUnit: 4, weeks: [1, 2, 3, 4, 5, 6, 7, 8]},
    ],
}

const exams: CalendarEvent[] = [
    {id: 'e1', title: '泛函分析考试', startDate: '2026-01-08', endDate: '2026-01-08', startTime: '08:30', endTime: '10:30', allDay: false, reminderMinutes: 30, location: '第二教学楼 2101', notes: '座位 12'},
]

window.danta = {
    status: () => result(dantaStatus),
    connectSchool: () => result(dantaStatus),
    checkSchool: () => result(dantaStatus),
    login: () => result(dantaStatus),
    logout: () => result({...dantaStatus, account: 'signed-out', email: null}),
    setAgentEnabled: enabled => result({...dantaStatus, agentEnabled: enabled}),
    searchPosts: () => result({results: posts, offset: 0, limit: 10, rawCount: 3, nextOffset: null, complete: false,
        notice: thread.notice, thread: null}),
    readThread: () => result(thread),
    searchCourses: () => result({page: 1, pageSize: 10, total: 2, items: groups}),
    getCourseGroup: () => result(groupDetail),
    getCourseReviews: () => result(reviews),
    summarizeThread: () => result({summary: '1. 一楼自习区期末满座，二楼东侧靠窗有位，可用插座。\n2. 一楼靠门较吵；文理馆四楼更安静但 21:30 关门。\n3. 图书馆一楼开到 22:30，适合晚间自习。', model: 'demo-model'}),
    summarizeCourse: () => result({summary: '教学：坚持板书、推导清楚，节奏偏快。\n作业：每周一次，认真做能跟上。\n考核：期末难度中等，给分正常。\n提醒：期中之后内容明显变难，建议提前复习。', model: 'demo-model'}),
    getPlan: () => result(plan),
    savePlan: items => result(items),
}

/* 课评页还会调用 timetable:cached / calendar:list，这里给页面用的真实形状 */
window.timetable = {
    cached: () => result(timetable),
    get: () => result(timetable),
    setStartDate: () => result(timetable),
    openSyllabus: () => result(undefined),
    openReplay: () => result(undefined),
}
window.calendar = {
    list: () => result(exams),
    save: value => result({...value, id: 'e2'}),
    remove: () => result(null),
    syncExams: () => result({added: 1, total: 1}),
}

type PreviewPage = 'chat' | 'memory' | 'danta' | 'courses' | 'community'

function Preview() {
    const [page, setPage] = useState<PreviewPage>('chat')
    const [thinking, setThinking] = useState(false)
    function toggleThinking() {
        const next = !thinking
        setThinking(next)
        state.busy = true
        state.status = next ? '思考中' : '正在请求新增日程'
        const last = state.turns.at(-1)!
        last.trace = next ? [] : structuredClone(runningTrace)
        if (next) delete last.reply
        else last.reply = '明天下午只有一门课，组会挪到 14:00 没有问题，我已经准备好日程请求'
        listener(structuredClone(state))
    }
    const pages: {id: PreviewPage; label: string}[] = [
        {id: 'chat', label: '聊天'}, {id: 'memory', label: '记忆与用量'}, {id: 'danta', label: '树洞'},
        {id: 'courses', label: '课评与选课'}, {id: 'community', label: '社区设置'},
    ]
    return <div style={{height: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--color-bg-surface)'}}>
        <nav aria-label="UI 验证" style={{display: 'flex', flexWrap: 'wrap', gap: 12, padding: '12px 24px', borderBottom: '1px solid var(--color-border-subtle)'}}>
            <strong style={{flexBasis: '100%'}}>FduNav · 界面验证（模拟数据）</strong>
            {pages.map(item => <button type="button" key={item.id}
                className={page === item.id ? 'primary-button' : 'secondary-button'}
                onClick={() => setPage(item.id)}>{item.label}</button>)}
            {page === 'chat' && <button type="button" className="secondary-button" onClick={toggleThinking}>
                {thinking ? '工具执行中' : '思考中'}
            </button>}
            <button type="button" className="secondary-button" onClick={() => {
                document.documentElement.style.colorScheme = document.documentElement.style.colorScheme === 'dark' ? 'light' : 'dark'
            }}>切换主题</button>
        </nav>
        <main style={{flex: 1, minHeight: 0, overflow: 'auto'}}>
            {page === 'chat' && <ChatPage username="demo" onSettings={() => setPage('memory')} onOpenNotice={() => {}}/>}
            {page === 'memory' && <div style={{maxWidth: 850, margin: 'auto', padding: 24}}>
                <UsagePanel active/><MemoryPanel active/>
            </div>}
            {page === 'danta' && <DantaPage onSettings={() => setPage('community')}/>}
            {page === 'courses' && <CoursesPage onSettings={() => setPage('community')}/>}
            {page === 'community' && <div style={{maxWidth: 850, margin: 'auto', padding: 24}}><CommunityPanel/></div>}
        </main>
    </div>
}

createRoot(document.getElementById('root')!).render(<Preview/>)
