import {
    app,
    BrowserWindow,
    dialog,
    ipcMain,
    type IpcMainEvent,
    type IpcMainInvokeEvent,
    Menu,
    nativeImage,
    Tray
} from 'electron'
import {join} from 'node:path'
import {existsSync, mkdirSync} from 'node:fs'
import {pathToFileURL} from 'node:url'
import {AppDatabase} from './database'
import {registerAccountHandlers} from './accounts'
import {registerNoticeHandlers} from './notices'
import {registerMessagePreferenceHandlers} from './message-preferences'
import {registerLlmHandlers} from './llm'
import {registerTimetableHandlers} from './timetable'
import {registerCalendarHandlers} from './calendar'
import {registerChatHandlers} from './chat'
import {registerTodoHandlers} from './todos'
import {registerCampusCardHandlers} from './campus-card'
import {registerLibraryHandlers} from './library'
import {registerGeneralSettingsHandlers} from './general-settings'
import {registerAppInfoHandlers} from './app-info'

let database: AppDatabase | undefined
let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false
const userDataPath = app.getPath('userData')
app.setName('FduNav')
app.setPath('userData', userDataPath)
app.setPath('sessionData', userDataPath)
app.setPath('cache', join(userDataPath, 'Cache'))
const primaryInstance = app.requestSingleInstanceLock()
if (!primaryInstance) app.quit()
if (process.platform === 'win32' && app.isPackaged) app.setAppUserModelId('top.cpjinan.fdunav')

function showMainWindow() {
    if (quitting) return
    if (!mainWindow || mainWindow.isDestroyed()) {
        if (database) createWindow()
        return
    }
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
}

function appIconPath() {
    return [join(app.getAppPath(), 'resources/icon.png'), join(__dirname, '../../resources/icon.png')].find(existsSync)
}

function ensureTray() {
    if (tray && !tray.isDestroyed()) return
    const path = appIconPath()
    if (!path) throw new Error('未找到托盘图标。')
    const icon = nativeImage.createFromPath(path).resize({width: 32, height: 32})
    if (icon.isEmpty()) throw new Error('无法读取托盘图标。')
    const next = new Tray(icon)
    try {
        next.setToolTip('FduNav')
        next.setContextMenu(Menu.buildFromTemplate([
            {label: '打开 FduNav', click: showMainWindow},
            {type: 'separator'},
            {label: '退出 FduNav', click: () => app.quit()},
        ]))
        next.on('click', showMainWindow)
        next.on('double-click', showMainWindow)
        tray = next
    } catch (error) {
        next.destroy()
        throw error
    }
}

app.on('second-instance', showMainWindow)
app.on('before-quit', () => {
    quitting = true
})

function isAppUrl(value: string) {
    try {
        const url = new URL(value)
        return !app.isPackaged && process.env.ELECTRON_RENDERER_URL
            ? url.origin === new URL(process.env.ELECTRON_RENDERER_URL).origin
            : url.href.split('#')[0] === pathToFileURL(join(__dirname, '../renderer/index.html')).href
    } catch {
        return false
    }
}

function senderWindow(event: IpcMainEvent | IpcMainInvokeEvent): BrowserWindow | null {
    if (event.senderFrame !== event.sender.mainFrame) return null
    return BrowserWindow.fromWebContents(event.sender)
}

ipcMain.on('window:minimize', event => senderWindow(event)?.minimize())
ipcMain.on('window:toggle-maximize', event => {
    const window = senderWindow(event)
    if (!window) return
    if (window.isMaximized()) window.unmaximize()
    else window.maximize()
})
ipcMain.on('window:close', event => senderWindow(event)?.close())
ipcMain.handle('window:is-maximized', event => senderWindow(event)?.isMaximized() ?? false)

function createWindow(): void {
    const window = new BrowserWindow({
        width: 1000,
        height: 700,
        minWidth: 360,
        minHeight: 420,
        frame: false,
        title: 'FduNav',
        icon: appIconPath(),
        webPreferences: {
            preload: join(__dirname, '../preload/index.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true
        }
    })
    mainWindow = window
    window.on('closed', () => {
        mainWindow = null
    })
    window.on('query-session-end', () => {
        quitting = true
    })
    window.on('close', event => {
        if (quitting) return
        event.preventDefault()
        if (database?.getCloseAction() === 'tray') {
            try {
                ensureTray()
                window.hide()
            } catch {
                dialog.showErrorBox('无法最小化至托盘', '托盘初始化失败，窗口已保留。请重试或在通用设置中选择“退出 FduNav”。')
            }
        } else app.quit()
    })

    window.setMenu(null)
    window.webContents.setWindowOpenHandler(() => ({action: 'deny'}))
    window.webContents.on('will-navigate', (event, url) => {
        if (!isAppUrl(url)) event.preventDefault()
    })
    const publishMaximized = () => {
        window.webContents.send('window:maximized-changed', window.isMaximized())
    }
    window.on('maximize', publishMaximized)
    window.on('unmaximize', publishMaximized)

    if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
        void window.loadURL(process.env.ELECTRON_RENDERER_URL)
    } else {
        void window.loadFile(join(__dirname, '../renderer/index.html'))
    }
}

app.whenReady().then(async () => {
    if (!primaryInstance) return
    try {
        mkdirSync(app.getPath('userData'), {recursive: true})
        database = new AppDatabase(join(app.getPath('userData'), 'fdunav.sqlite'))
        const trusted = (event: IpcMainInvokeEvent) => !!senderWindow(event) && isAppUrl(event.senderFrame?.url ?? '')
        registerAppInfoHandlers(trusted)
        registerGeneralSettingsHandlers(database, trusted)
        const accounts = await registerAccountHandlers(database, trusted)
        registerTimetableHandlers(database, accounts, trusted)
        registerCampusCardHandlers(accounts, trusted)
        registerLibraryHandlers(trusted)
        const calendar = registerCalendarHandlers(database, accounts, trusted, showMainWindow)
        const todos = registerTodoHandlers(database, accounts, trusted, showMainWindow)
        const llm = registerLlmHandlers(database, trusted)
        const notices = registerNoticeHandlers(database, accounts, llm, trusted, showMainWindow)
        registerChatHandlers(database, accounts, llm, notices, calendar, todos, trusted)
        registerMessagePreferenceHandlers(database, trusted)
    } catch (error) {
        console.error('FduNav 启动失败', error)
        dialog.showErrorBox('FduNav 启动失败', error instanceof Error ? error.message : '初始化失败，请查看终端输出。')
        app.quit()
        return
    }
    createWindow()

    app.on('activate', showMainWindow)
})

app.on('will-quit', () => {
    tray?.destroy()
    database?.close()
})

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
})
