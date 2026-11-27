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