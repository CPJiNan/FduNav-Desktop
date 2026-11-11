import {test} from 'node:test'
import assert from 'node:assert/strict'
import {dantaHosts, webvpnLoginUrl, webvpnRoute} from '../src/main/webvpn.ts'
import {
    DantaError, maxPostChars, maxReviewChars, nextOffsetFor, parseCampusPosts, parseCourseGroups,
    parseCourseGroup, parseReviews, parseThreadMeta, redactPersonal
} from '../src/main/danta-parse.ts'
import {academicTerm} from '../src/shared/danta.ts'

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
    assert.deepEqual(byName.get('read_campus_thread')!.parameters.required, ['holeId'])
    assert.deepEqual(byName.get('read_course_reviews')!.parameters.required, ['courseId'])
})
