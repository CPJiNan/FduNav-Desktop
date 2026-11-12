import {test} from 'node:test'
import assert from 'node:assert/strict'
import {dantaHosts, webvpnLoginUrl, webvpnRoute} from '../src/main/webvpn.ts'
import {semesterWindow} from '../src/shared/timetable.ts'
import {
    DantaError, maxPostChars, maxReviewChars, nextOffsetFor, parseCampusHoles, parseCampusPosts,
    parseCourseGroups, parseCourseGroup, parseReviews, parseThreadMeta, redactPersonal
} from '../src/main/danta-parse.ts'
import {
    academicTerm, communityFeeds, planCredits, planSlotsOverlap,
    type CampusPage, type CourseOffering, type CourseReviewsResult, type CourseSearchPage,
} from '../src/shared/danta.ts'
import {parseToolArgs} from '../src/main/danta-search.ts'
import {normalizePlanItems} from '../src/main/danta-plan.ts'
import {
    presentedReviewChars, presentCampusPage, presentCourseReviews, presentCourseSearch, presentTime
} from '../src/main/danta-present.ts'

test('webvpn route only rewrites the three community hosts through the official gateway', () => {
    assert.deepEqual([...dantaHosts].sort(), ['auth.fduhole.com', 'danke.fduhole.com', 'forum.fduhole.com'])
    assert.equal(webvpnLoginUrl, 'https://webvpn.fudan.edu.cn/login?cas_login=true')
    const route = webvpnRoute('https://forum.fduhole.com/api/floors/search?search=%E5%9B%BE%E4%B9%A6%E9%A6%86&offset=0&size=2')
    assert.ok(route.startsWith('https://webvpn.fudan.edu.cn/https/77726476706e69737468656265737421'))
    assert.ok(route.endsWith('/api/floors/search?search=%E5%9B%BE%E4%B9%A6%E9%A6%86&offset=0&size=2'))
    // Deterministic: the host encoding only depends on the hostname.
    assert.equal(webvpnRoute('https://danke.fduhole.com/a'), webvpnRoute('https://danke.fduhole.com/b').replace('/b', '/a'))
    assert.notEqual(webvpnRoute('https://forum.fduhole.com/a'), webvpnRoute('https://danke.fduhole.com/a'))
    for (const url of ['http://forum.fduhole.com/api/x', 'https://forum.fduhole.com:8443/api/x',
        'https://evil.example.com/api/x', 'https://user:pass@forum.fduhole.com/api/x', 'not a url']) {
        assert.throws(() => webvpnRoute(url), /社区服务/)
    }
})

test('personal identifiers are redacted before text reaches the page or the model', () => {
    const masked = redactPersonal('联系 a.b@fudan.edu.cn 或 13812345678，课程 2026 年开课')
    assert.equal(masked.redacted, true)
    assert.ok(!masked.text.includes('fudan.edu.cn'))
    assert.ok(!masked.text.includes('13812345678'))
    assert.ok(masked.text.includes('2026'))
    const plain = redactPersonal('期末周图书馆一楼基本满座')
    assert.equal(plain.redacted, false)
})

const floor = (id: number, holeId: number, content: string, extra: Record<string, unknown> = {}) => ({
    id, hole_id: holeId, content, time_created: '2026-11-10T08:00:00Z', time_updated: null, deleted: false, ...extra,
})

test('floor parsing drops deleted floors, enforces schema, and bounds each post', () => {
    const posts = parseCampusPosts([
        floor(1, 7, '图书馆二楼有位置'),
        floor(2, 7, '已删除楼层', {deleted: true}),
    ], {limit: 5, holeId: 7})
    assert.deepEqual(posts.map(item => item.floorId), [1])
    assert.equal(posts[0].redacted, false)

    assert.throws(() => parseCampusPosts([floor(3, 8, 'x')], {limit: 5, holeId: 7}), (error: unknown) =>
        error instanceof DantaError && error.code === 'schema')
    assert.throws(() => parseCampusPosts([floor(4, 7, 'x')], {limit: 0}), (error: unknown) =>
        error instanceof DantaError && error.code === 'schema')
    assert.throws(() => parseCampusPosts([{id: 5, hole_id: 7, content: 'x'}], {limit: 5}), (error: unknown) =>
        error instanceof DantaError && error.code === 'schema')

    const long = parseCampusPosts([floor(6, 7, 'x'.repeat(maxPostChars + 10))], {limit: 5})
    assert.equal(long[0].truncated, true)
    assert.equal(long[0].content.length, maxPostChars)
    const contact = parseCampusPosts([floor(7, 7, '私聊 13812345678')], {limit: 5})
    assert.equal(contact[0].redacted, true)
})

test('thread metadata must match the requested hole and carry a valid creation time', () => {
    assert.deepEqual(parseThreadMeta({id: 7, time_created: '2026-11-10T08:00:00Z', reply: 3}, 7),
        {id: 7, timeCreated: '2026-11-10T08:00:00Z', timeUpdated: null, reply: 3})
    assert.throws(() => parseThreadMeta({id: 8, time_created: '2026-11-10T08:00:00Z'}, 7), /格式发生变化/)
    assert.throws(() => parseThreadMeta({id: 7, time_created: 'yesterday'}, 7), /格式发生变化/)
})

test('a bare search array never claims exhaustive paging', () => {
    assert.equal(nextOffsetFor(0, 10, 10), 10)
    assert.equal(nextOffsetFor(10, 10, 3), null)
    assert.equal(nextOffsetFor(0, 10, 0), null)
})

test('course groups parse without an authoritative total', () => {
    const parsed = parseCourseGroups({
        page: 1, page_size: 2,
        items: [{id: 12, name: '概率论', code: 'MATH130001', department: '数学科学学院', week_hour: 4,
            credits: [4], course_count: 12, review_count: 47, unknown_field: 'ignored'}],
    }, 2)
    assert.equal(parsed.total, null)
    assert.equal(parsed.items[0].weekHour, 4)
    assert.deepEqual(parsed.items[0].credits, [4])
    assert.throws(() => parseCourseGroups({items: [{id: 0, name: 'x'}]}, 2), /格式发生变化/)
    assert.throws(() => parseCourseGroups({items: Array.from({length: 3}, () => ({id: 1, name: 'x'}))}, 2),
        /格式发生变化/)
})

test('course group detail keeps offerings separate from the group', () => {
    const detail = parseCourseGroup({
        id: 12, name: '概率论', code: 'MATH130001', department: '数学科学学院',
        course_list: [
            {id: 31, name: '概率论', code_id: 'MATH130001.01', teachers: '应坚刚', year: 2025, semester: 1,
                review_list: [{id: 1}, {id: 2}]},
            {id: 32, name: '概率论', teachers: '谢践生', year: 2024, semester: 3, review_list: []},
        ],
    })
    assert.equal(detail.courseCount, 2)
    assert.deepEqual(detail.courses.map(item => item.id), [31, 32])
    assert.equal(detail.courses[0].reviewCount, 2)
    assert.equal(academicTerm(detail.courses[0].year, detail.courses[0].semester), '2025-2026 学年 秋季')
    assert.equal(academicTerm(detail.courses[1].year, detail.courses[1].semester), '2024-2025 学年 春季')
})

test('offerings without review_list count as zero reviews', () => {
    // 真实接口只在有课评时才带 review_list；缺失与 null 都表示没有课评，不能当成「未知」。
    const detail = parseCourseGroup({
        id: 249, name: '概率论与数理统计', code: 'COMP130006',
        course_list: [
            {id: 497, name: '概率论与数理统计', teachers: '金玲飞', year: 2022, semester: 1},
            {id: 28112, name: '概率论与数理统计', teachers: '王勇', year: 2023, semester: 1, review_list: null},
            {id: 28113, name: '概率论与数理统计', teachers: '王勇', year: 2023, semester: 1, review_list: [{id: 1}]},
        ],
    })
    assert.deepEqual(detail.courses.map(item => item.reviewCount), [0, 0, 1])
})

test('reviews drop deleted entries and bound long text', () => {
    const parsed = parseReviews([
        {id: 1, title: '板书很多', content: '推导清楚', time_created: '2026-11-10T08:00:00Z', vote: 24},
        {id: 2, title: '已删', content: 'x', deleted: true},
    ], 5)
    assert.deepEqual(parsed.reviews.map(item => item.id), [1])
    assert.equal(parsed.reviews[0].vote, 24)
    assert.throws(() => parseReviews([{id: 0, content: 'x'}], 5), /格式发生变化/)
    const long = parseReviews([{id: 3, content: 'y'.repeat(maxReviewChars + 1)}], 5)
    assert.equal(long.truncated, true)
    assert.equal(long.reviews[0].truncated, true)
})

test('agent exposes the four read-only community tools with bounded arguments', async () => {
    const {chatTools, chatToolLabels, campusToolNames} = await import('../src/main/chat-tools.ts')
    const {defaultToolDescriptions} = await import('../src/shared/llm-prompts.ts')
    const byName = new Map(chatTools.map(item => [item.function.name, item.function]))
    assert.deepEqual([...campusToolNames].sort(), ['read_campus_thread', 'read_course_reviews', 'search_campus_posts', 'search_courses'])
    for (const name of campusToolNames) {
        const tool = byName.get(name)
        assert.ok(tool, `missing tool ${name}`)
        assert.ok(tool.description.trim())
        assert.ok(defaultToolDescriptions[name as keyof typeof defaultToolDescriptions])
        assert.ok(chatToolLabels[name])
    }
    const search = byName.get('search_campus_posts')!
    assert.deepEqual(search.parameters.required ?? [], ['query'])
    assert.equal((search.parameters.properties as Record<string, {maximum?: number}>).limit.maximum, 10)
    // 检索词必须在 schema 层就限长，否则超长 query 会直接打到上游
    const campusQuery = (search.parameters.properties as Record<string, {maxLength?: number}>).query
    assert.equal(campusQuery.maxLength, 200)
    const courseQuery = (byName.get('search_courses')!.parameters.properties as Record<string, {maxLength?: number}>).query
    assert.equal(courseQuery.maxLength, 200)
    assert.deepEqual(byName.get('read_campus_thread')!.parameters.required, ['holeId'])
    assert.deepEqual(byName.get('read_course_reviews')!.parameters.required, ['courseId'])
})

test('resident feeds stay read-only and keep their declared source', () => {
    assert.deepEqual(communityFeeds.map(feed => feed.id), ['featured'])
    const featured = communityFeeds.find(feed => feed.id === 'featured')!
    assert.equal(featured.tag, '#旦挞精选')
    assert.equal(featured.label, '精选')
    for (const feed of communityFeeds) {
        assert.ok(feed.tag.trim(), `${feed.id} must carry a tag name`)
        assert.ok(feed.label.trim())
    }
})

test('hole lists parse thread shape, drop hidden or empty holes, and bound each post', () => {
    const raw = [
        {
            hole_id: 900, view: 12, reply: 3, time_created: '2026-11-11T08:00:00+08:00',
            tags: [{name: '选课'}, {name: '攻略'}],
            floors: {first_floor: {id: 1, floor_id: 5, content: '第一层内容', time_created: '2026-11-11T08:00:00+08:00'}},
        },
        {hole_id: 901, hidden: true, floors: {first_floor: {id: 2, content: 'x', time_created: '2026-11-11T08:00:00+08:00'}}},
        {hole_id: 902, floors: {first_floor: {id: 3, content: '   ', time_created: '2026-11-11T08:00:00+08:00'}}},
        {
            hole_id: 903, view: null, reply: null, time_created: '2026-11-10T08:00:00+08:00',
            tags: [], floors: {first_floor: {id: 4, content: 'z'.repeat(maxPostChars + 1), time_created: '2026-11-10T08:00:00+08:00'}},
        },
    ]
    const posts = parseCampusHoles(raw, {limit: 10})
    assert.equal(posts.length, 2)
    assert.equal(posts[0].holeId, 900)
    assert.equal(posts[0].floorId, 5)
    assert.deepEqual(posts[0].tags, ['选课', '攻略'])
    assert.equal(posts[0].view, 12)
    assert.equal(posts[0].timeCreated, '2026-11-11T08:00:00+08:00')
    assert.equal(posts[1].view, null)
    assert.equal(posts[1].truncated, true)
    assert.equal(posts[1].content.length, maxPostChars)
    assert.throws(() => parseCampusHoles({}, {limit: 10}), /数据格式/)
    assert.throws(() => parseCampusHoles([{hole_id: 1, floors: {}}], {limit: 10}), /数据格式/)
})

const offering: CourseOffering = {
    id: 28112, name: '概率论 H', code: 'MATH120001', codeId: '3f2a', credit: 5,
    department: '数学科学学院', teachers: '张三', year: 2024, semester: 1, reviewCount: 1,
}

test('tool output drops internal metadata and normalises timestamps to Beijing time', () => {
    const page: CampusPage = {
        results: [{
            holeId: 900, floorId: 55, content: '图书馆  周一\t闭馆![](dx_overwhelm)', timeCreated: '2026-11-11T08:00:00Z',
            timeUpdated: null, truncated: false, redacted: true,
        }],
        offset: 0, limit: 10, rawCount: 1, nextOffset: null, complete: true,
        notice: '只读', thread: {id: 900, timeCreated: '2026-11-11T00:00:00Z', timeUpdated: null, reply: 3},
    }
    const presented = presentCampusPage(page)
    // 只留判断相关性需要的三个字段：floorId / redacted / timeUpdated 不进模型上下文
    assert.deepEqual(Object.keys(presented.posts[0]).sort(), ['content', 'holeId', 'time'])
    assert.equal(presented.posts[0].content, '图书馆 周一 闭馆')
    assert.equal(presented.posts[0].time, '2026-11-11 16:00')
    assert.equal(presented.thread?.time, '2026-11-11 08:00')
    assert.equal(presented.thread?.replies, 3)
    // offset / limit / rawCount 是分页实现细节，模型只需要 nextOffset
    assert.ok(!('offset' in presented) && !('rawCount' in presented) && !('limit' in presented))
    assert.equal(presentedTimeSafe(), 'ok')
})

function presentedTimeSafe() {
    assert.equal(presentTime('2026-11-11T10:00:00+08:00'), '2026-11-11 10:00')
    assert.equal(presentTime('not a date'), null)
    assert.equal(presentTime(null), null)
    return 'ok'
}

test('tool output stays inside a character budget and says what it dropped', () => {
    const page: CampusPage = {
        results: Array.from({length: 10}, (_, index) => ({
            holeId: 900 + index, floorId: index, content: 'x'.repeat(900),
            timeCreated: '2026-11-11T08:00:00Z', timeUpdated: null, truncated: false, redacted: false,
        })),
        offset: 0, limit: 10, rawCount: 10, nextOffset: 10, complete: true, notice: '只读', thread: null,
    }
    const presented = presentCampusPage(page)
    assert.ok(presented.posts.length < 10, 'budget must drop trailing posts')
    assert.equal(presented.truncated, true)
    assert.equal(presented.complete, false)
    assert.match(presented.note ?? '', /省略了 \d+ 条结果/)
    assert.ok(JSON.stringify(presented).length <= 6_400)
    for (const post of presented.posts) assert.equal(post.truncated, true)
})

test('course search keeps planning fields and flags a missing total', () => {
    const page: CourseSearchPage = {
        page: 2, pageSize: 10, total: null,
        items: [{id: 249, name: '概率论', code: 'MATH120001', department: '数学科学学院', weekHour: 4,
            credits: [5, 4], courseCount: 3, reviewCount: 16}],
    }
    const presented = presentCourseSearch(page)
    assert.deepEqual(Object.keys(presented.groups[0]).sort(), ['code', 'department', 'id', 'name', 'reviewCount', 'weekHour'])
    assert.equal(presented.page, 2)
    assert.equal(presented.hasTotal, false)
    assert.equal(presented.total, null)
    assert.match(presented.note ?? '', /未返回总数/)
    assert.equal(presentCourseSearch({...page, total: 3}).hasTotal, true)
})

test('course reviews are clipped per entry and drop internal ids', () => {
    const result: CourseReviewsResult = {
        course: offering, truncated: false,
        reviews: [{id: 77, title: '值得选', content: 'y'.repeat(1200), timeCreated: '2026-11-10T20:00:00+08:00',
            vote: 3, truncated: false, redacted: true}],
    }
    const presented = presentCourseReviews(result)
    assert.ok(!('id' in presented.reviews[0]))
    assert.equal(presented.reviews[0].content.length, presentedReviewChars + 1)
    assert.equal(presented.reviews[0].truncated, true)
    assert.equal(presented.reviews[0].time, '2026-11-10 20:00')
    assert.equal(presented.course.term, academicTerm(2024, 1))
    assert.ok(!('codeId' in presented.course) && !('department' in presented.course))
})

test('plan slots detect overlaps and credits only count known values', () => {
    const monday = {weekday: 1, startUnit: 1, endUnit: 2}
    assert.equal(planSlotsOverlap(monday, {weekday: 1, startUnit: 2, endUnit: 3}), true)
    assert.equal(planSlotsOverlap(monday, {weekday: 1, startUnit: 3, endUnit: 4}), false)
    assert.equal(planSlotsOverlap(monday, {weekday: 2, startUnit: 1, endUnit: 2}), false)
    const base = {groupId: 1, groupName: 'g', teachers: '', term: '', note: '', addedAt: '2026-11-11T00:00:00Z'}
    assert.equal(planCredits([
        {...base, courseId: 1, name: 'a', credit: 4, slot: null},
        {...base, courseId: 2, name: 'b', credit: null, slot: null},
        {...base, courseId: 3, name: 'c'},
    ]), 4)
})

test('semester window ends the day before the next term starts', () => {
    const semesters = [
        {id: '2', name: '2025-2026 学年 春季', startDate: '2026-02-23'},
        {id: '1', name: '2025-2026 学年 秋季', startDate: '2025-09-01'},
        {id: '3', name: '未知学期', startDate: null},
    ]
    assert.deepEqual(semesterWindow(semesters, '1'), {from: '2025-09-01', to: '2026-02-22'})
    assert.deepEqual(semesterWindow(semesters, '2'), {from: '2026-02-23', to: '2026-08-23'})
    // 缺开学日期的学期无法定位，调用方必须退回「不过滤」而不是丢数据
    assert.equal(semesterWindow(semesters, '3'), null)
    assert.equal(semesterWindow(semesters, 'missing'), null)
    assert.equal(semesterWindow([], '1'), null)
})


test('ai search rejects malformed tool arguments before they reach the network', () => {
    const schema = {
        type: 'object',
        properties: {
            query: {type: 'string', maxLength: 200},
            limit: {type: 'integer', minimum: 1, maximum: 10},
        },
        required: ['query'],
    }
    assert.deepEqual(parseToolArgs(schema, JSON.stringify({query: '图书馆', limit: 3})), {query: '图书馆', limit: 3})
    assert.throws(() => parseToolArgs(schema, 'not json'), /JSON/)
    // 未知字段、缺必填、越界、超长都必须在这里被拦住
    assert.throws(() => parseToolArgs(schema, JSON.stringify({query: 'x', evil: 1})), /未知字段/)
    assert.throws(() => parseToolArgs(schema, JSON.stringify({limit: 3})), /缺失/)
    assert.throws(() => parseToolArgs(schema, JSON.stringify({query: 'x', limit: 99})), /上限/)
    assert.throws(() => parseToolArgs(schema, JSON.stringify({query: 'x', limit: 0})), /下限/)
    assert.throws(() => parseToolArgs(schema, JSON.stringify({query: 'a'.repeat(201)})), /长度/)
    assert.throws(() => parseToolArgs(schema, JSON.stringify({query: 5})), /类型/)
    assert.throws(() => parseToolArgs(schema, JSON.stringify(['x'])), /对象/)
})

test('saving a plan keeps credit and the user placed slot', () => {
    const saved = normalizePlanItems([{
        courseId: 28112, groupId: 249, groupName: '概率论 H', name: '概率论 H',
        teachers: '张三', term: '2025-2026 秋季', note: '想上', addedAt: '2026-11-11T00:00:00.000Z',
        credit: 5, slot: {weekday: 1, startUnit: 3, endUnit: 4},
    }])
    assert.equal(saved[0].credit, 5)
    assert.deepEqual(saved[0].slot, {weekday: 1, startUnit: 3, endUnit: 4})
    assert.equal(planCredits(saved), 5)
})

test('plan validation rejects unknown credit and impossible slots without dropping data', () => {
    const base = {
        courseId: 1, groupId: 1, groupName: 'g', name: 'n', teachers: 't', term: 'x', note: '',
        addedAt: '2026-11-11T00:00:00.000Z',
    }
    for (const credit of [-1, 61, 'A', Number.NaN, Number.POSITIVE_INFINITY]) {
        assert.throws(() => normalizePlanItems([{...base, credit}]), /学分无效/)
    }
    for (const slot of [{weekday: 0, startUnit: 1, endUnit: 2}, {weekday: 8, startUnit: 1, endUnit: 2},
        {weekday: 1, startUnit: 3, endUnit: 2}, {weekday: 1, startUnit: 0, endUnit: 2},
        {weekday: 1, startUnit: 1, endUnit: 21}, {weekday: 1.5, startUnit: 1, endUnit: 2}]) {
        assert.throws(() => normalizePlanItems([{...base, slot}]), /时段无效/)
    }
    const kept = normalizePlanItems([{...base, credit: null, slot: null}])
    assert.equal(kept[0].credit, null)
    assert.equal(kept[0].slot, null)
})
