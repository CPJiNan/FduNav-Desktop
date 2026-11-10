type IconName =
    'search'
    | 'mail'
    | 'refresh'
    | 'reset'
    | 'map-pin'
    | 'external'
    | 'chevron'
    | 'user'
    | 'notices'
    | 'calendar'
    | 'plus'
    | 'settings'
    | 'processor'
    | 'tag'
    | 'panel'
    | 'folder'
    | 'sun'
    | 'moon'
    | 'monitor'
    | 'check'
    | 'arrow'
    | 'book'
    | 'info'
    | 'compass'
    | 'close'
    | 'minimize'
    | 'maximize'
    | 'restore'
    | 'filter'
    | 'clean'
    | 'sparkles'
    | 'todo'
    | 'grip'
    | 'dashboard'
    | 'chat'
    | 'send'
    | 'stop'
    | 'pencil'
    | 'card'
    | 'pin'
    | 'copy'
    | 'trash'
    | 'star'
    | 'reply'
    | 'attachment'
    | 'inbox'
    | 'forward'
const paths: Record<IconName, string> = {
    star: 'm12 3 2.8 5.7 6.3.9-4.5 4.4 1.1 6.2-5.7-3-5.7 3 1.1-6.2L3.2 9.6l6.1-.9L12 3Z',
    reply: 'm9 5-6 6 6 6M3 11h10a7 7 0 0 1 7 7v1',
    attachment: 'm8 13 7-7a3 3 0 0 1 4 4l-9 9a5 5 0 0 1-7-7l10-10M8 13l-1 1a1.5 1.5 0 0 0 2 2l8-8',
    inbox: 'm4 4-2 11v5h20v-5L20 4H4ZM2 15h6l2 3h4l2-3h6',
    forward: 'm15 5 6 6-6 6M21 11H11a7 7 0 0 0-7 7v1',
    mail: 'M4 5h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Zm-1 2 9 6 9-6',
    card: 'M4 5h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2ZM2 9h20M6 15h4',
    pin: 'M12 17v5M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76Z',
    copy: 'M8 8h12a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1ZM4 16H3a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v1',
    trash: 'M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6',
    chat: 'M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-2 2V11.5A8.5 8.5 0 0 1 10.5 3h2a8.5 8.5 0 0 1 8.5 8.5ZM7 9h9M7 13h6',
    send: 'm12 4-7 7m7-7 7 7M12 4v16',
    stop: 'M6 6h12v12H6Z',
    pencil: 'm16 3 5 5L8 21H3v-5L16 3Zm-3 3 5 5M3 16l5 5',
    dashboard: 'M10 13a2 2 0 1 0 4 0a2 2 0 1 0-4 0M13.45 11.55l2.05-2.05M6.4 20a9 9 0 1 1 11.2 0l-11.2 0',
    grip: 'M9 5h.01M15 5h.01M9 12h.01M15 12h.01M9 19h.01M15 19h.01',
    todo: 'M10 6h11M10 12h11M10 18h11M3 6l1 1 2-2M3 12l1 1 2-2M3 18l1 1 2-2',
    search: 'M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0Zm-2 5 6 6',
    processor: 'M6 6h12v12H6ZM9 9h6v6H9ZM9 3v3m6-3v3M9 18v3m6-3v3M3 9h3m-3 6h3m12-6h3m-3 6h3',
    refresh: 'M20 4v5h-5M4 20v-5h5M4.9 9a7.5 7.5 0 0 1 12.4-2.3L20 9M4 15l2.7 2.3A7.5 7.5 0 0 0 19.1 15',
    reset: 'M3 4v6h6M3 10l3-3a8 8 0 1 1-1 10',
    'map-pin': 'M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 1 1 16 0ZM15 10a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z',
    external: 'M14 3h7v7m0-7L10 14M10 3H4v17h17v-6',
    chevron: 'm9 5 7 7-7 7',
    user: 'M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM4 21v-2a8 8 0 0 1 16 0v2',
    notices: 'M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4',
    calendar: 'M5 5h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2ZM8 3v4M16 3v4M3 10h18',
    plus: 'M12 5v14M5 12h14',
    settings: 'm9 3-.5 2-2 1-2-.5-2 3 1.5 1.5v3L2.5 15l2 3 2-.5 2 1L9 21h6l.5-2.5 2-1 2 .5 2-3-1.5-2v-3L21.5 9l-2-3-2 .5-2-1L15 3Z M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
    tag: 'M3 3h8l10 10-8 8L3 11V3Zm4 4h.01',
    panel: 'M4 4h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1ZM9 4v16',
    folder: 'M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7Z',
    sun: 'M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5',
    moon: 'M20.5 14.5A9 9 0 0 1 9.5 3.5a9 9 0 1 0 11 11Z',
    monitor: 'M3 4h18v13H3ZM8 21h8m-4-4v4',
    check: 'm5 12 4 4L19 6',
    arrow: 'm14 6-6 6 6 6M8 12h13',
    book: 'M12 5c-3-2-6-2-9-1v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-3-1-6-1-9 1Zm0 0v15',
    info: 'M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0M12 9h.01M11 12h1v4h1',
    compass: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-6-3-2 4-4 2 2-4Z',
    close: 'm6 6 12 12M6 18 18 6',
    minimize: 'M5 12h14',
    maximize: 'M5 5h14v14H5Z',
    restore: 'M8 8V4h12v12h-4M4 8h12v12H4Z',
    filter: 'M4 5h16l-6 7v5l-4 2v-7L4 5Z',
    clean: 'M10 8V4a2 2 0 0 1 4 0v4h4a2 2 0 0 1 2 2v7a4 4 0 0 1-4 4H3c2-3 2-6 2-9v-2a2 2 0 0 1 2-2h3ZM5 12h15M10 16c0 2-1 4-2 5M15 16c0 2-1 4-2 5',
    sparkles: 'M12 3l1.9 4.6L18.5 9l-4.6 1.9L12 15.5l-1.9-4.6L5.5 9l4.6-1.4L12 3ZM5 15l.8 2.2L8 18l-2.2.8L5 21l-.8-2.2L2 18l2.2-.8L5 15ZM19 14l.6 1.6 1.6.6-1.6.6-.6 1.6-.6-1.6-1.6-.6 1.6-.6L19 14Z',
}

export function Icon({name, className = ''}: { name: IconName; className?: string }) {
    return <svg className={`icon ${className}`} width="20" height="20" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round"
                aria-hidden="true">
        <path d={paths[name]}/>
    </svg>
}
