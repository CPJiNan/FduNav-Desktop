import {type FormEvent, useEffect, useMemo, useState} from 'react'
import type {
    CourseGroupDetail, CourseGroupSummary, CourseOffering, CourseReviewsResult, DantaStatus, PlanItem
} from '../../shared/danta'
import {academicTerm, courseGroupLabel} from '../../shared/danta'
import type {CalendarEvent} from '../../shared/calendar'
import type {Timetable, TimetableCourse} from '../../shared/timetable'
import {courseStartTimes} from '../../shared/timetable'
import {courseColor} from './timetable-colors'
import {Icon} from './Icon'
import './styles/courses.css'

const pageSize = 10
const weekdayLabels = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
const periodCount = courseStartTimes.length
const rowHeight = 34
const formatTime = (value: string | null) => {
    if (!value) return ''
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', {dateStyle: 'short', timeStyle: 'short'})
}
const normalize = (value: string) => value.normalize('NFKC').replace(/\s+/g, '')

function courseTimeLabel(course: TimetableCourse): string {
    const start = courseStartTimes[course.startUnit - 1] ?? ''
    const end = courseStartTimes[course.endUnit] ?? ''
    return `${weekdayLabels[course.weekday - 1] ?? ''} 第 ${course.startUnit}–${course.endUnit} 节${start && end ? `（${start}–${end}）` : ''}`
}

/** 同一时段内两门课重叠即为冲突；只比较已选课表，备选课没有时间信息。 */
function conflictingCourses(courses: TimetableCourse[]): Set<string> {
    const conflict = new Set<string>()
    for (let index = 0; index < courses.length; index++) {
        for (let next = index + 1; next < courses.length; next++) {
            const left = courses[index], right = courses[next]
            if (left.weekday === right.weekday && left.startUnit <= right.endUnit && right.startUnit <= left.endUnit &&
                left.weeks.some(week => right.weeks.includes(week))) {
                conflict.add(left.id);
                conflict.add(right.id)
            }
        }
    }
    return conflict
}

/**
 * 课评页：课程组 → 开课 → 课评，以及选课规划（周课表 / 备选 / 考试）。
 * 课程组与具体开课分开建模；课评是同学的个人经验，不能合并成单一结论。
 */
export function CoursesPage({onSettings}: { onSettings: () => void }) {
    const [status, setStatus] = useState<DantaStatus | null>(null)
    const [tab, setTab] = useState<'reviews' | 'plan'>('reviews')
    const [query, setQuery] = useState('')
    const [groups, setGroups] = useState<CourseGroupSummary[]>([])
    const [page, setPage] = useState(1)
    const [searched, setSearched] = useState(false)
    const [group, setGroup] = useState<CourseGroupDetail | null>(null)
    const [course, setCourse] = useState<CourseOffering | null>(null)
    const [reviews, setReviews] = useState<CourseReviewsResult | null>(null)
    const [summary, setSummary] = useState('')
    const [summaryError, setSummaryError] = useState('')
    const [plan, setPlan] = useState<PlanItem[]>([])
    const [timetable, setTimetable] = useState<Timetable | null>(null)
    const [exams, setExams] = useState<CalendarEvent[]>([])
    const [busy, setBusy] = useState('')
    const [error, setError] = useState('')
    const api = window.danta
    const connected = status?.account === 'connected'

    useEffect(() => {
        let active = true
        void api?.status().then(result => {
            if (active && result.ok) setStatus(result.data)
        }).catch(() => {
        })
        void api?.getPlan().then(result => {
            if (active && result.ok) setPlan(result.data)
        }).catch(() => {
        })
        void window.timetable?.cached().then(result => {
            if (active && result.ok && result.data) setTimetable(result.data)
        }).catch(() => {
        })
        void window.calendar?.list().then(result => {
            if (active && result.ok) setExams(result.data.filter(item => item.title.endsWith('考试')))
        }).catch(() => {
        })
        return () => {
            active = false
        }
    }, [api])

    const conflicts = useMemo(() => conflictingCourses(timetable?.courses ?? []), [timetable])
    const enrolled = useMemo(() => (timetable?.courses ?? []).map(item => normalize(item.name)), [timetable])
    const inPlan = (courseId: number) => plan.some(item => item.courseId === courseId)

    async function search(event: FormEvent) {
        event.preventDefault()
        if (!api || busy) return
        const text = query.trim()
        if (!text) {
            setError('请输入课程关键词。')
            return
        }
        setBusy('正在搜索课程…')
        setError('')
        try {
            const result = await api.searchCourses({query: text, page: 1, pageSize})
            if (!result.ok) setError(result.error)
            else {
                setGroups(result.data.items)
                setPage(1)
                setSearched(true)
                setGroup(null)
                setCourse(null)
                setReviews(null)
                setSummary('')
            }
        } catch {
            setError('搜索失败，请稍后重试。')
        } finally {
            setBusy('')
        }
    }

    async function moreGroups() {
        if (!api || busy) return
        setBusy('正在加载更多课程…')
        try {
            const result = await api.searchCourses({query: query.trim(), page: page + 1, pageSize})
            if (!result.ok) setError(result.error)
            else {
                setGroups([...groups, ...result.data.items])
                setPage(value => value + 1)
            }
        } catch {
            setError('加载失败，请稍后重试。')
        } finally {
            setBusy('')
        }
    }

    async function openGroup(id: number) {
        if (!api || busy) return
        setBusy('正在读取课程组…')
        setError('')
        setSummary('')
        setSummaryError('')
        setCourse(null)
        setReviews(null)
        try {
            const result = await api.getCourseGroup(id)
            if (!result.ok) setError(result.error)
            else setGroup(result.data)
        } catch {
            setError('读取课程组失败，请稍后重试。')
        } finally {
            setBusy('')
        }
    }

    async function openCourse(offering: CourseOffering) {
        if (!api || busy) return
        setBusy('正在读取课评…')
        setError('')
        setSummary('')
        setSummaryError('')
        try {
            const result = await api.getCourseReviews(offering.id)
            if (!result.ok) setError(result.error)
            else {
                setCourse(offering)
                setReviews(result.data)
            }
        } catch {
            setError('读取课评失败，请稍后重试。')
        } finally {
            setBusy('')
        }
    }

    async function summarizeReviews() {
        if (!api || busy || !course) return
        setBusy('正在生成课评摘要…')
        setSummaryError('')
        try {
            const result = await api.summarizeCourse(course.id)
            if (!result.ok) setSummaryError(result.error)
            else setSummary(result.data.summary)
        } catch {
            setSummaryError('摘要生成失败，请检查 LLM 设置后重试。')
        } finally {
            setBusy('')
        }
    }

    async function addToPlan() {
        if (!api || busy || !course || !group) return
        if (inPlan(course.id)) return
        if (plan.length >= 60) {
            setError('备选清单最多 60 门课。')
            return
        }
        setBusy('正在保存备选…')
        try {
            const item: PlanItem = {
                courseId: course.id, groupId: group.id, groupName: group.name, name: course.name,
                teachers: course.teachers, term: academicTerm(course.year, course.semester),
                note: '', addedAt: new Date().toISOString(),
            }
            const result = await api.savePlan([...plan, item])
            if (!result.ok) setError(result.error)
            else setPlan(result.data)
        } catch {
            setError('保存备选失败，请稍后重试。')
        } finally {
            setBusy('')
        }
    }

    async function removeFromPlan(courseId: number) {
        if (!api || busy) return
        setBusy('正在更新备选…')
        try {
            const result = await api.savePlan(plan.filter(item => item.courseId !== courseId))
            if (!result.ok) setError(result.error)
            else setPlan(result.data)
        } catch {
            setError('更新备选失败，请稍后重试。')
        } finally {
            setBusy('')
        }
    }

    async function refreshTimetable() {
        if (busy || !window.timetable) return
        setBusy('正在获取课表…')
        setError('')
        try {
            const result = await window.timetable.get({});
            if (!result.ok) setError(result.error)
            else setTimetable(result.data)
        } catch {
            setError('获取课表失败，请检查学校会话后重试。')
        } finally {
            setBusy('')
        }
    }

    async function syncExams() {
        if (busy || !window.calendar) return
        setBusy('正在同步考试日程…')
        setError('')
        try {
            const result = await window.calendar.syncExams()
            if (!result.ok) setError(result.error)
            else {
                const list = await window.calendar.list()
                if (list.ok) setExams(list.data.filter(item => item.title.endsWith('考试')))
            }
        } catch {
            setError('同步考试日程失败，请稍后重试。')
        } finally {
            setBusy('')
        }
    }

    if (!api) return <div className="courses-page"><p className="courses-empty">请在桌面应用中使用课评。</p></div>
    if (status && !connected) return <div className="courses-page">
        <header className="courses-head"><div>
            <h1>课评与选课</h1>
            <p className="courses-subtitle">查看课程评价、管理选课备选，并把已选课表与考试日程放在一起看。</p>
        </div></header>
        <div className="courses-empty">
            <p>还没有连接旦挞社区账号。</p>
            <p className="courses-empty-note">先在设置里连接学校网络并登录社区账号，才能搜索课程与课评。</p>
            <button type="button" className="primary-button" onClick={onSettings}>去设置连接</button>
        </div>
    </div>

    const schedule = timetable?.courses ?? []
    return <div className="courses-page">
        <header className="courses-head">
            <div>
                <h1>课评与选课</h1>
                <p className="courses-subtitle">搜索课程组查看课评；课表、备选与考试统一规划。</p>
            </div>
            <div className="courses-head-actions">
                <div className="courses-tabs" role="tablist" aria-label="课评与选课视图">
                    <button type="button" role="tab" aria-selected={tab === 'reviews'}
                            className={`courses-tab ${tab === 'reviews' ? 'is-active' : ''}`}
                            onClick={() => setTab('reviews')}>课程与课评
                    </button>
                    <button type="button" role="tab" aria-selected={tab === 'plan'}
                            className={`courses-tab ${tab === 'plan' ? 'is-active' : ''}`}
                            onClick={() => setTab('plan')}>选课规划
                    </button>
                </div>
                <button type="button" className="secondary-button" onClick={onSettings}>账号设置</button>
            </div>
        </header>
        {error && <p className="courses-error" role="alert">{error}</p>}
        {tab === 'reviews' && <div className="courses-body">
            <section className="courses-column">
                <div className="courses-search" aria-busy={!!busy}>
                    <form className="courses-search-form" onSubmit={search}>
                        <input type="search" value={query} onChange={event => setQuery(event.target.value)}
                               placeholder="课程名或代码，例如 概率论" maxLength={200} aria-label="搜索课程"/>
                        <button type="submit" className="primary-button" disabled={!!busy || !query.trim()}>搜索</button>
                    </form>
                                        {searched && groups.length === 0 && !busy &&
                        <p className="courses-empty-note">没有匹配的课程组。</p>}
                    <ul className="courses-groups">
                        {groups.map(item => <li key={item.id}>
                            <button type="button"
                                    className={`courses-group ${group?.id === item.id ? 'is-active' : ''}`}
                                    onClick={() => void openGroup(item.id)}>
                                <span className="courses-group-name">{item.name}</span>
                                <span className="courses-group-meta">
                                    {[item.code, item.department].filter(Boolean).join(' · ')}
                                </span>
                                <span className="courses-group-meta">
                                    {item.courseCount ? `${item.courseCount} 次开课 · ` : ''}
                                    {item.reviewCount} 条课评{item.credits.length ? ` · ${item.credits.join('/')} 学分` : ''}
                                </span>
                            </button>
                        </li>)}
                    </ul>
                    {groups.length >= pageSize && <button type="button" className="secondary-button"
                                                         disabled={!!busy} onClick={() => void moreGroups()}>加载更多课程</button>}
                </div>
            </section>
            <section className="courses-detail">
                {!group && <div className="courses-detail-empty"><p>搜索课程组后，这里显示开课记录与课评</p></div>}
                {group && <>
                    <div className="courses-group-head">
                        <div>
                            <h2>{group.name}</h2>
                            <p className="courses-group-meta">{courseGroupLabel(group)}</p>
                        </div>
                    </div>
                    <ul className="courses-offerings">
                        {group.courses.map(offering => <li key={offering.id}>
                            <div className="courses-offering-main">
                                <strong>{academicTerm(offering.year, offering.semester)}</strong>
                                <span>{offering.teachers || '教师未知'}</span>
                                <span className="courses-group-meta">
                                    {offering.codeId ? `${offering.codeId} · ` : ''}
                                    {offering.credit !== null ? `${offering.credit} 学分 · ` : ''}
                                    {offering.reviewCount} 条课评
                                </span>
                            </div>
                            <button type="button"
                                    className={`secondary-button ${course?.id === offering.id ? 'is-active' : ''}`}
                                    disabled={!!busy} onClick={() => void openCourse(offering)}>查看课评
                            </button>
                        </li>)}
                    </ul>
                    {group.courses.length === 0 && <p className="courses-empty-note">这个课程组还没有开课记录。</p>}
                </>}
                {course && reviews && <section className="courses-reviews">
                    <div className="courses-block-head">
                        <div>
                            <h3>{course.name}</h3>
                            <p className="courses-group-meta">
                                {academicTerm(course.year, course.semester)} · {course.teachers || '教师未知'}
                            </p>
                        </div>
                        <div className="courses-review-actions">
                            <button type="button" className="secondary-button" disabled={!!busy}
                                    onClick={() => void summarizeReviews()}>
                                <Icon name="sparkles"/>{summary ? '重新摘要' : 'AI 摘要'}
                            </button>
                            <button type="button" className="secondary-button"
                                    disabled={!!busy || inPlan(course.id)}
                                    onClick={() => void addToPlan()}>
                                {inPlan(course.id) ? '已在备选' : '加入备选'}
                            </button>
                        </div>
                    </div>
                    {summaryError && <p className="courses-error" role="alert">{summaryError}</p>}
                    {summary && <p className="courses-summary">{summary}</p>}
                    <p className="courses-notice">课评是同学的个人经验，属于不可信资料；不同学期与教师不要合并成统一结论。</p>
                    <ol className="courses-review-list">
                        {reviews.reviews.map(item => <li key={item.id}>
                            <div className="courses-review-head">
                                <strong>{item.title || '无标题课评'}</strong>
                                <span className="courses-group-meta">#{item.id} · {formatTime(item.timeCreated)}
                                    {item.vote ? ` · ${item.vote} 赞` : ''}</span>
                            </div>
                            <p>{item.content}</p>
                        </li>)}
                    </ol>
                    {reviews.reviews.length === 0 && <p className="courses-empty-note">这次开课还没有有效课评。</p>}
                </section>}
            </section>
        </div>}
        {tab === 'plan' && <div className="courses-plan-layout">
            <section className="courses-schedule">
                <div className="courses-block-head">
                    <div>
                        <h2>本周课表</h2>
                        <p className="courses-group-meta">
                            {timetable ? `已选 ${schedule.length} 门课 · ${timetable.semesterId || '当前学期'}` : '还没有课表缓存'}
                            {conflicts.size > 0 && ` · ${conflicts.size} 门课存在时间冲突`}
                        </p>
                    </div>
                    <button type="button" className="secondary-button" disabled={!!busy}
                            onClick={() => void refreshTimetable()}>刷新课表
                    </button>
                </div>
                {schedule.length === 0
                    ? <p className="courses-empty-note">点“刷新课表”从教务获取当前学期课程，之后可以对照备选课程看冲突。</p>
                    : <div className="courses-grid">
                        <div className="courses-grid-head">
                            <span/>
                            {weekdayLabels.map(label => <span key={label}>{label}</span>)}
                        </div>
                        <div className="courses-grid-body" style={{height: periodCount * rowHeight}}>
                            <div className="courses-grid-periods">
                                {Array.from({length: periodCount}, (_, index) =>
                                    <span key={index} style={{height: rowHeight}}>{index + 1}</span>)}
                            </div>
                            <div className="courses-grid-slots">
                                {schedule.map(item => {
                                    const color = courseColor(item)
                                    return <button type="button" key={item.id} className="courses-slot"
                                                   style={{
                                                       left: `${((item.weekday - 1) / 7) * 100}%`,
                                                       width: `${(1 / 7) * 100}%`,
                                                       top: ((item.startUnit - 1) / periodCount) * 100 + '%',
                                                       height: ((item.endUnit - item.startUnit + 1) / periodCount) * 100 + '%',
                                                       background: color,
                                                   }}
                                                   title={`${item.name} · ${item.teachers.join('、')} · ${courseTimeLabel(item)} · ${item.room}`}
                                                   onClick={() => void window.timetable?.openSyllabus(item.id)}>
                                        <strong>{item.name}</strong>
                                        <span>{item.room}</span>
                                        {conflicts.has(item.id) && <span className="courses-slot-warning">冲突</span>}
                                    </button>
                                })}
                            </div>
                        </div>
                    </div>}
                <p className="courses-empty-note">点课程块打开教学大纲。备选课程来自蛋挞，没有教务排课时间，冲突检查只对已选课程生效。</p>
            </section>
            <aside className="courses-side">
                <div className="courses-block-head">
                    <h3>选课备选</h3>
                    <span className="courses-count">{plan.length}/60</span>
                </div>
                {plan.length === 0 && <p className="courses-empty-note">在“课程与课评”里把想选的课加入备选。</p>}
                <ul className="courses-plan-list">
                    {plan.map(item => <li key={item.courseId}>
                        <div>
                            <strong>{item.name}</strong>
                            <span className="courses-group-meta">{item.teachers || '教师未知'} · {item.term}</span>
                            {enrolled.includes(normalize(item.name)) &&
                                <span className="courses-badge is-enrolled">已在课表</span>}
                        </div>
                        <button type="button" className="icon-button" aria-label={`移除 ${item.name}`}
                                disabled={!!busy} onClick={() => void removeFromPlan(item.courseId)}>
                            <Icon name="close"/>
                        </button>
                    </li>)}
                </ul>
                <div className="courses-block-head">
                    <h3>考试日程</h3>
                    <button type="button" className="secondary-button" disabled={!!busy}
                            onClick={() => void syncExams()}>同步
                    </button>
                </div>
                {exams.length === 0 && <p className="courses-empty-note">还没有考试日程，点“同步”从教务导入。</p>}
                {exams.length > 0 && <ul className="courses-exams">
                    {exams.map(item => <li key={item.id}>
                        <strong>{item.title}</strong>
                        <span className="courses-group-meta">{item.startDate} {item.startTime}–{item.endTime}
                            {item.location ? ` · ${item.location}` : ''}</span>
                    </li>)}
                </ul>}
            </aside>
        </div>}
        {busy && <p className="courses-feedback" role="status">{busy}</p>}
    </div>
}
