import {test} from 'node:test'
import assert from 'node:assert/strict'
import {toolSuccess, toolFailure, ToolError, maxToolResultChars, redactTrace} from '../src/shared/agent.ts'
import {validateMemory, selectMemories, type Memory} from '../src/shared/memory.ts'
import {compactTurns, compactionChunks, validateCompaction, parseSummary} from '../src/main/chat-context.ts'
import {AppDatabase} from '../src/main/database.ts'
import {chatTools, createChatToolRunner} from '../src/main/chat-tools.ts'
import {defaultToolDescriptions} from '../src/shared/llm-prompts.ts'
import {readUsage} from '../src/main/llm-stream.ts'

const budget = {rounds: 3, calls: 10}
test('tool envelope retains small data, bounds oversized result and identifies failure', () => {
    assert.deepEqual(toolSuccess({value: 3}, budget), {ok: true, data: {value: 3}, truncated: false, remaining: budget})
    const result = toolSuccess({text: 'x'.repeat(100000)}, budget)
    assert.equal(result.truncated, true); assert.ok(JSON.stringify(result).length <= maxToolResultChars)
    assert.equal(toolFailure(new ToolError('not_found', 'missing'), budget).code, 'not_found')
    assert.equal(toolFailure(new Error('disk'), budget).code, 'internal')
})
test('trace redaction recursively removes credentials and explicit connection secret', () => {
    // Built at runtime so secret scanners do not flag the fixture itself.
    const secret = ['test-only', 'private', 'value'].join('-')
    const token = ['sk', 'abcdefghijklmnop'].join('-')
    const raw = {Authorization: 'Bearer hello', nested: [{apiKey: 'a', data: `${secret} ${token}`}]}
    const saved = JSON.stringify(redactTrace(raw, [secret]))
    assert.ok(!saved.includes(secret)); assert.ok(!saved.includes('abcdefghijklmnop')); assert.ok(!saved.includes('Bearer hello'))
    assert.ok(saved.includes('[REDACTED]'))
})
const memory = (id: string, extra: Partial<Memory> = {}): Memory => ({id, text: '用户偏好数学', kind: 'preference', confidence: 0.9,
    evidence: '用户说喜欢数学', pinned: false, status: 'active', expiresAt: null, createdAt: '2026-11-07T00:00:00Z', updatedAt: '2026-11-07T00:00:00Z', ...extra})
test('memory validates input and rejects missing evidence, NaN and bad expiry', () => {
    assert.equal(validateMemory(memory('a')).ok, true)
    for (const patch of [{confidence: NaN}, {text: ''}, {evidence: ''}, {expiresAt: 'never'}, {pinned: 'yes'}]) {
        assert.equal(validateMemory({...memory('a'), ...patch}).ok, false)
    }
})
test('memory selection excludes archived/expired, ranks pins, caps exact injected JSON', () => {
    const items = [memory('old', {updatedAt: '2025-01-01T00:00:00Z'}), memory('expired', {expiresAt: '2026-01-01T00:00:00Z'}),
        memory('archived', {status: 'archived'}), memory('pinned', {pinned: true}), ...Array.from({length: 30}, (_, i) => memory(String(i)))]
    const selected = selectMemories(items, '数学', Date.parse('2026-11-07T01:00:00Z'))
    assert.equal(selected[0].id, 'pinned'); assert.ok(!selected.some(item => ['expired', 'archived'].includes(item.id)))
    assert.ok(JSON.stringify(selected).length <= 1200); assert.ok(selected.filter(item => !item.pinned).length <= 8)
    assert.deepEqual(selectMemories([items[0]], '无关', Date.parse('2026-11-07T01:00:00Z')), [])
})
test('context planning keeps full turns including paired tool messages, handles oversized single turn', () => {
    assert.deepEqual(compactTurns([]), {older: [], recent: []})
    const turn = {id: 'one', context: [{role: 'user' as const, content: 'hello'}]}
    assert.equal(compactTurns([turn]).recent.length, 1)
    assert.equal(compactTurns([{id: 'huge', context: [{role: 'user', content: 'x'.repeat(61000)}]}]).older.length, 1)
    const ten = Array.from({length: 10}, (_, i) => ({...turn, id: String(i)}))
    assert.equal(compactTurns(ten).older.length, 0, 'below the threshold nothing is compacted')
    const thirteen = Array.from({length: 13}, (_, i) => ({...turn, id: String(i)}))
    const plan = compactTurns(thirteen)
    assert.equal(plan.older.length, 9, 'at the threshold the eight oldest turns are compacted')
    assert.equal(plan.recent.length, 4, 'the newest four turns stay verbatim')
    const twelve = Array.from({length: 12}, (_, i) => ({...turn, id: String(i)}))
    assert.equal(compactTurns(twelve).recent.length, 4)
    assert.equal(validateCompaction('{"facts":[],"actions":[],"pending":[],"preferences":[]}').length < 1600, true)
    assert.throws(() => validateCompaction('{"facts":["' + 'x'.repeat(1700) + '"],"actions":[],"pending":[],"preferences":[]}'))
})
test('injected summary drops memory candidates and keeps the four summary sections', () => {
    const raw = JSON.stringify({facts: ['a'], actions: [], pending: [], preferences: [],
        memories: [{kind: 'fact', text: 'x', evidence: 'y', confidence: 0.5, expiresAt: null}]})
    const parsed = parseSummary(raw) as Record<string, unknown>
    assert.deepEqual(parsed.facts, ['a'])
    assert.equal('memories' in parsed, false)
    assert.equal(parseSummary(null), null)
    assert.equal(parseSummary('raw text'), 'raw text')
})
test('database isolates memories, usage and rollback; missing usage is not zero', () => {
    const db = new AppDatabase(':memory:')
    try {
        db.saveMemory('alice', memory('a')); assert.equal(db.getMemories('bob').length, 0)
        assert.equal(db.getMemoryEnabled('alice'), false); db.setMemoryEnabled('alice', true); assert.equal(db.getMemoryEnabled('bob'), false)
        assert.throws(() => db.transaction(() => {db.removeMemory('alice', 'a'); throw new Error('fail')}))
        assert.equal(db.getMemories('alice').length, 1)
        db.recordLlmUsage('alice', 'turn', 'model', {promptTokens: null, completionTokens: null}, 45)
        db.recordLlmUsage('alice', 'turn', 'model', {promptTokens: 10, completionTokens: 5}, 55)
        const usage = db.getUsage('alice').today
        assert.equal(usage.promptTokens, 10); assert.equal(usage.requests, 2); assert.equal(usage.missingUsage, 1); assert.equal(usage.elapsedMs, 100)
        assert.equal(db.getUsage('bob').today.requests, 0)
    } finally {db.close()}
})
test('tool runner validates raw args, enforces lookup first, returns full original notice', async () => {
    const db = new AppDatabase(':memory:')
    const notice = {sourceId: 'test', sourceName: 'test', title: 'Math', url: 'https://example.com/n', published: '2026-11-07', read: false}
    const notices = {list: () => ({items: [notice]}), detail: async () => ({content: 'x'.repeat(20000)})}
    const run = createChatToolRunner(db, 'alice', notices as never, () => {}, () => {}, () => ({}), () => ({}))
    try {
        await assert.rejects(run('list_todos', '{'), {code: 'invalid_args'})
        await assert.rejects(run('list_todos', '{"limit":"2"}'), {code: 'invalid_args'})
        await assert.rejects(run('list_todos', '{"extra":true}'), {code: 'invalid_args'})
        await assert.rejects(run('unknown', '{}'), {code: 'forbidden'})
        await assert.rejects(run('get_notice', JSON.stringify({sourceId: notice.sourceId, url: notice.url})), {code: 'forbidden'})
        await run('search_notices', '{}')
        const result = await run('get_notice', JSON.stringify({sourceId: notice.sourceId, url: notice.url})) as {content: string}
        assert.equal(result.content.length, 20000)
        await assert.rejects(run('recall', '{}'), {code: 'forbidden'})
    } finally {db.close()}
})

test('list_todos marks eLearning assignments instead of presenting them as manual todos', async () => {
    const db = new AppDatabase(':memory:')
    const notices = {list: () => ({items: []}), detail: async () => ({content: ''})}
    const base = {
        notes: '', dueDate: '2026-11-10', dueTime: '23:59', reminderMinutes: -1 as const,
        completed: false, createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z'
    }
    db.saveTodo('alice', {id: '11111111-1111-1111-1111-111111111111', title: '第三章习题', ...base,
        elearning: {
            courseId: '1', assignmentId: '2', courseName: '高等数学',
            url: 'https://elearning.fudan.edu.cn/courses/1/assignments/2', status: '未提交',
            submittedAt: null, attempts: 0, syncedAt: '2026-11-07T00:00:00Z'
        }})
    db.saveTodo('alice', {id: '22222222-2222-2222-2222-222222222222', title: '买书', ...base})
    const run = createChatToolRunner(db, 'alice', notices as never, () => {}, () => {}, () => ({}), () => ({}))
    try {
        const result = await run('list_todos', '{}') as {items: Array<Record<string, any>>}
        const assignment = result.items.find(item => item.title === '第三章习题')!
        const manual = result.items.find(item => item.title === '买书')!
        assert.equal(assignment.source, 'elearning')
        assert.equal(assignment.elearning.courseName, '高等数学')
        assert.equal(assignment.elearning.status, '未提交')
        assert.match(assignment.elearning.label, /eLearning 作业/)
        assert.equal(manual.source, 'manual')
        assert.equal(manual.elearning, undefined)
        assert.match(defaultToolDescriptions.list_todos, /source=elearning/)
    } finally {db.close()}
})

test('commit callbacks run only after the outermost commit and are discarded on rollback', () => {
    const db = new AppDatabase(':memory:'); const seen: number[] = []
    try {
        assert.throws(() => db.transaction(() => {db.afterCommit(() => seen.push(0)); throw new Error('rollback')}))
        assert.equal(seen.length, 0)
        db.transaction(() => {
            db.afterCommit(() => seen.push(1))
            db.transaction(() => db.afterCommit(() => seen.push(2)))
            assert.equal(seen.length, 0)
        })
        assert.deepEqual(seen, [1, 2])
    } finally {db.close()}
})

test('trace detail updates preserve historical payload while keeping snapshots small', () => {
    const db = new AppDatabase(':memory:')
    try {
        db.saveChatTrace('alice', 'turn', [{id: 'event', kind: 'tool', label: '读通知', at: 'now', status: 'running', details: {raw: 'x'.repeat(20000)}}])
        db.saveChatTrace('alice', 'turn', [{id: 'event', kind: 'tool', label: '读通知', at: 'now', status: 'completed'}])
        assert.equal((db.getChatTrace('alice', 'turn')[0].details as any).raw.length, 20000)
        assert.equal(db.getChatTrace('alice', 'turn')[0].status, 'completed')
        assert.equal(db.getChatTrace('bob', 'turn').length, 0)
        db.clearChatTrace('alice'); assert.equal(db.getChatTrace('alice', 'turn').length, 0)
    } finally {db.close()}
})

test('remember defaults optional fields; only kind/text/evidence stay required', async () => {
    const db = new AppDatabase(':memory:')
    db.setMemoryEnabled('alice', true)
    const actions: any[] = []
    const run = createChatToolRunner(db, 'alice', {list: () => ({items: []}), detail: async () => ({content: ''})} as never,
        () => {}, () => {}, () => ({}), action => {actions.push(action); return {}})
    try {
        const schema = chatTools.find(item => item.function.name === 'remember')!.function.parameters
        assert.deepEqual(schema.required, ['kind', 'text', 'evidence'])
        await run('remember', JSON.stringify({kind: 'fact', text: '主修数学', evidence: '我主修数学'}))
        assert.deepEqual(actions[0].memory, {kind: 'fact', text: '主修数学', evidence: '我主修数学',
            confidence: 0.6, pinned: false, expiresAt: null, status: 'active'})
        // The tool schema keeps a single string type for gateway compatibility.
        assert.equal((chatTools.find(item => item.function.name === 'remember')!.function.parameters.properties as any).expiresAt.type,
            'string')
    } finally {db.close()}
})

test('recall returns compact memory DTOs and forget resolves the short id', async () => {
    const db = new AppDatabase(':memory:')
    db.setMemoryEnabled('alice', true)
    const full = 'abcdef12-3456-7890-abcd-ef1234567890'
    db.saveMemory('alice', memory(full))
    const actions: any[] = []
    const run = createChatToolRunner(db, 'alice', {list: () => ({items: []}), detail: async () => ({content: ''})} as never,
        () => {}, () => {}, () => ({}), action => {actions.push(action); return {}})
    try {
        const recalled = await run('recall', '{}') as {items: unknown[]}
        assert.deepEqual(recalled.items, [{id: 'abcdef12', kind: 'preference', text: '用户偏好数学'}])
        await run('forget', JSON.stringify({id: 'abcdef12'}))
        assert.equal(actions[0].kind, 'forget'); assert.equal(actions[0].memory.id, full)
        db.saveMemory('alice', memory('abcdef99-3456-7890-abcd-ef1234567890'))
        await assert.rejects(run('forget', JSON.stringify({id: 'abcdef'})), {code: 'invalid_args'})
    } finally {db.close()}
})

test('tool results are model-facing DTOs without persisted timestamps or UI-only fields', async () => {
    const db = new AppDatabase(':memory:')
    const notices = {list: () => ({items: [{sourceId: 's', sourceName: '数学学院', title: '讲座', url: 'https://example.com/n',
        published: '2026-11-07', read: false, relevance: 'related' as const}]}), detail: async () => ({content: '正文'})}
    db.saveTodo('alice', {id: '11111111-1111-1111-1111-111111111111', title: '买书', notes: '', dueDate: '2026-11-10',
        dueTime: '23:59', reminderMinutes: -1, completed: false, createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z'})
    db.saveCalendarEvent('alice', {id: '22222222-2222-2222-2222-222222222222', title: '组会', startDate: '2026-11-10',
        endDate: '2026-11-10', startTime: '14:00', endTime: '15:00', allDay: false, reminderMinutes: -1, location: '', notes: ''})
    const run = createChatToolRunner(db, 'alice', notices as never, () => {}, () => {}, () => ({}), () => ({}))
    try {
        const todo = (await run('list_todos', '{}') as {items: Array<Record<string, unknown>>}).items[0]
        assert.deepEqual(Object.keys(todo).sort(), ['completed', 'dueDate', 'dueTime', 'id', 'kind', 'notes', 'source', 'title'])
        const event = await run('get_event', JSON.stringify({id: '22222222-2222-2222-2222-222222222222'})) as Record<string, unknown>
        assert.deepEqual(Object.keys(event).sort(),
            ['allDay', 'endDate', 'endTime', 'id', 'kind', 'location', 'notes', 'startDate', 'startTime', 'title'])
        const notice = (await run('search_notices', '{}') as {items: Array<Record<string, unknown>>}).items[0]
        assert.deepEqual(Object.keys(notice).sort(), ['published', 'relevance', 'sourceId', 'sourceName', 'title', 'url'])
    } finally {db.close()}
})

test('timed events with empty start or end time fail in the tool layer', async () => {
    const db = new AppDatabase(':memory:')
    const run = createChatToolRunner(db, 'alice', {list: () => ({items: []})} as never, () => {}, () => {}, () => ({}), () => ({}))
    try {
        const base = {title: '组会', startDate: '2026-11-10', endDate: '2026-11-10', allDay: false}
        await assert.rejects(run('create_event', JSON.stringify({...base, startTime: '', endTime: ''})), {code: 'invalid_args'})
        await assert.rejects(run('create_event', JSON.stringify({...base, startTime: '14:00'})), {code: 'invalid_args'})
    } finally {db.close()}
})

test('oversized tool results return a shape summary instead of a truncated JSON preview', () => {
    const data = {items: Array.from({length: 3000}, (_, i) => ({id: i, text: 'x'.repeat(20)})), total: 3000, hasMore: true}
    const result = toolSuccess(data, budget)
    assert.equal(result.truncated, true)
    const payload = result.data as Record<string, any>
    assert.equal('preview' in payload, false, 'a half-serialized JSON fragment must never be returned')
    assert.equal(payload.shape.kind, 'object')
    assert.equal(payload.shape.itemCount, 3000)
    assert.equal(payload.shape.total, 3000)
    assert.equal(payload.shape.hasMore, true)
    assert.match(String(payload.message), /结构摘要/)
    assert.ok(JSON.stringify(result).length <= maxToolResultChars)
})

test('compaction tolerates a JSON fence, missing sections and unknown keys', () => {
    const raw = '```json\n{"facts":["用户是本科生"],"preferences":["喜欢数学"],"note":"ignored"}\n```'
    const summary = JSON.parse(validateCompaction(raw)) as Record<string, unknown>
    assert.deepEqual(summary.facts, ['用户是本科生'])
    assert.deepEqual(summary.actions, [])
    assert.deepEqual(summary.pending, [])
    assert.deepEqual(summary.preferences, ['喜欢数学'])
    assert.equal('note' in summary, false)
    assert.throws(() => validateCompaction('{"facts":"not-an-array"}'))
    assert.throws(() => validateCompaction('not json'))
})

test('compaction input is split into turn-aligned bounded chunks', () => {
    const turns = Array.from({length: 6}, (_, i) => ({id: String(i),
        context: [{role: 'user' as const, content: 'x'.repeat(10000)}]}))
    const chunks = compactionChunks(turns)
    assert.equal(chunks.length, 3, 'two ~10k turns fit in one 24k chunk')
    assert.deepEqual(chunks.flat().map(turn => turn.id), ['0', '1', '2', '3', '4', '5'])
    assert.deepEqual(compactionChunks([]), [])
})

test('trace steps are counted incrementally instead of scanning data with LIKE', () => {
    const db = new AppDatabase(':memory:')
    try {
        db.saveChatTrace('alice', 'turn', [
            {id: 'tool-1', kind: 'tool', label: '工具', at: 'now', status: 'running'},
            {id: 'model-1', kind: 'model', label: '模型', at: 'now', status: 'completed'},
        ])
        assert.equal(db.getChatStats('alice').steps, 1)
        // Updating the same event must not double count.
        db.saveChatTrace('alice', 'turn', [{id: 'tool-1', kind: 'tool', label: '工具', at: 'now', status: 'completed'}])
        assert.equal(db.getChatStats('alice').steps, 1)
        db.saveChatTrace('alice', 'turn-2', [{id: 'tool-2', kind: 'tool', label: '工具', at: 'now', status: 'completed'}])
        assert.equal(db.getChatStats('alice').steps, 2)
        db.clearChatTrace('alice')
        assert.equal(db.getChatStats('alice').steps, 0)
    } finally {db.close()}
})
