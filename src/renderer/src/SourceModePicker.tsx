import {useEffect, useRef, useState} from 'react'
import type {ResearchSourceMode} from '../../shared/research'
import {Icon} from './Icon'

const options: { value: ResearchSourceMode; label: string }[] = [
    {value: 'auto', label: '自动选择'},
    {value: 'web', label: '仅网页'},
    {value: 'all', label: '网页 + 树洞'},
]

export function SourceModePicker({value, campusReady, disabled, onChange}: {
    value: ResearchSourceMode
    campusReady: boolean
    disabled: boolean
    onChange: (value: ResearchSourceMode) => void
}) {
    const [open, setOpen] = useState(false)
    const root = useRef<HTMLDivElement>(null)
    const trigger = useRef<HTMLButtonElement>(null)
    const label = options.find(option => option.value === value)?.label ?? '自动选择'

    useEffect(() => {
        if (!open) return
        const close = (event: PointerEvent) => {
            if (!root.current?.contains(event.target as Node)) setOpen(false)
        }
        const key = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                setOpen(false)
                trigger.current?.focus()
            }
        }
        document.addEventListener('pointerdown', close)
        document.addEventListener('keydown', key)
        return () => {
            document.removeEventListener('pointerdown', close)
            document.removeEventListener('keydown', key)
        }
    }, [open])

    return <div className="source-mode" ref={root}>
        <button ref={trigger} type="button" className="source-mode-trigger" disabled={disabled}
                aria-haspopup="menu" aria-expanded={open} aria-label={`搜索范围：${label}`}
                onClick={() => setOpen(value => !value)}>
            <Icon name="compass"/><span>{value === 'auto' ? '自动' : value === 'web' ? '仅网页' : '网页 + 树洞'}</span>
            <Icon name="chevron" className="source-mode-chevron"/>
        </button>
        {open && <div className="source-mode-menu" role="menu" aria-label="搜索范围">
            {options.map(option => {
                const unavailable = option.value === 'all' && !campusReady
                return <button key={option.value} type="button" role="menuitemradio"
                               aria-checked={value === option.value} disabled={unavailable}
                               className={`source-mode-option${value === option.value ? ' is-selected' : ''}`}
                               onClick={() => {
                                   onChange(option.value)
                                   setOpen(false)
                                   trigger.current?.focus()
                               }}>
                    <span>{option.label}</span>
                    {value === option.value && <Icon name="check"/>}
                </button>
            })}
        </div>}
    </div>
}
