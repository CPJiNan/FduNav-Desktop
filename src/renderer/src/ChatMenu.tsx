import {useId, useLayoutEffect, useRef, useState} from 'react'
import {createPortal} from 'react-dom'
import {Icon} from './Icon'

type MenuItem = {
    label: string
    icon: 'pencil' | 'trash' | 'panel' | 'clean' | 'settings'
    disabled?: boolean
    danger?: boolean
    onSelect: () => void
}

export function ChatMenu({label, disabled, items, ownerId}: {
    label: string; disabled?: boolean; items: MenuItem[]; ownerId?: string
}) {
    const [open, setOpen] = useState(false)
    const [position, setPosition] = useState({top: 0, left: 0})
    const trigger = useRef<HTMLButtonElement>(null)
    const menu = useRef<HTMLDivElement>(null)
    const id = useId()

    function close(restoreFocus = false) {
        setOpen(false)
        if (restoreFocus) trigger.current?.focus()
    }

    useLayoutEffect(() => {
        if (!open || !trigger.current || !menu.current) return
        const anchor = trigger.current.getBoundingClientRect()
        const bounds = menu.current.getBoundingClientRect()
        setPosition({
            left: Math.max(8, Math.min(anchor.right - bounds.width, window.innerWidth - bounds.width - 8)),
            top: anchor.bottom + bounds.height + 8 <= window.innerHeight
                ? anchor.bottom + 6 : Math.max(8, anchor.top - bounds.height - 6)
        })
        menu.current.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
        const dismiss = (event: PointerEvent) => {
            if (!trigger.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) close()
        }
        const reposition = () => close()
        const scroll = (event: Event) => {
            if (!menu.current?.contains(event.target as Node)) close()
        }
        document.addEventListener('pointerdown', dismiss)
        window.addEventListener('resize', reposition)
        document.addEventListener('scroll', scroll, true)
        return () => {
            document.removeEventListener('pointerdown', dismiss)
            window.removeEventListener('resize', reposition)
            document.removeEventListener('scroll', scroll, true)
        }
    }, [open])

    return <>
        <button ref={trigger} type="button" className="icon-button chat-menu-trigger" aria-label={label} title={label}
                aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} disabled={disabled}
                onClick={() => setOpen(value => !value)} onKeyDown={event => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                setOpen(true)
            }
        }}><Icon name="more"/></button>
        {open && createPortal(<div ref={menu} id={id} className="chat-menu" style={position} role="menu"
                                   aria-label={label}
                                   data-chat-menu-owner={ownerId}
                                   onBlur={event => {
                                       if (!event.currentTarget.contains(event.relatedTarget)) close()
                                   }}
                                   onKeyDown={event => {
                                       if (event.key === 'Escape') {
                                           event.preventDefault();
                                           event.stopPropagation();
                                           close(true);
                                           return
                                       }
                                       const buttons = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
                                       if (!buttons.length) return
                                       const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
                                       const next = event.key === 'ArrowDown' ? (index + 1) % buttons.length
                                           : event.key === 'ArrowUp' ? (index - 1 + buttons.length) % buttons.length
                                               : event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : -1
                                       if (next >= 0) {
                                           event.preventDefault();
                                           buttons[next].focus()
                                       }
                                   }}>
            {items.map(item => <button key={item.label} type="button" role="menuitem" tabIndex={-1}
                                       disabled={item.disabled} className={item.danger ? 'is-danger' : undefined}
                                       onClick={() => {
                                           close(true);
                                           item.onSelect()
                                       }}><Icon name={item.icon}/>{item.label}</button>)}
        </div>, document.body)}
    </>
}
