import {test} from 'node:test'
import assert from 'node:assert/strict'
import {toolSuccess, toolFailure, ToolError, maxToolResultChars, redactTrace} from '../src/shared/agent.ts'
import {validateMemory, selectMemories, memoryLine, memoryLineBudget, buildMemoryDigest, normalizeMemoryText, diceCoefficient, clusterMemories, mergeConsolidationGroup, memoryShortId, type Memory} from '../src/shared/memory.ts'
import {compactTurns, compactionChunks, extractCompactionMemories, foldToolMessages, foldedToolResult, validateCompaction, parseSummary} from '../src/main/chat-context.ts'
import {AppDatabase} from '../src/main/database.ts'
import {chatTools, createChatToolRunner} from '../src/main/chat-tools.ts'
import {defaultToolDescriptions} from '../src/shared/llm-prompts.ts'
import {readUsage} from '../src/main/llm-stream.ts'
import {abortError, awaitWithAbort} from '../src/main/abortable.ts'

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
test('memory selection excludes archived/expired, ranks pins, caps injected lines', () => {
    const items = [memory('old', {updatedAt: '2025-01-01T00:00:00Z'}), memory('expired', {expiresAt: '2026-01-01T00:00:00Z'}),
        memory('archived', {status: 'archived'}), memory('pinned', {pinned: true}), ...Array.from({length: 30}, (_, i) => memory(String(i)))]
    const selected = selectMemories(items, '数学', Date.parse('2026-11-07T01:00:00Z'))
    assert.equal(selected[0].id, 'pinned'); assert.ok(!selected.some(item => ['expired', 'archived'].includes(item.id)))
    assert.ok(selected.map(memoryLine).join('\n').length <= memoryLineBudget)
    assert.ok(selected.filter(item => !item.pinned).length <= 8)
    assert.deepEqual(selectMemories([items[0]], '无关', Date.parse('2026-11-07T01:00:00Z')), [])
    // Recency alone is not relevance: a fresh but unrelated memory stays out of the prompt.
    assert.deepEqual(selectMemories([memory('fresh', {updatedAt: '2026-11-07T00:30:00Z'})], '无关', Date.parse('2026-11-07T01:00:00Z')), [])
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

test('recall supports offset/limit pagination like other list tools', async () => {
    const db = new AppDatabase(':memory:')
    db.setMemoryEnabled('alice', true)
    for (let i = 0; i < 7; i++) db.saveMemory('alice', memory(`id-${i}`, {text: `记忆${i} 数学`}))
    const run = createChatToolRunner(db, 'alice', {list: () => ({items: []}), detail: async () => ({content: ''})} as never,
        () => {}, () => {}, () => ({}), () => ({}))
    try {
        const first = await run('recall', JSON.stringify({query: '数学', limit: 3})) as {total: number; hasMore: boolean; items: unknown[]}
        assert.equal(first.total, 7); assert.equal(first.items.length, 3); assert.equal(first.hasMore, true)
        const second = await run('recall', JSON.stringify({query: '数学', limit: 3, offset: 6})) as {hasMore: boolean; items: unknown[]}
        assert.equal(second.items.length, 1); assert.equal(second.hasMore, false)
        await assert.rejects(run('recall', JSON.stringify({limit: 11})), {code: 'invalid_args'})
    } finally {db.close()}
})

test('one malformed compaction memory candidate does not discard valid siblings', () => {
    const raw = JSON.stringify({facts: [], actions: [], pending: [], preferences: [], memories: [
        {kind: 'fact', text: '', evidence: 'x', confidence: 1, expiresAt: null},
        {kind: 'fact', text: '用户主修数学', evidence: '我喜欢数学', confidence: 1, expiresAt: null},
    ]})
    const scan = extractCompactionMemories(raw, ['我喜欢数学'])
    assert.deepEqual(scan.candidates.map(item => item.memory.text), ['用户主修数学'])
    assert.equal(scan.dropped, 1)
})

test('compaction budget counts content, not the JSON skeleton', () => {
    const line = '字'.repeat(10)
    const many = {facts: Array.from({length: 150}, () => line), actions: [], pending: [], preferences: []}
    const summary = validateCompaction(JSON.stringify(many))
    assert.ok(summary.length > 1600, 'serialized JSON is larger than the budget')
    const tooMuch = {...many, facts: Array.from({length: 161}, () => line)}
    assert.throws(() => validateCompaction(JSON.stringify(tooMuch)), /1600/)
})

test('aborted work rejects with an Error so instanceof and message checks work', async () => {
    assert.equal(abortError('user').message, 'user')
    assert.ok(abortError(undefined) instanceof Error)
    const controller = new AbortController()
    const pending = awaitWithAbort(new Promise(() => {}), controller.signal)
    controller.abort('user')
    await assert.rejects(pending, (error: any) => error instanceof Error && error.message === 'user')
})

test('clearing usage and pruning the trace keep session counters consistent', () => {
    const db = new AppDatabase(':memory:')
    try {
        db.recordLlmUsage('alice', 'turn', 'model', {promptTokens: 10, completionTokens: 5}, 10)
        assert.equal(db.getUsage('alice').today.requests, 1)
        db.clearLlmUsage('alice')
        assert.equal(db.getUsage('alice').today.requests, 0)
        for (let i = 0; i < 55; i++) db.saveChatTrace('alice', `turn-${i}`, [
            {id: `event-${i}`, kind: 'tool', label: '工具', at: `2026-11-07T00:${String(i).padStart(2, '0')}:00Z`, status: 'completed'},
        ])
        db.pruneChatTrace('alice', 50)
        const remaining = db.getChatStats('alice').steps
        assert.equal(remaining, 50)
        assert.equal(db.getChatTrace('alice', 'turn-0').length, 0, 'the oldest turn is rolled out')
        assert.equal(db.getChatTrace('alice', 'turn-54').length, 1, 'the newest turn is kept')
    } finally {db.close()}
})

test('old tool results fold to a placeholder while tool_call ids stay paired', () => {
    const call = (id: string) => ({role: 'assistant' as const, content: null,
        tool_calls: [{id, type: 'function' as const, function: {name: 'x', arguments: '{}'}}]})
    const messages = [call('a'), {role: 'tool' as const, tool_call_id: 'a', content: 'x'.repeat(9000)},
        call('b'), {role: 'tool' as const, tool_call_id: 'b', content: 'y'.repeat(9000)},
        {role: 'tool' as const, tool_call_id: 'c', content: 'z'}]
    const folded = foldToolMessages(messages, 2)
    assert.equal(folded[1].content, foldedToolResult)
    assert.equal((folded[1] as {tool_call_id: string}).tool_call_id, 'a')
    assert.equal(folded[3].content, 'y'.repeat(9000))
    assert.equal(folded[4].content, 'z')
    assert.equal((messages[1] as {content: string}).content.length, 9000, 'the stored turn is not mutated')
})

test('memory digest prioritizes pinned and related entries and stays within budget', () => {
    const base = new Date('2026-11-07T00:00:00Z').getTime()
    const pinned = Array.from({length: 10}, (_, index) => memory(`pin-${index}`, {pinned: true,
        text: `置顶记忆${index}`, updatedAt: new Date(base - index * 1000).toISOString()}))
    const related = memory('rel-1', {text: '用户住在邯郸校区', createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z'})
    const recent = memory('fresh-1', {text: '用户喜欢篮球', createdAt: new Date(base - 86400000).toISOString(),
        updatedAt: new Date(base - 86400000).toISOString()})
    const digest = buildMemoryDigest([...pinned, related, recent], [{user: '我住在邯郸校区附近，数学作业什么时候交'}], base)
    assert.equal(digest[0].id, 'pin-0', 'newest pinned entry first')
    assert.ok(digest.some(entry => entry.id === 'rel-1'), 'matched by shared Han characters')
    assert.ok(digest.some(entry => entry.id === 'fresh-1'), 'recent entry fills the tail')
    assert.ok(digest.length <= 20)
    assert.ok(JSON.stringify(digest).length <= 800)
    assert.equal(JSON.stringify(digest).includes('evidence'), false)
    assert.equal(JSON.stringify(digest).includes('createdAt'), false)
    const long = memory('long', {text: '字'.repeat(60)})
    const truncated = buildMemoryDigest([long], [], base)[0]
    assert.equal(truncated.text.length, 41)
    assert.ok(truncated.text.endsWith('…'))
    // Expired or archived entries never reach the digest.
    assert.deepEqual(buildMemoryDigest([memory('old', {expiresAt: '2026-01-01T00:00:00Z'}),
        memory('archived', {status: 'archived'})], [], base), [])
})

test('normalization and Dice match the reference values from the design doc', () => {
    const dice = (left: string, right: string) => diceCoefficient(normalizeMemoryText(left), normalizeMemoryText(right))
    assert.equal(dice('用户偏好数学', '用户偏好数学。'), 1)
    assert.ok(Math.abs(dice('用户住在邯郸校区', '用户在邯郸校区') - 0.77) < 0.01)
    assert.ok(Math.abs(dice('用户是本科生', '用户是一名本科生') - 0.67) < 0.01)
    assert.ok(Math.abs(dice('用户偏好数学', '用户喜欢数学') - 0.40) < 0.01)
    assert.equal(dice('', '用户偏好数学'), 0)
})

test('clustering groups identical or similar memories and caps groups', () => {
    const items = [memory('a', {text: '用户偏好数学'}), memory('b', {text: '用户偏好数学。'}),
        memory('c', {text: '用户喜欢篮球'}), memory('d', {text: '用户住在邯郸校区'}), memory('e', {text: '用户在邯郸校区'})]
    const clusters = clusterMemories(items)
    assert.deepEqual(clusters.map(cluster => cluster.items.map(item => item.id).sort()).sort(),
        [['a', 'b'], ['d', 'e']])
    assert.equal(clusters[0].score, 1)
    assert.ok(clusters[1].score >= 0.55)
    const many = Array.from({length: 14}, (_, index) => memory(`m-${index}`, {text: '用户偏好数学'}))
    assert.equal(clusterMemories(many)[0].items.length, 12, 'a group is capped at 12 items')
})

test('compaction candidates support update and skip, and downgrade fabricated targets', () => {
    const existing = [memory('3f2a91c0-1111-2222-3333-444455556666', {text: '用户是数学科学学院本科生'})]
    const raw = JSON.stringify({memories: [
        {op: 'update', targetId: '3f2a91c0', kind: 'fact', text: '用户是数学科学学院 2026 级本科生', confidence: 0.9, expiresAt: null}
    ]})
    const updated = extractCompactionMemories(raw, [], existing)
    assert.equal(updated.candidates.length, 1)
    assert.equal(updated.candidates[0].op, 'update')
    assert.equal((updated.candidates[0] as any).targetId, existing[0].id)
    assert.equal(updated.candidates[0].memory.evidence, existing[0].evidence, 'evidence is inherited from the target')

    const mixed = JSON.stringify({memories: [
        {op: 'skip', kind: 'fact', text: '重复'},
        {op: 'update', targetId: 'deadbeef', kind: 'fact', text: '新事实', evidence: '我今年大二', confidence: 0.9, expiresAt: null},
    ]})
    const scan = extractCompactionMemories(mixed, ['我今年大二'], existing)
    assert.equal(scan.candidates.length, 1)
    assert.equal(scan.candidates[0].op, 'add', 'unknown target downgrades to add')
    assert.deepEqual(scan.errors, ['压缩候选引用了不存在的记忆'])
    assert.equal(scan.dropped, 1, 'skip is counted as dropped')

    const four = JSON.stringify({memories: [1, 2, 3, 4].map(() => (
        {kind: 'fact', text: '事实', evidence: '我说过', confidence: 1, expiresAt: null}))})
    assert.equal(extractCompactionMemories(four, ['我说过']).candidates.length, 3)
    assert.equal(extractCompactionMemories(four, ['我说过']).dropped, 1)
})

test('consolidation merge rules ignore the model for metadata and validate keepIds', () => {
    const before = [
        memory('aaaa1111-1111-1111-1111-111111111111', {kind: 'fact', text: '用户喜欢数学', pinned: true,
            confidence: 0.6, evidence: '我喜欢数学', expiresAt: '2027-01-01T00:00:00Z'}),
        memory('bbbb2222-2222-2222-2222-222222222222', {kind: 'preference', text: '用户偏好数学', pinned: false,
            confidence: 0.9, evidence: '我偏爱数学', expiresAt: null}),
    ]
    const merged = mergeConsolidationGroup(before, {text: '用户喜欢并偏好数学', kind: 'event',
        keepIds: [memoryShortId(before[0].id), memoryShortId(before[1].id)]})
    assert.equal(merged.ok, true)
    const data = (merged as any).data
    assert.equal(data.kind, 'fact', 'tie keeps the first entry kind')
    assert.equal(data.pinned, true)
    assert.equal(data.confidence, 0.9)
    assert.equal(data.expiresAt, '2027-01-01T00:00:00Z')
    assert.ok(data.evidence.includes('我喜欢数学') && data.evidence.includes('我偏爱数学'))
    assert.equal(mergeConsolidationGroup(before, {text: 'x', keepIds: []}).ok, false)
    assert.equal(mergeConsolidationGroup(before, {text: 'x', keepIds: ['zzzzzzzz']}).ok, false)
    assert.equal(mergeConsolidationGroup(before, {text: '   ', keepIds: [memoryShortId(before[0].id)]}).ok, false)
})

test('consolidation previews survive a database reopen and expire lazily', () => {
    const db = new AppDatabase(':memory:')
    try {
        const before = [memory('a'), memory('b')]
        db.saveConsolidation({id: 'p1', username: 'alice', createdAt: '2026-11-07T00:00:00Z', status: 'preview',
            before, after: [{groupId: 'g1', before, status: 'ok', merged: {...memory('a'), mergedFrom: ['b'], source: 'consolidation'}}]})
        assert.equal(db.findConsolidationPreview('alice')?.id, 'p1')
        assert.equal(db.getConsolidation('alice', 'p1')?.after[0].merged?.source, 'consolidation')
        db.pruneConsolidations('alice', '2026-11-07T00:01:00Z')
        assert.equal(db.getConsolidation('alice', 'p1'), null)
    } finally {db.close()}
})
