import {DantaError} from './danta-parse'
import type {PlanItem, PlanSlot} from '../shared/danta'

/** 校验并重建备选清单。学分与自排时段必须原样保留（评审 B01）。 */
export function normalizePlanItems(value: unknown): PlanItem[] {
    if (!Array.isArray(value) || value.length > 60) throw new DantaError('invalid_input', '备选清单格式无效。')
    const items: PlanItem[] = []
    const seen = new Set<number>()
    for (const entry of value) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new DantaError('invalid_input', '备选清单格式无效。')
        const item = entry as Record<string, unknown>
        const courseId = Number(item.courseId), groupId = Number(item.groupId)
        if (!Number.isSafeInteger(courseId) || courseId < 1 || !Number.isSafeInteger(groupId) || groupId < 1 || seen.has(courseId)) {
            throw new DantaError('invalid_input', '备选清单中的课程编号无效。')
        }
        const str = (key: string, max: number) => {
            const raw = item[key]
            if (typeof raw !== 'string' || raw.length > max) throw new DantaError('invalid_input', '备选清单中的课程信息无效。')
            return raw
        }
        // 学分与自排时段是方案的核心数据，必须原样写回；历史上这里重建对象时把它们丢了，
        // 表现为保存后时段消失、学分统计归零（评审 B01）。
        const creditRaw = item.credit
        let credit: number | null = null
        if (creditRaw !== undefined && creditRaw !== null) {
            if (typeof creditRaw !== 'number' || !Number.isFinite(creditRaw) || creditRaw < 0 || creditRaw > 60) {
                throw new DantaError('invalid_input', '备选清单中的学分无效。')
            }
            credit = creditRaw
        }
        const slotRaw = item.slot
        let slot: PlanSlot | null = null
        if (slotRaw !== undefined && slotRaw !== null) {
            if (typeof slotRaw !== 'object' || Array.isArray(slotRaw)) throw new DantaError('invalid_input', '备选清单中的时段无效。')
            const raw = slotRaw as Record<string, unknown>
            const weekday = Number(raw.weekday), startUnit = Number(raw.startUnit), endUnit = Number(raw.endUnit)
            if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7 ||
                !Number.isInteger(startUnit) || !Number.isInteger(endUnit) ||
                startUnit < 1 || endUnit < startUnit || endUnit > 20) {
                throw new DantaError('invalid_input', '备选清单中的时段无效。')
            }
            slot = {weekday, startUnit, endUnit}
        }
        seen.add(courseId)
        items.push({
            courseId, groupId,
            groupName: str('groupName', 200), name: str('name', 200), teachers: str('teachers', 200),
            term: str('term', 100), note: str('note', 500),
            addedAt: typeof item.addedAt === 'string' && !Number.isNaN(Date.parse(item.addedAt)) ? item.addedAt : new Date().toISOString(),
            credit, slot,
        })
    }
    return items
}
