import {test} from 'node:test'
import assert from 'node:assert/strict'
import {apiUrl, assignmentTodo, fetchAssignments, readPages, type ServiceRead} from './elearning.ts'

const course = {id: 11, name: '测试课程'}
const assignment = {id: 22, name: '作业一', due_at: '2026-11-06T15:59:00Z'}
const now = '2026-11-04T00:00:00Z'
const submission = {assignment_id: 22, workflow_state: 'unsubmitted', submitted_at: null, attempt: 0}
const make = (overrides = {}) => assignmentTodo(course, assignment, {...submission, ...overrides}, undefined, 120, now)

test('completion follows the current submission, including reopened and excused work', () => {
    assert.equal(make().completed, false)
    for (const workflow_state of ['submitted', 'pending_review', 'graded']) assert.equal(make({workflow_state}).completed, true)
    assert.equal(make({excused: true}).completed, true)
    assert.equal(make({submitted_at: now, workflow_state: 'unsubmitted'}).completed, false)
    assert.throws(() => make({workflow_state: 'unexpected'}))
    assert.throws(() => make({assignment_id: 99}))
})

test('stable IDs deduplicate courses and preserve creation time/reminders', () => {
    const previous = {...make(), reminderMinutes: 30 as const}
    const next = assignmentTodo(course, {...assignment, name: '更新标题'}, submission, previous, 120, '2026-11-05T00:00:00Z')
    assert.equal(next.id, previous.id)
    assert.equal(next.createdAt, previous.createdAt)
    assert.equal(next.reminderMinutes, 30)
    assert.notEqual(assignmentTodo({...course, id: 12}, assignment, submission, undefined, 120, now).id, previous.id)
})

test('student deadline override and no-deadline assignments', () => {
    assert.equal(make({cached_due_date: null}).dueDate, '')
    assert.equal(make({cached_due_date: '2026-11-09T12:00:00Z'}).dueDate, '2026-11-09')
    assert.throws(() => make({cached_due_date: 'invalid'}))
})

test('pagination follows Link even when the server returns a short page', async () => {
    const calls: string[] = []
    const read: ServiceRead = async (url, parse) => {
        calls.push(url)
        return calls.length === 1 ? parse('[{"id":1}]', '<https://elearning.fudan.edu.cn/api/v1/courses?page=2>; rel="next"') : parse('[{"id":2}]')
    }
    assert.equal((await readPages(read, '/api/v1/courses')).length, 2)
    assert.equal(calls.length, 2)
})

test('reject external pagination, cycles and login HTML', async () => {
    assert.throws(() => apiUrl('https://evil.example/api/v1/courses'))
    assert.throws(() => apiUrl('https://user@elearning.fudan.edu.cn/api/v1/courses'))
    const cyclic: ServiceRead = async (_url, parse) => parse('[]', '<https://elearning.fudan.edu.cn/api/v1/courses>; rel="next"')
    await assert.rejects(readPages(cyclic, '/api/v1/courses'))
    const login: ServiceRead = async (_url, parse) => parse('<html>Login</html>')
    await assert.rejects(readPages(login, '/api/v1/courses'))
})

test('fetch current student submissions and exclude unpublished/non-graded assignments', async () => {
    const read: ServiceRead = async (url, parse) => {
        if (url.endsWith('/dash')) return parse('<html>Dashboard</html>')
        if (url.includes('/submissions/self')) return parse(JSON.stringify(submission))
        if (url.includes('/assignments?')) return parse(JSON.stringify([assignment,
            {...assignment, id: 23, published: false}, {...assignment, id: 24, submission_types: ['not_graded']}]))
        return parse(JSON.stringify([course]))
    }
    const result = await fetchAssignments(read)
    assert.equal(result.length, 1)
    assert.deepEqual(result[0].submission, submission)
})

test('a failed course request rejects the snapshot instead of returning partial work', async () => {
    const read: ServiceRead = async (url, parse) => {
        if (url.endsWith('/dash')) return parse('')
        if (url.includes('/courses/12/')) throw new Error('network failure')
        if (url.includes('/assignments?')) return parse(JSON.stringify([{...assignment, submission}]))
        return parse(JSON.stringify([course, {...course, id: 12}]))
    }
    await assert.rejects(fetchAssignments(read), /network failure/)
})
