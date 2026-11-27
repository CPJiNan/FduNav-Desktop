# FduNav 开发文档

## 1. 常用命令

### 1.1 安装环境

```bash
npm install
npx install-electron
```

### 1.2 启动应用

```bash
npm run dev
```

### 1.3 构建安装包

```bash
npm run build:win
```

## 2. 开发约定

### 2.1 命名规范

- React 组件、类、类型使用 `PascalCase`；函数、变量、属性使用 `camelCase`。
- 非 React 组件文件名使用 `kebab-case`; React 组件文件名使用 `PascalCase`。
- IPC 通道使用 `domain:action`。
- 数据库字段使用 `snake_case`，代码中的对象属性使用 `camelCase`，查询时通过 `AS` 转换。

### 2.2 分层职责

- `src/main`：Electron 主进程，负责数据库、网络、认证、文件、系统能力和 IPC。
- `src/preload`：Electron 预加载脚本，负责暴露基于 `contextBridge` 的安全桥接 API。
- `src/renderer`：React 渲染进程，负责界面和交互。
- `src/shared`：跨进程共享模块，负责提供类型、常量、纯函数和校验逻辑。

新增功能标准路径：

1. 在 `src/shared` 定义类型和校验函数。
2. 在 `src/main` 实现业务逻辑和 IPC。
3. 在 `src/preload` 暴露最小 API。
4. 在 `src/renderer` 使用 API。

## 3. 第三方插件

### 3.1 插件包与安装

将 `plugin.json` 和构建后的网页文件放在同一目录。在 FduNav 打开「设置 → 插件 → 安装插件」，选择该目录。安装后在卡片上核对界面、操作和服务权限，再启用插件。提供 `views.app` 的插件可通过「使用整窗界面」启用整窗替换。

```json
{
  "apiVersion": 1,
  "id": "example.workspace",
  "name": "工作台",
  "version": "1.0.0",
  "permissions": ["calendar", "appInfo"],
  "views": {"app": "app.html", "page.calendar": "calendar.html"},
  "pages": [{"id": "agenda", "title": "议程", "entry": "agenda.html"}],
  "operations": {
    "entry": "operations.html",
    "overrides": ["calendar.list"],
    "commands": ["agenda-status"]
  }
}
```

`id` 使用唯一的小写字母、数字、连字符和点。包内入口必须是相对路径的 HTML 文件。`views`、`pages`、`operations` 可按需组合。启用插件时，应用会检查局部界面和操作是否已经由其他插件覆盖。

### 3.2 界面与渲染

使用 `src/plugin-sdk/index.ts` 中的 `connectPlugin()`。将 SDK 与插件脚本一起打包。以 Vite 为例，部署时使用 `base: './'`，让入口用相对路径加载脚本、CSS、字体、图片和其他资源。插件的网页在独立来源中运行，支持 DOM、Canvas、WebGL、WebAssembly 和浏览器动画。原生 HUD 的渲染实现可按需移植到这些 Web API。

- `views.app` 获得整窗网页区域，可以自行绘制标题栏、导航、设置、页面和弹层。`client.window` 提供最小化、最大化、关闭和状态订阅。`setDragRegions()` 接收相对于插件视口的 CSS 像素矩形。交互控件应放在拖动矩形之外。
- `views.titlebar` 替换标题栏。`views['page.calendar']` 等条目替换对应页面。页面 ID 支持 `dashboard`、`notices`、`chat`、`mail`、`calendar`、`todos`。
- `views['settings.general']` 等条目替换对应设置面板。设置 ID 支持 `general`、`notifications`、`account`、`messages`、`sources`、`llm`、`research`、`mail`、`about`。
- `pages` 将插件页面加入侧栏。局部界面可用 `client.navigate()` 打开 `page.calendar`、`settings.plugins` 或本插件的 `plugin.agenda` 等页面。
- `client.state` 与 `client.onState()` 提供适用于当前界面的上下文。日历页可读取 `calendarView`，通知和邮箱页可在具备对应权限时读取待打开的条目。前端完成渲染后调用 `client.ready()`，应用随后显示该界面。

用 `Ctrl+Shift+P`（macOS 为 `⌘+Shift+P`）或托盘中的「管理插件」进入恢复模式。在恢复模式中可以选择「恢复默认界面」、停用或卸载插件，再退出恢复模式。整窗插件也可以通过 `client.window.openPluginManager()` 打开同一入口。

### 3.3 服务与操作

`client.call('calendar.list')` 调用 FduNav 原生服务。`await client.on('notices.onChanged', handler)` 返回可用于取消订阅的函数。方法签名、返回值和事件参数沿用 `PluginServices` 引用的共享类型。操作名中点号前的服务名须在 `permissions` 中声明，权限覆盖该服务公开的方法与事件。

`operations.entry` 是启用后运行的后台网页。用 `connectPlugin({overrides, commands})` 提供与清单对应的实现，注册完成后调用 `client.ready()`。受支持的覆盖点见 `src/shared/plugins.ts` 中的 `pluginOverrides`。原生界面发起覆盖操作时，应用会调用后台网页的处理函数。处理函数可以用 `client.call()` 读取或调用原生实现，再返回相同类型的 `Result`。各插件页面可用 `client.runCommand('agenda-status')` 调用本插件声明的命令。

```ts
import {connectPlugin, type PluginClient} from './sdk'

const client: PluginClient = await connectPlugin({
    overrides: {
        'calendar.list': async () => {
            const result = await client.call('calendar.list')
            if (!result.ok) return result
            return {...result, data: [...result.data].sort((a, b) => a.title.localeCompare(b.title))}
        }
    },
    commands: {'agenda-status': () => ({available: true})}
})
client.ready()
```
