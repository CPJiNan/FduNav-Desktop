import type {MailFolder, MailFolderRole, MailScope} from './mail'

const uses: Record<string, MailFolderRole> = {inbox: 'inbox', sent: 'sent', drafts: 'drafts', trash: 'trash', junk: 'junk', archive: 'archive', all: 'all', flagged: 'starred'}
const aliases: [MailFolderRole, RegExp][] = [
    ['sent', /^(?:sent(?: messages| items| mail)?|已发送|已发送邮件)$/i],
    ['drafts', /^(?:drafts?|草稿|草稿箱)$/i],
    ['trash', /^(?:trash|deleted(?: messages| items)?|已删除|已删除邮件|废纸篓)$/i],
    ['junk', /^(?:junk(?: e-?mail)?|spam|垃圾邮件)$/i],
    ['archive', /^(?:archives?|归档|归档邮件)$/i],
]
function purpose(folder: MailFolder): {role: MailFolderRole; priority: number} | null {
    if (folder.selectable === false) return null
    if (folder.path.toUpperCase() === 'INBOX') return {role: 'inbox', priority: 100}
    const marked = uses[(folder.specialUse ?? '').replace(/^\\/, '').toLowerCase()]
    if (marked) return {role: marked, priority: 90}
    if (folder.specialUse) return null
    // Restrict name fallbacks to root/provider namespaces, never arbitrary user subfolders.
    const name = folder.path.replace(/^(?:\[Gmail\]|\[Google Mail\]|INBOX)[/.]/i, '')
    const match = aliases.find(([, pattern]) => pattern.test(name))
    return match ? {role: match[0], priority: 30} : null
}

export function isMailDraftFolder(folder: MailFolder): boolean {return purpose(folder)?.role === 'drafts'}

export function resolveMailFolders(folders: MailFolder[]): MailFolder[] {
    const chosen = new Map<string, {path: string; priority: number}>()
    for (const folder of folders) {
        const candidate = purpose(folder)
        if (!candidate) continue
        const key = JSON.stringify([folder.accountId, candidate.role]), previous = chosen.get(key)
        if (!previous || candidate.priority > previous.priority || (candidate.priority === previous.priority && folder.path < previous.path)) {
            chosen.set(key, {path: folder.path, priority: candidate.priority})
        }
    }
    return folders.map(folder => {
        const candidate = purpose(folder)
        return {...folder, role: candidate && chosen.get(JSON.stringify([folder.accountId, candidate.role]))?.path === folder.path ? candidate.role : null}
    })
}

export function mailFoldersForScope(folders: MailFolder[], scope: MailScope): MailFolder[] {
    const resolved = resolveMailFolders(folders).filter(folder => folder.selectable !== false)
    if (scope !== 'all' && scope !== 'starred') return resolved.filter(folder => folder.role === scope)
    const starred = scope === 'starred' ? resolved.filter(folder => folder.role === 'starred') : []
    const starredAccounts = new Set(starred.map(folder => folder.accountId))
    const all = resolved.filter(folder => folder.role === 'all' && !starredAccounts.has(folder.accountId)), covered = new Set([...all, ...starred].map(folder => folder.accountId))
    return [...starred, ...all, ...resolved.filter(folder => !covered.has(folder.accountId) && !['trash', 'junk', 'drafts', 'starred'].includes(purpose(folder)?.role ?? ''))]
}

export interface MailFolderNode {key: string; label: string; folder?: MailFolder; children: MailFolderNode[]}
export function mailFolderTree(folders: MailFolder[]): MailFolderNode[] {
    const resolved = resolveMailFolders(folders), roots: MailFolderNode[] = []
    for (const folder of resolved.filter(folder => !folder.role && folder.selectable !== false).sort((a, b) => a.path.localeCompare(b.path))) {
        const delimiter = folder.delimiter, parts = delimiter ? folder.path.split(delimiter).filter(Boolean) : [folder.name || folder.path]
        let prefix = ''
        // A custom child of INBOX stays visible without repeating the system INBOX as a group.
        if (delimiter) {
            const parent = resolved.filter(value => value.role && value.accountId === folder.accountId && folder.path.startsWith(value.path + delimiter))
                .sort((a, b) => b.path.length - a.path.length)[0]
            if (parent) {parts.splice(0, parent.path.split(delimiter).filter(Boolean).length); prefix = parent.path}
        }
        let children = roots
        parts.forEach((label, index) => {
            prefix += (prefix ? '\u0000' : '') + label
            const key = JSON.stringify([folder.accountId, prefix])
            let node = children.find(value => value.key === key)
            if (!node) {node = {key, label, children: []}; children.push(node)}
            if (index === parts.length - 1) node.folder = folder
            children = node.children
        })
    }
    return roots
}
