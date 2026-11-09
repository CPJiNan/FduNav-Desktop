export const defaultChatPrompt = '你是 FduNav 校园助手。'

export const defaultConnectionTestPrompt = 'Reply with only OK.'

export const defaultToolDescriptions = {
    "remember": "请求保存记忆。",
    "recall": "查询已保存且有效的记忆。",
    "forget": "请求删除记忆。展示审批卡片。",
    "search_notices": "检索已启用来源的通知标题：关键词按空格拆分，结果按发布时间倒序，返回通知卡片。若无结果，可建议用户刷新通知。",
    "get_notice": "读取检索结果中的通知正文。",
    "generate_notice_summary": "为本轮已检索到的通知创建 AI 摘要请求卡片。返回 requestId 和请求状态；pending 表示等待。同一通知不重复请求。",
    "list_events": "查询日历中的日程、考试和课程，按开始时间升序。不查询待办列表。返回卡片及课表状态。",
    "get_event": "通过日程 ID 获取详情及卡片。",
    "create_event": "请求新建日程。缺少起止时间时询问，用户明确要求待办/TODO 时禁止使用。展示审批卡片。",
    "list_todos": "查询待办/TODO 列表。不查询日历。返回 kind=todo 的记录。",
    "create_todo": "请求新增待办/TODO。用户明确要求日程时禁止使用。展示审批卡片。",
    "update_todo": "请求修改待办。展示审批卡片。",
    "delete_todo": "请求删除待办。展示审批卡片。",
    "update_event": "请求修改日程。展示审批卡片。",
    "delete_event": "请求删除日程。展示审批卡片。"
} as const

export type ChatToolName = keyof typeof defaultToolDescriptions

export interface AdditionalLlmPrompts {
    chatPrompt: string
    connectionTestPrompt: string
    toolDescriptions: Record<ChatToolName, string>
}

export const defaultAdditionalLlmPrompts = (): AdditionalLlmPrompts => ({
    chatPrompt: defaultChatPrompt,
    connectionTestPrompt: defaultConnectionTestPrompt, toolDescriptions: {...defaultToolDescriptions},
})
