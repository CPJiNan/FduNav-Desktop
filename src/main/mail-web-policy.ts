import {fudanStudentMail} from '../shared/mail'
export const fudanWebmailUrl = fudanStudentMail.webmailUrl
const webmailHosts = new Set(['mail.m.fudan.edu.cn', 'exmail.qq.com', 'mail.fudan.edu.cn', 'uis.fudan.edu.cn', 'id.fudan.edu.cn'])
export function isWebmailNavigation(value: string): boolean {
    if (value === 'about:blank') return true
    try {
        const url = new URL(value)
        if (url.protocol === 'blob:') return isWebmailNavigation(url.origin)
        return url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443') && webmailHosts.has(url.hostname)
    } catch {return false}
}
export function isExternalMailLink(value: string): boolean {
    try {const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password} catch {return false}
}
