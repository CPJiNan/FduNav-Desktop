import {ToolError} from '../shared/agent'
import type {CampusToolAccess} from './chat-tools'
import {DantaService} from './danta-service'
import {DantaError} from './danta-parse'
import {presentCampusPage, presentCourseGroup, presentCourseReviews, presentCourseSearch} from './danta-present'
import type {ToolErrorCode} from '../shared/agent'

const codes: Record<string, ToolErrorCode> = {
    invalid_input: 'invalid_args',
    not_found: 'not_found',
    login_required: 'forbidden',
    school_login_required: 'forbidden',
    auth: 'forbidden',
    forbidden: 'forbidden',
    timeout: 'transient',
    network: 'transient',
    rate_limited: 'transient',
    unavailable: 'transient',
    too_large: 'invalid_args',
    schema: 'internal',
}

function wrap<T>(work: () => Promise<T>): Promise<T> {
    return work().catch((error: unknown) => {
        if (error instanceof DantaError) throw new ToolError(codes[error.code] ?? 'internal', error.message)
        if (error instanceof ToolError) throw error
        throw new ToolError('internal', '社区服务操作未完成，请稍后重试。')
    })
}

/** 把社区服务适配成 Agent 工具：可用性与错误码在这里统一，网页侧不受影响。 */
export function createCampusToolAccess(service: DantaService): CampusToolAccess {
    return {
        available() {
            const state = service.agentToolState()
            return {ready: state.enabled, reason: state.reason}
        },
        searchPosts: (query, offset, limit) =>
            wrap(async () => presentCampusPage(await service.searchPosts(query, offset, limit))),
        readThread: (holeId, offset, limit) =>
            wrap(async () => presentCampusPage(await service.readThread(holeId, offset, limit))),
        searchCourses: (query, page, pageSize) =>
            wrap(async () => presentCourseSearch(await service.searchCourses(query, page, pageSize))),
        listCourseOfferings: groupId =>
            wrap(async () => presentCourseGroup(await service.courseGroup(groupId))),
        courseReviews: courseId =>
            wrap(async () => presentCourseReviews(await service.courseReviews(courseId))),
    }
}
