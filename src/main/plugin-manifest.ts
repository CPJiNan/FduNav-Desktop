import {extname} from 'node:path'
import {
    pluginApiVersion,
    type PluginManifest,
    pluginOverrides,
    pluginPermissions,
    type PluginServices,
    type PluginView,
    pluginViews
} from '../shared/plugins'

function record(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

const text = (value: unknown, limit: number): value is string =>
    typeof value === 'string' && value.trim().length > 0 && value.length <= limit && !/[\u0000-\u001f]/.test(value)

export function isPluginId(value: unknown): value is string {
    return typeof value === 'string' && value.length <= 64 && /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/.test(value)
}

const isLocalId = (value: unknown): value is string => typeof value === 'string' && /^[a-z][a-z0-9-]{0,47}$/.test(value)

export function isPluginAssetPath(value: unknown): value is string {
    return typeof value === 'string' && value.length <= 1024 && value.split('/').every(part =>
        part.length > 0 && !/[<>:"\\|?*\u0000-\u001f]|[. ]$/.test(part) &&
        !/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part))
}

function entry(value: unknown): string {
    if (!isPluginAssetPath(value) || extname(value).toLowerCase() !== '.html') throw new Error('插件入口必须是包内的 HTML 文件。')
    return value
}

function uniqueList<T>(value: unknown, valid: (item: unknown) => item is T, label: string): T[] {
    if (value === undefined) return []
    if (!Array.isArray(value) || value.length > 32 || !value.every(valid) || new Set(value).size !== value.length) {
        throw new Error(`插件的${label}无效或存在重复项。`)
    }
    return value
}

export function parsePluginManifest(value: unknown): PluginManifest {
    const input = record(value)
    if (input?.apiVersion !== pluginApiVersion) throw new Error(`插件需使用 FduNav 插件 API ${pluginApiVersion}。`)
    const {id, name, version, description} = input
    if (!isPluginId(id) || !text(name, 80) || !text(version, 40) ||
        (description !== undefined && !text(description, 280))) throw new Error('插件的 ID、名称、版本或简介格式无效。')
    const permissions = uniqueList(input.permissions, (item): item is keyof PluginServices =>
        typeof item === 'string' && Object.hasOwn(pluginPermissions, item), '服务权限')
    const views: PluginManifest['views'] = {}
    if (input.views !== undefined) {
        const declared = record(input.views)
        if (!declared) throw new Error('插件界面配置无效。')
        for (const [key, path] of Object.entries(declared)) {
            if (!pluginViews.includes(key as PluginView)) throw new Error(`不支持的插件界面 ${key}。`)
            views[key as PluginView] = entry(path)
        }
    }
    const pages = uniqueList(input.pages, (item): item is Record<string, unknown> => !!record(item), '页面').map(page => {
        if (!isLocalId(page.id) || !text(page.title, 48)) throw new Error('插件页面的 ID 或标题无效。')
        return {id: page.id, title: page.title.trim(), entry: entry(page.entry)}
    })
    if (new Set(pages.map(page => page.id)).size !== pages.length) throw new Error('插件页面 ID 重复。')

    let operations: PluginManifest['operations']
    if (input.operations !== undefined) {
        const declared = record(input.operations)
        if (!declared) throw new Error('插件的操作配置无效。')
        const overrides = uniqueList(declared.overrides, (item): item is typeof pluginOverrides[number] =>
            (pluginOverrides as readonly unknown[]).includes(item), '操作覆盖')
        if (overrides.some(method => !permissions.includes(method.split('.')[0] as keyof PluginServices))) {
            throw new Error('覆盖操作需要声明对应的服务权限。')
        }
        const commands = uniqueList(declared.commands, isLocalId, '命令')
        if (!overrides.length && !commands.length) throw new Error('插件需至少声明一项覆盖操作或命令。')
        operations = {entry: entry(declared.entry), overrides, commands}
    }
    if (!Object.keys(views).length && !pages.length && !operations) throw new Error('插件需提供界面、页面或操作。')
    return {
        apiVersion: pluginApiVersion,
        id,
        name: name.trim(),
        version: version.trim(),
        description,
        permissions,
        views,
        pages,
        operations
    }
}

export function pluginEntries(manifest: PluginManifest): string[] {
    return [...Object.values(manifest.views ?? {}), ...manifest.pages?.map(page => page.entry) ?? [],
        ...manifest.operations ? [manifest.operations.entry] : []]
}
