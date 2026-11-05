import {test} from 'node:test'
import assert from 'node:assert/strict'
import {courseReplayLoginUrl, courseReplayUrl, isReplayLoginPage, matchReplayCourse, parseReplaySchedule, replayToken, replayUser, replayWeeks} from './course-replay-data.ts'

const course = {name: '几何拓扑选讲', teachers: ['测试教师']}
const candidate = {id: '38037', ...course}
const schedule = (items: unknown[]) => ({result: {list: [{course: items}, {}]}})

test('start university SSO using the verified school login endpoint, not the portal SPA', () => {
    const url = new URL(courseReplayLoginUrl())
    assert.equal(url.origin, 'https://icourse.fudan.edu.cn')
    assert.equal(url.pathname, '/casapi/index.php')
    assert.equal(url.searchParams.get('r'), 'auth/login')
    assert.equal(url.searchParams.get('school_login'), '1')
    assert.equal(url.searchParams.get('tenant_code'), '222')
    assert.equal(url.searchParams.get('forward'), 'https://icourse.fudan.edu.cn/coursepage?tenant_code=222')
    assert.equal(url.searchParams.has('auType'), false)
})

test('external browser authentication returns to the matched course without transferring credentials', () => {
    const url = new URL(courseReplayLoginUrl('38037'))
    assert.equal(url.searchParams.get('school_login'), '1')
    assert.equal(url.searchParams.get('forward'), courseReplayUrl('38037'))
    assert.deepEqual([...url.searchParams.keys()].sort(), ['forward', 'r', 'school_login', 'tenant_code'])
    assert.throws(() => courseReplayLoginUrl('38037&forward=https://example.com'))
})

test('keep authentication pages interactive instead of timing out while waiting for a token', () => {
    for (const path of ['/yjlogin', '/yjlogin/', '/yjlogin/?tenant_code=222', '/yjapplogin/', '/validate', '/casapi/index.php?r=auth/login']) {
        assert.equal(isReplayLoginPage(`https://icourse.fudan.edu.cn${path}`), true)
    }
    for (const path of ['/coursepage', '/coursedetail?course_id=38037', '/portal', '/yjlogin-other']) {
        assert.equal(isReplayLoginPage(`https://icourse.fudan.edu.cn${path}`), false)
    }
    assert.equal(isReplayLoginPage('https://example.com/yjlogin/'), false)
    assert.equal(isReplayLoginPage('invalid'), false)
})

test('use the real course identifier for a course-level link', () => {
    assert.equal(courseReplayUrl('38037'), 'https://icourse.fudan.edu.cn/coursedetail?course_id=38037&tenant_code=222')
    for (const id of ['', '0', '-1', 'abc', '38037&tenant_code=333']) assert.throws(() => courseReplayUrl(id))
})

test('parse the official personal weekly schedule and teacher variants', () => {
    assert.deepEqual(parseReplaySchedule(schedule([
        {course_id: 38037, course_title: course.name, teachers: [{realname: '测试教师'}]},
        {course_id: '42', course_title: '其他课程', lecturer_name: '甲,乙'},
        {course_id: '43', course_title: '另一课程', teacher_name: '丙'},
        {course_id: 'bad', course_title: '无效课程'},
    ])), [candidate, {id: '42', name: '其他课程', teachers: ['甲', '乙']}, {id: '43', name: '另一课程', teachers: ['丙']}])
    assert.deepEqual(parseReplaySchedule(schedule([])), [])
    assert.throws(() => parseReplaySchedule({code: 401}))
    assert.throws(() => parseReplaySchedule(schedule([]).result))
    assert.throws(() => parseReplaySchedule({result: {list: [{course: {}}]}}))
})

test('match own teacher and deduplicate repeated lessons by course ID', () => {
    assert.equal(matchReplayCourse([candidate, candidate], course), '38037')
    assert.equal(matchReplayCourse([{...candidate, id: '99', teachers: ['其他教师']}, candidate], course), '38037')
    assert.equal(matchReplayCourse([{...candidate, name: '几何拓扑选讲（另一门）'}, candidate], course), '38037')
    assert.equal(matchReplayCourse([{...candidate, name: ' 几何 拓扑选讲 ', teachers: ['其他教师', '测试教师']}], course), '38037')
})

test('do not guess when teacher evidence is ambiguous or missing', () => {
    assert.equal(matchReplayCourse([candidate, {...candidate, id: '99'}], course), null)
    assert.equal(matchReplayCourse([], course), null)
    assert.equal(matchReplayCourse([{...candidate, teachers: []}], course), null)
    assert.equal(matchReplayCourse([candidate], {...course, teachers: []}), null)
    assert.equal(matchReplayCourse([{...candidate, teachers: ['测试教师甲']}], course), null)
})

test('scope requested weeks to the selected semester, including alternate weeks', () => {
    assert.deepEqual(replayWeeks('2026-09-06', [3, 1, 3]), [
        {start: '2026-09-06', end: '2026-09-12'}, {start: '2026-09-20', end: '2026-09-26'},
    ])
    assert.deepEqual(replayWeeks('2026-12-27', [2]), [{start: '2027-01-03', end: '2027-01-09'}])
    for (const date of [null, '', '2026-02-30', 'invalid']) assert.throws(() => replayWeeks(date, [1]))
    for (const weeks of [[], [0], [-1], [1.5], [61]]) assert.throws(() => replayWeeks('2026-09-06', weeks))
})

test('reject a different school account or tenant before querying courses', () => {
    const identity = {params: {id: 123, account: 'test-student', tenant_id: 222}}
    assert.equal(replayUser(identity, 'test-student'), '123')
    assert.equal(replayUser(identity, 'other-student'), null)
    assert.equal(replayUser({params: {...identity.params, tenant_id: 333}}, 'test-student'), null)
    assert.equal(replayUser({params: {...identity.params, id: null}}, 'test-student'), null)
    assert.equal(replayUser({}, 'test-student'), null)
})

test('read only a well-formed platform token cookie', () => {
    const cookie = 'a:2:{i:0;s:6:"_token";i:1;s:10:"test-token";}'
    assert.equal(replayToken(encodeURIComponent(cookie)), 'test-token')
    assert.equal(replayToken(cookie), 'test-token')
    for (const value of ['', '%invalid', 'unstructured-value', 'a:2:{i:0;s:5:"other";i:1;s:10:"test-token";}']) assert.equal(replayToken(value), '')
})
