import {randomUUID} from 'node:crypto'
import {constants} from 'node:fs'
import {copyFile, lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile} from 'node:fs/promises'
import {isAbsolute, join, relative, sep} from 'node:path'
import type {InstalledPlugin, PluginState} from '../shared/plugins'
import {isPluginAssetPath, parsePluginManifest, pluginEntries} from './plugin-manifest'

interface Package extends InstalledPlugin {
    directory: string
}

interface Catalog {
    installed: Package[]
    application: string | null
}

const packageByteLimit = 256 * 1024 * 1024
const manifestByteLimit = 64 * 1024
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT'

function inside(root: string, path: string) {
    const child = relative(root, path)
    return !!child && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child)
}

async function copyPackage(source: string, target: string) {
    const root = await realpath(source)
    let files = 0
    let bytes = 0

    async function copyDirectory(directory: string, destination: string, prefix = '') {
        await mkdir(destination)
        for (const name of await readdir(directory)) {
            const asset = `${prefix}${name}`
            if (++files > 10_000 || !isPluginAssetPath(asset)) throw new Error('插件包包含过多文件或无效路径。')
            const from = join(directory, name)
            const to = join(destination, name)
            const stat = await lstat(from)
            if ((!stat.isFile() && !stat.isDirectory()) || !inside(root, await realpath(from))) {
                throw new Error('插件包只能包含普通文件和目录。')
            }
            if (stat.isDirectory()) {
                await copyDirectory(from, to, `${asset}/`)
                continue
            }
            bytes += stat.size
            if (bytes > packageByteLimit) throw new Error('插件包不能超过 256 MiB。')
            await copyFile(from, to, constants.COPYFILE_EXCL)
        }
    }

    await copyDirectory(root, target)
}

export class PluginStore {
    private catalog: Catalog = {installed: [], application: null}
    private queue: Promise<unknown> = Promise.resolve()
    private readError: unknown
    private readonly catalogPath: string
    private readonly packagesPath: string

    constructor(root: string) {
        this.catalogPath = join(root, 'catalog.json')
        this.packagesPath = join(root, 'packages')
    }

    async load() {
        try {
            const stored: Catalog = JSON.parse(await readFile(this.catalogPath, 'utf8'))
            const installed = stored.installed.map(item => {
                if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/.test(item.directory) || typeof item.enabled !== 'boolean') {
                    throw new Error('插件目录无效。')
                }
                return {...item, manifest: parsePluginManifest(item.manifest)}
            })
            this.catalog = {
                installed,
                application: installed.some(item => item.enabled && item.manifest.id === stored.application &&
                    item.manifest.views?.app) ? stored.application : null
            }
        } catch (error) {
            if (!missing(error)) this.readError = error
        }
    }

    snapshot(safeMode: boolean): PluginState {
        if (this.readError) throw new Error('无法读取已安装插件的配置。', {cause: this.readError})
        return {
            installed: this.catalog.installed.map(({manifest, enabled}) => ({manifest, enabled})),
            application: this.catalog.application,
            safeMode
        }
    }

    install(source: string) {
        return this.change(async () => {
            if (this.catalog.installed.length >= 64) throw new Error('最多可安装 64 个插件。')
            await mkdir(this.packagesPath, {recursive: true})
            const directory = randomUUID()
            const target = join(this.packagesPath, directory)
            if (!inside(this.packagesPath, target) || inside(await realpath(source), target)) {
                throw new Error('请选择独立的插件包目录。')
            }
            try {
                await copyPackage(source, target)
                const path = join(target, 'plugin.json')
                const stat = await lstat(path).catch((error: unknown) => {
                    if (missing(error)) throw new Error('所选目录缺少 plugin.json。')
                    throw error
                })
                if (!stat.isFile() || stat.size > manifestByteLimit) throw new Error('插件配置文件无效。')
                const manifest = parsePluginManifest(JSON.parse(await readFile(path, 'utf8')))
                if (this.catalog.installed.some(item => item.manifest.id === manifest.id)) throw new Error('此插件 ID 已安装。')
                for (const entry of new Set(pluginEntries(manifest))) {
                    if (!(await lstat(join(target, entry)).catch(() => null))?.isFile()) throw new Error(`插件入口 ${entry} 不存在。`)
                }
                await this.save({
                    ...this.catalog,
                    installed: [...this.catalog.installed, {manifest, directory, enabled: false}]
                })
            } catch (error) {
                await this.deletePackage(directory)
                throw error
            }
        })
    }

    setEnabled(id: string, enabled: boolean) {
        return this.change(async () => {
            const plugin = this.catalog.installed.find(item => item.manifest.id === id)
            if (!plugin) throw new Error('找不到该插件。')
            if (enabled) {
                const views = Object.keys(plugin.manifest.views ?? {}).filter(view => view !== 'app')
                const overrides = plugin.manifest.operations?.overrides ?? []
                const conflict = this.catalog.installed.find(item => item !== plugin && item.enabled && (
                    views.some(view => Object.hasOwn(item.manifest.views ?? {}, view)) ||
                    overrides.some(method => item.manifest.operations?.overrides?.includes(method))
                ))
                if (conflict) throw new Error(`界面或操作已由 ${conflict.manifest.name} 替换，请先停用该插件。`)
            }
            await this.save({
                installed: this.catalog.installed.map(item => item === plugin ? {...item, enabled} : item),
                application: !enabled && this.catalog.application === id ? null : this.catalog.application
            })
        })
    }

    selectApplication(id: string | null) {
        return this.change(async () => {
            if (id !== null && !this.catalog.installed.some(item => item.manifest.id === id && item.enabled && item.manifest.views?.app)) {
                throw new Error('请先启用提供整窗界面的插件。')
            }
            await this.save({...this.catalog, application: id})
        })
    }

    remove(id: string) {
        return this.change(async () => {
            const plugin = this.catalog.installed.find(item => item.manifest.id === id)
            if (!plugin) throw new Error('找不到该插件。')
            await this.save({
                installed: this.catalog.installed.filter(item => item !== plugin),
                application: this.catalog.application === id ? null : this.catalog.application
            })
            await this.deletePackage(plugin.directory)
        })
    }

    async asset(id: string, path: string) {
        const item = this.catalog.installed.find(plugin => plugin.manifest.id === id && plugin.enabled)
        if (!item || !isPluginAssetPath(path)) return null
        const root = join(this.packagesPath, item.directory)
        const resolvedRoot = await realpath(root)
        if (!inside(await realpath(this.packagesPath), resolvedRoot) || (await lstat(root)).isSymbolicLink()) return null
        const file = await realpath(join(root, path))
        if (!inside(resolvedRoot, file) || !(await lstat(file)).isFile()) return null
        return file
    }

    private async save(catalog: Catalog) {
        const temporary = `${this.catalogPath}.${randomUUID()}.tmp`
        try {
            await mkdir(this.packagesPath, {recursive: true})
            await writeFile(temporary, JSON.stringify(catalog), {flag: 'wx'})
            await rename(temporary, this.catalogPath)
            this.catalog = catalog
        } finally {
            await rm(temporary, {force: true}).catch(() => undefined)
        }
    }

    private change<T>(action: () => Promise<T>): Promise<T> {
        const result = this.queue.then(() => {
            this.snapshot(false)
            return action()
        })
        this.queue = result.catch(() => undefined)
        return result
    }

    private async deletePackage(directory: string) {
        const target = join(this.packagesPath, directory)
        if (!inside(this.packagesPath, target)) return
        try {
            const stat = await lstat(target)
            if (stat.isSymbolicLink()) await rm(target)
            else if (inside(await realpath(this.packagesPath), await realpath(target))) await rm(target, {
                recursive: true,
                force: true
            })
        } catch (error) {
            if (!missing(error)) console.error('无法删除插件文件', error)
        }
    }
}
