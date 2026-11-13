import {ToolError} from '../shared/agent'

type Fields = Record<string, unknown>

export function parseToolArguments(schema: Record<string, unknown> | undefined, raw: string): Fields {
    if (!schema) throw new ToolError('forbidden', '不支持的工具。')
    let args: unknown
    try {
        args = JSON.parse(raw)
    } catch {
        throw new ToolError('invalid_args', '工具参数不是有效 JSON。')
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new ToolError('invalid_args', '工具参数必须是对象。')
    const input = args as Fields
    const properties = (schema.properties ?? {}) as Fields
    if (Object.keys(input).some(key => !Object.hasOwn(properties, key)) ||
        ((schema.required ?? []) as string[]).some(key => !Object.hasOwn(input, key))) {
        throw new ToolError('invalid_args', '工具参数缺失或包含未知字段。')
    }
    for (const [key, value] of Object.entries(input)) {
        const rule = properties[key] as {
            type?: string | string[];
            enum?: unknown[];
            minimum?: number;
            maximum?: number;
            items?: { type?: string };
        }
        const types = Array.isArray(rule.type) ? rule.type : [rule.type]
        const valid = types.some(type => type === 'null' ? value === null
            : type === 'integer' ? Number.isSafeInteger(value)
                : type === 'array' ? Array.isArray(value)
                    : typeof value === type)
        if (!valid || (rule.enum && !rule.enum.includes(value)) ||
            (typeof value === 'number' && (!Number.isFinite(value) || (rule.minimum !== undefined && value < rule.minimum) || (rule.maximum !== undefined && value > rule.maximum)))) {
            throw new ToolError('invalid_args', `${key} 参数类型或范围无效。`)
        }
        if (Array.isArray(value)) {
            if (value.length > 30) throw new ToolError('invalid_args', `${key} 参数条目过多。`)
            const itemType = rule.items?.type
            if (itemType && value.some(item => itemType === 'integer' ? !Number.isSafeInteger(item) : typeof item !== itemType)) {
                throw new ToolError('invalid_args', `${key} 参数条目类型无效。`)
            }
            if (rule.enum && value.some(item => !rule.enum!.includes(item))) {
                throw new ToolError('invalid_args', `${key} 参数条目无效。`)
            }
        }
    }
    return input
}
