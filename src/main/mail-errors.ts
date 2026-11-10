export class MailError extends Error {
    constructor(public code: 'invalid_args' | 'forbidden' | 'transient' | 'not_found' | 'send_unknown', message: string) {super(message); this.name = 'MailError'}
}
export function safeMailError(error: unknown, action = '访问邮箱'): MailError {
    if (error instanceof MailError) return error
    const v = error as {authenticationFailed?: boolean; code?: unknown; responseText?: unknown; responseStatus?: unknown; serverResponseCode?: unknown}
    const code = typeof v?.code === 'string' ? v.code : ''
    if (v?.authenticationFailed || /AUTH|EAUTH|LOGIN/i.test(code)) {
        // Classify privately; raw server replies can contain credentials or session identifiers.
        const reply = typeof v.responseText === 'string' ? v.responseText.slice(0, 8192) : ''
        let reason = '请确认已开启 IMAP/SMTP，并核对客户端专用密码。'
        if (/too many (?:login |authentication )?(?:attempts|connections)|rate[ -]?limit|登录过于频繁/i.test(reply)) reason = '登录尝试过于频繁，请稍后再试。'
        else if (/contact.{0,24}(?:administrator|admin)|联系.{0,12}管理员/i.test(reply)) reason = '服务器要求联系邮箱管理员，请核查客户端访问权限。'
        else if (/(?:IMAP|protocol).{0,24}(?:disabled|not enabled|closed)/i.test(reply)) reason = '请在官方邮箱设置中开启 IMAP/SMTP 服务并保存。'
        return new MailError('forbidden', '邮箱登录失败。' + reason)
    }
    if (/CERT|TLS|SSL|SELF_SIGNED/i.test(code)) return new MailError('forbidden', '邮箱服务器的安全连接验证失败，请检查服务器地址和系统时间。')
    return new MailError('transient', action + '失败，请检查网络和服务器设置后重试。')
}
