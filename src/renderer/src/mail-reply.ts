import type {MailAccount, MailMessage} from '../../shared/mail'

export function replyRecipients(message: Pick<MailMessage, 'fromAddress' | 'replyTo' | 'recipients' | 'cc'>,
                                accounts: Pick<MailAccount, 'address'>[], all: boolean): {to: string; cc: string} {
    const self = new Set(accounts.map(account => account.address.toLowerCase()))
    const fromSelf = self.has(message.fromAddress.toLowerCase())
    const targets = fromSelf ? message.recipients : message.replyTo.length ? message.replyTo : [message.fromAddress].filter(Boolean)
    const unique = (values: string[]) => [...new Map(values.map(value => [value.toLowerCase(), value])).values()]
    const to = unique((all ? [...targets, ...message.recipients] : targets).filter(value => (!all && !fromSelf) || !self.has(value.toLowerCase())))
    const included = new Set(to.map(value => value.toLowerCase()))
    return {to: to.join(', '), cc: all ? unique(message.cc.filter(value => !self.has(value.toLowerCase()) && !included.has(value.toLowerCase()))).join(', ') : ''}
}
