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

## 3. eLearning 作业同步

待办页进入时自动尝试同步当前账号的在读学生课程；首次服务认证失效时，点击“同步
eLearning”完成认证后重试。自动同步不弹出认证窗口。列表支持来源、未完成/已完成/全部及课程名、作业名、最新提交状态搜索。点击作业打开学校页面，提交后再次同步更新待办。

实现基于 Canvas API：先访问 `/dash` 建立 CAS 会话，再读取
`/api/v1/courses?enrollment_type=student&enrollment_state=active` 和课程作业的 `include[]=submission`；缺失提交记录时读取对应
`submissions/self`。分页按 Link 响应头处理，不依赖单页条数。只读取本人的最新提交状态、提交时间和次数，不下载提交附件或答案正文。

按课程和作业 ID
去重，数据库按账号隔离；整个快照读取并校验成功后事务写入。未提交为未完成，已提交、待批阅、已评分及免交为已完成。个人截止日期优先于作业默认截止日期。同步不删除旧记录，课程不再在读或作业不再返回时保留本地历史。eLearning
条目在本地只读，手动待办仍可正常编辑和删除。

验证命令：

```bash
node --experimental-strip-types --test src/main/elearning.test.ts
npm run build
```

接口依据：[Canvas Assignments](https://developerdocs.instructure.com/services/canvas/resources/assignments)、[Submissions](https://developerdocs.instructure.com/services/canvas/resources/submissions)、[Pagination](https://developerdocs.instructure.com/services/canvas/basics/file.pagination)
。实际学校账号仍需联调验证 CAS、API 权限及返回格式；不能以模拟数据测试代替真实同步验证。
