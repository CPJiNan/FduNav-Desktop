import {load} from 'cheerio'
import type {BrowserWindow} from 'electron'
import type {AppDatabase} from './database'
import type {AccountService} from './accounts'
import {
    campusOptions,
    departments,
    genderOptions,
    type MessagePreferences,
    preferenceLimits,
    validateMessagePreferences,
    validateRequiredMessagePreferences,
} from '../shared/message-preferences'

const myFudanUrl = 'https://my.fudan.edu.cn/'

function clean(value: string): string {
    return value.replace(/\s+/g, ' ').trim()
}

function collectPairs(html: string): Map<string, string> {
    const $ = load(html)
    const pairs = new Map<string, string>()
    const add = (label: string, value: string) => {
        const key = clean(label).replace(/[：:]\s*$/, '')
        const text = clean(value)
        if (key && text && !pairs.has(key)) pairs.set(key, text)
    }
    $('tr').each((_, row) => {
        const cells = $(row).find('th,td').map((__, cell) => clean($(cell).text())).get()
        for (let index = 0; index < cells.length - 1; index++) {
            if (cells[index].length <= 20) add(cells[index], cells[index + 1])
        }
    })
    $('dt').each((_, term) => {
        const definition = $(term).next('dd')
        if (definition.length) add($(term).text(), definition.text())
    })
    $('[class*="label"], [class*="title"]').each((_, label) => {
        if ($(label).children().length) return
        const value = $(label).next()
        if (value.length && value.children().length <= 2) add($(label).text(), value.text())
    })
    return pairs
}

function findValue(pairs: Map<string, string>, text: string, labels: string[]): string {
    for (const label of labels) {
        for (const [key, value] of pairs) {
            if (key === label || key.includes(label) || label.includes(key)) return value
        }
    }
    for (const label of labels) {
        const match = text.match(new RegExp(`${label}\\s*[：:]\\s*([^\\s，,；;|]{1,40})`))
        if (match) return clean(match[1])
    }
    return ''
}

function parseGrade(value: string): number | null {
    const match = value.match(/(?:19|20)\d{2}/)
    if (!match) return null
    const grade = Number(match[0])
    return grade >= preferenceLimits.minYear && grade <= preferenceLimits.maxYear ? grade : null
}

export function parseMyFudanPreferences(html: string): Partial<MessagePreferences> {
    const pairs = collectPairs(html)
    const text = clean(load(html)('body').text())
    const result: Partial<MessagePreferences> = {}

    const identity = findValue(pairs, text, ['身份类别', '人员类别', '身份'])
    if (/学生|本科生|研究生/.test(identity)) result.identity = 'student'
    else if (/教职|教师|职工/.test(identity)) result.identity = 'staff'

    const gender = findValue(pairs, text, ['性别'])
    const genderOption = genderOptions.find(option => gender.includes(option.label))
    if (genderOption) result.gender = genderOption.value

    const departmentText = findValue(pairs, text, ['院系', '学院', '所在单位', '单位'])
    const department = departments.find(value => departmentText.includes(value))
    if (department) result.department = department

    const education = findValue(pairs, text, ['学历阶段', '培养层次', '学生类别', '学历'])
    if (/博士/.test(education)) result.educationLevel = 'doctoral'
    else if (/硕士/.test(education)) result.educationLevel = 'master'
    else if (/本科/.test(education)) result.educationLevel = 'undergraduate'

    const grade = parseGrade(findValue(pairs, text, ['年级', '入学年份', '入学时间']))
    if (grade !== null) result.grade = grade

    const major = clean(findValue(pairs, text, ['专业名称', '专业']))
    if (major && major.length <= preferenceLimits.majorLength) result.major = major

    const campusText = findValue(pairs, text, ['校区', '所在校区'])
    const campus = campusOptions.find(value => campusText.includes(value) || campusText.includes(value.replace('校区', '')))
    if (campus) result.campus = campus

    return result
}

function profileUrl(html: string): string | null {
    const $ = load(html)
    const link = $('a').filter((_, element) =>
        /个人信息|我的信息|个人资料/.test(clean($(element).text()))).first().attr('href')
    if (!link) return null
    try {
        const url = new URL(link, myFudanUrl)
        return url.origin === new URL(myFudanUrl).origin ? url.href : null
    } catch {
        return null
    }
}

export async function syncMyFudanPreferences(accounts: AccountService, db: AppDatabase,
                                             parent?: BrowserWindow): Promise<MessagePreferences> {
    const owner = db.getAccount()
    const existing = db.getMessagePreferences()
    if (validateRequiredMessagePreferences(existing).ok) return existing

    const html = await accounts.withServiceSession(async read => {
        let page = await read(myFudanUrl, text => text)
        const next = profileUrl(page)
        if (next) page = await read(next, text => text)
        return page
    }, parent)

    let parsed = parseMyFudanPreferences(html)
    const rendered = await accounts.readMyFudanPage()
    if (rendered) parsed = {...parsed, ...parseMyFudanPreferences(rendered)}
    const current = db.getAccount()
    if (!owner || current?.username !== owner.username || current.last_login !== owner.last_login) return db.getMessagePreferences()
    const latest = db.getMessagePreferences()
    if (!Object.keys(parsed).length) return latest
    const unchanged = Object.entries(parsed).filter(([field]) =>
        latest[field as keyof MessagePreferences] === existing[field as keyof MessagePreferences])
    const checked = validateMessagePreferences({...latest, ...Object.fromEntries(unchanged)})
    return checked.ok ? db.setMessagePreferences(checked.data) : latest
}
