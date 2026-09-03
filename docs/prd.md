# CursorRemote — 产品需求文档

## 1. 概述

CursorRemote 是一套中继系统，让你从手机浏览器或 Telegram 群远程监视和控制 Cursor IDE 的 AI agent。它通过 Chrome DevTools Protocol（CDP）连接到正在运行的 Cursor 实例，把 agent 聊天状态提取为结构化数据，并通过与传输层无关的事件系统流式发给已连接客户端。从手机或 Telegram 你可以阅读对话、批准或拒绝工具调用、运行或跳过 shell 命令、与 plan widget 交互、发送新提示、切换聊天 tab，以及更改 agent mode/model — 无需触碰主机。

### 1.1 问题陈述

长时间运行 Cursor agent 会话时，开发者被拴在主机前。离开就会错过阻塞 agent 的审批提示，浪费时间并打断心流。Cursor 没有内置的远程与 agent 交互方式。

### 1.2 目标

交付一套可用系统，能够：

- 通过 CDP 连接到本机运行的 Cursor IDE
- 把 agent 聊天面板状态提取为结构化、带类型的数据 — 包括带 todo 列表的 plan widget 和终端命令审批 widget
- 通过与传输层无关的事件系统，把状态实时流式发给已连接客户端（Web 浏览器和 Telegram）
- 让远程用户批准/拒绝工具调用、运行/跳过 shell 命令，并触发计划构建
- 支持聊天 tab 切换、mode 选择和 model 选择
- 提供使用论坛话题（每个项目 + 聊天 tab 一个）的 Telegram bot 集成，用于监视和控制
- 完全运行在本地网络上（无云依赖，Telegram API 除外）

### 1.3 非目标

- 云账号或厂商 license/激活（中继直接启动；没有 license key）
- 持久聊天历史或完整对话数据库
- 多用户 Web 客户端账号（Web 客户端使用可选的共享密码，存在 VS Code Settings 或 `WEBAPP_PASSWORD`）
- PWA / 离线支持
- Discord 或其他聊天平台集成（架构支持，但未实现）

---

## 2. 用户故事

### US-1：远程审批

**作为** 离开工位的开发者，
**我希望** 在 agent 需要审批时看到，并在手机上点 Approve/Reject，
**这样** 我不在时 agent 不会被堵住。

### US-2：远程发提示

**作为** 用手机的开发者，
**我希望** 输入并发送新提示给 agent，
**这样** 我可以远程改道或继续 agent 的工作。

### US-3：对话监视

**作为** 开发者，
**我希望** 在手机上以正确格式（markdown、代码块、工具调用、计划）阅读完整 agent 对话，
**这样** 我能理解 agent 已经做了什么、正在做什么。

### US-4：Agent 状态感知

**作为** 开发者，
**我希望** 一眼看到 agent 是空闲、思考、运行工具，还是等待审批，
**这样** 我知道何时需要我输入。

### US-5：后台通知

**作为** 把 Web 客户端放在后台标签页的开发者，
**我希望** 任何需要我注意的操作都收到浏览器通知 — 全局审批、run command 的 Skip/Run 提示、工具级审批（例如 Fetch 白名单、edit 的 Accept/Skip），以及其他可操作的工具 widget，
**这样** 无论 agent 调用哪种工具类型，我都不会错过时效性强的提示。

### US-6：连接韧性

**作为** 开发者，
**我希望** 网络断开时系统自动重连，
**这样** 我不必手动刷新或重启任何东西。

### US-7：聊天 Tab 管理

**作为** 开发者，
**我希望** 从手机看到所有打开的聊天 tab 并在它们之间切换，
**这样** 我可以远程管理多个 agent 对话。

### US-8：Mode 与 Model 控制

**作为** 开发者，
**我希望** 从手机更改 agent mode（Agent/Ask/Manual）和 model，
**这样** 我不用回到主机就能调整 agent 行为。

### US-9：多窗口管理

**作为** 打开了多个 Cursor 窗口的开发者，
**我希望** 看到所有 Cursor 窗口（主窗口实时；其他并行轮询）并从手机切换主连接，
**这样** 我可以跨不同项目监视和控制 agent。

### US-10：Plan widget 交互

**作为** 开发者，
**我希望** 看到完整计划卡片 — 标题、描述、带每项状态的 todo 列表 — 并从手机或 Telegram 点 “Build” 或 “View Plan”，
**这样** 我可以远程审阅并执行 agent 计划。

### US-11：Shell 命令审批

**作为** 开发者，
**我希望** 看到 agent 想运行的完整 shell 命令（含描述和命令文本），并从手机或 Telegram 点 “Run”、“Skip” 或 “Allow”，
**这样** 我不必只看到笼统的审批提示就能对命令执行做出知情决定。

### US-12：Telegram 监视

**作为** 使用 Telegram 的开发者，
**我希望** 看到 agent 对话流进 Telegram 论坛话题（每个项目 + 聊天 tab 一个），带正确格式和实时更新，
**这样** 我不用打开浏览器就能从 Telegram 监视 agent 进度。

### US-13：Telegram 控制

**作为** 使用 Telegram 的开发者，
**我希望** 发送消息、通过内联按钮批准/拒绝工具调用、切换 mode/model，并触发计划构建 — 全部在 Telegram 里完成，
**这样** 我可以从任何装了 Telegram 的设备完整控制 agent。

### US-14：Agent 问卷

**作为** 离开工位的开发者，
**我希望** 从手机或 Telegram 看到并回答 agent 的选择题，
**这样** agent 不会在等我输入时被堵住。

### US-15：Telegram 自动同步

**作为** 使用 Telegram 的开发者，
**我希望** 运行一次 `/sync` 启用自动同步，此后新聊天 tab 会自动获得论坛话题，
**这样** 开始新的 agent 对话时不必手动创建话题。

---

## 3. 系统架构

```
┌─────────────────────────┐       CDP WebSocket        ┌───────────────────────────────────┐
│  Cursor IDE             │ ←────── port 9222 ───────→ │  Relay Server (Node.js)           │
│  (Windows/macOS/Linux)  │                             │                                   │
│                         │                             │  ┌─ CDP Bridge ─────────────────┐ │
│  Electron app with      │                             │  │  Custom CdpClient (ws)        │ │
│  --remote-debugging-port│                             │  └──────────┬────────────────────┘ │
│                         │                             │             │                      │
│  ┌─ Agent Chat Panel ─┐ │                             │  ┌──────────▼────────────────────┐ │
│  │  Messages           │ │                             │  │  DOM Extractor                │ │
│  │  Tool calls         │ │                             │  │  Runtime.evaluate poll        │ │
│  │  Plan widgets       │ │                             │  │  data-attribute driven        │ │
│  │  Run command cards  │ │                             │  └──────────┬────────────────────┘ │
│  │  Approval buttons   │ │                             │             │                      │
│  │  Composer input     │ │                             │  ┌──────────▼────────────────────┐ │
│  │  Mode/Model select  │ │                             │  │  State Manager                │ │
│  │  Chat tab sidebar   │ │                             │  │  (diff + event emission)      │ │
│  └─────────────────────┘ │                             │  └──────┬──────────────┬──────────┘ │
│                         │                             │         │              │            │
│                         │                             │  ┌──────▼───────┐ ┌────▼──────────┐ │
│                         │                             │  │ Web Transport│ │ Telegram      │ │
│                         │                             │  │ (socket.io)  │ │ Transport     │ │
│                         │                             │  │ Express+WS   │ │ (grammy/raw)  │ │
│                         │                             │  └──────┬───────┘ └────┬──────────┘ │
│                         │                             │         │              │            │
└─────────────────────────┘                             └─────────┼──────────────┼────────────┘
                                                                  │              │
                                                           socket.io        Telegram Bot API
                                                           port 3000             │
                                                                  │              │
                                                    ┌─────────────▼───┐  ┌───────▼──────────┐
                                                    │  Phone Browser   │  │  Telegram Group   │
                                                    │  Web client      │  │  Forum topics     │
                                                    │  - Chat elements │  │  - Chat log       │
                                                    │  - Plan widgets  │  │  - Inline buttons │
                                                    │  - Run commands  │  │  - /commands       │
                                                    │  - Approvals     │  │  - Typing status  │
                                                    │  - Mode/model    │  │  - Mode/model     │
                                                    └──────────────────┘  └──────────────────┘
```

WSL2 仍然是受支持的部署（中继在 WSL2，Cursor 在 Windows）；macOS/Linux 本机安装同样有效。见 `docs/setup-guide.md`。

### 3.0 传输层架构

状态管理器发出 `state:patch` 和 `connection:changed` 事件。任意数量的传输层可以独立订阅。每个传输层：

1. **订阅** 状态管理器事件以获取出站数据
2. **调用** 命令执行器方法（窗口切换则调用 CDP Bridge）以处理入站命令
3. **管理** 自己的连接生命周期和客户端特定状态

当前实现了两种传输层：

- **Web 传输层**（`relay.ts`）：Express 静态服务器 + socket.io。把状态事件转发给浏览器客户端，把 socket.io 命令路由到执行器。
- **Telegram 传输层**（`transports/telegram/`）：带 long polling 的 grammy bot（或 `TELEGRAM_IMPL=raw` 时的 fetch 回退）。把状态映射到论坛话题中的 Telegram 消息，把内联键盘 callback 和文本消息路由到执行器。完整规格见 `docs/telegram_prd.md`。

### 3.1 数据流 — 观察

1. 中继服务器每 `POLL_INTERVAL_MS`（`config.ts` 中默认 **300ms**；扩展设置 `cursorRemote.pollIntervalMs` 默认为 **500ms**）通过 `Runtime.evaluate`（CDP）轮询 **主（home）** 窗口的 DOM。其他 Cursor 窗口由 `WindowMonitor` 每 10s 并行轮询（临时 CDP 连接；不切换 Cursor UI）。
2. 提取函数在 Cursor 的 renderer 内运行，遍历 `[data-flat-index]` / `[data-message-index]` 元素
3. 它返回结构化的 `CursorState` 对象（带类型的 `ChatElement[]`、审批、tab、mode、model）
4. 状态管理器与上一状态做 diff
5. 只有变更字段通过 socket.io `state:patch` 广播给已连接客户端
6. 新连接的客户端通过 `state:full` 收到完整状态

### 3.2 数据流 — 命令

1. 手机客户端发出 socket.io 事件（例如 `command:approve`、`command:send_message`）
2. 中继校验载荷并转发给命令执行器
3. 执行器转译为 CDP 操作（Input.insertText、Input.dispatchKeyEvent、Runtime.evaluate）
4. CDP 在 Cursor 的 DOM 上执行
5. 下一个观察周期拾取结果状态变化
6. 中继把更新后的状态广播给所有客户端

---

## 4. 状态模型

### 4.1 CursorState（顶层）

| 字段 | 类型 | 说明 |
| ------------------ | ------------------ | -------------------------------------------- |
| `connected` | `boolean` | CDP 是否已连接到 Cursor |
| `extractorStatus` | `ExtractorStatus` | DOM 提取健康度，独立于 CDP websocket：`idle`、`waiting`、`ok`、`stale` |
| `lastExtractionAt` | `number \| null` | 上次成功提取的 epoch 毫秒 |
| `consecutiveExtractionFailures` | `number` | 自上次成功以来连续失败的提取次数 |
| `lastExtractionError` | `string \| null` | 最近一次提取错误，成功/重置后为 null |
| `agentStatus` | `AgentStatus` | 持久页头状态（`idle`、`waiting_approval`、`error` 等） |
| `agentActivityText` | `string \| null` | 实时活动标签；`null` 表示线上显式清除 |
| `agentActivityLive` | `boolean` | 仅当当前 DOM 信号证明正在工作时为 true |
| `agentActivitySource` | `'none' \| 'shimmer' \| 'loading_tool' \| 'loading_indicator' \| 'tail_thought'` | 实时活动信号的来源 |
| `messages` | `ChatElement[]` | 有序聊天元素（带判别的联合） |
| `pendingApprovals` | `Approval[]` | 当前等待用户决定的工具调用 |
| `inputAvailable` | `boolean` | 聊天输入是否可见/可聚焦 |
| `chatTabs` | `ChatTab[]` | 打开的聊天/composer tab |
| `activeComposerId` | `string` | 已提取 DOM 中活动 composer 的 `data-composer-id` |
| `mode` | `ModeInfo` | 当前及可用的 agent mode |
| `model` | `ModelInfo` | 当前模型名称和 ID |
| `windows` | `CursorWindow[]` | 所有已发现的 Cursor 窗口 |
| `activeWindowId` | `string` | 当前已连接窗口的 ID |
| `composerQueue` | `ComposerQueueState` | composer 工具栏中排队的提示 |
| `questionnaire` | `Questionnaire \| null` | Agent 问卷 widget（选择题） |

`_rawSignals` 是内部提取诊断，会从 socket `state:full` / `state:patch` 中剥离；通过 `/debug/state` 检查。

### 4.2 AgentStatus

以下之一：`idle`、`thinking`、`generating`、`running_tool`、`waiting_approval`、`error`

Web 页头始终展示该状态：空闲为 `Idle`（任务已停止/未在跑），进行中为实时活动文案（Thinking / Running / Generating），需要确认为 `Needs approval`，异常为 `Error`。本轮不提供停止按钮。

Web 工具卡为双层：第一行是工具名和短统计（+/-），可见摘要与文件名放在下方缩进，避免窄屏被同一 nowrap 行挤掉。摘要只来自已显示的标题/header/preview，不抓 thinking 正文。

当前会话中的 plan 卡片和页头下的 Plans 条可打开计划；若 `label` 像计划文件名（`.md`），客户端会通过 `get_plan_full` 发送不透明的 `planId`。中继只从当前 `CursorState.messages` 中匹配该 ID 并取服务端已观察到的 `label`，再读取 `~/.cursor/plans` 下的普通非符号链接文件；不信任客户端文件名，也不做历史计划浏览器。

### 4.3 ChatElement（带判别的联合）

聊天中的每个元素是八种类型之一，由 `type` 字段标识：`human`、`assistant`、`tool`、`thought`、`plan`、`todo_list`、`run_command`、`loading`。

#### HumanMessage（`type: 'human'`）

| 字段 | 类型 | 说明 |
| ----------- | --------------------------------------- | ---------------------------------- |
| `id` | `string` | 来自 Cursor DOM 的消息 UUID |
| `flatIndex` | `number` | 聊天中的顺序位置 |
| `text` | `string` | 纯文本内容 |
| `mentions` | `{ name: string; mentionType: string }[]` | @ mentions（文件、终端等） |
| `quoted` | `{ text: string }?` | 来自 composer 的引用/回复预览 |

#### AssistantMessage（`type: 'assistant'`）

| 字段 | 类型 | 说明 |
| ------------ | --------------------------------------------------------- | ---------------------------------- |
| `id` | `string` | 消息 UUID |
| `flatIndex` | `number` | 顺序位置 |
| `text` | `string` | 纯文本内容 |
| `html` | `string` | 净化后的 `.markdown-root` HTML |
| `codeBlocks` | `CodeBlockItem[]`（见 §6.11） | 供原生 Web/Telegram 渲染的结构化代码/diff 块 |

#### ToolCallElement（`type: 'tool'`）

| 字段 | 类型 | 说明 |
| ------------- | -------- | ------------------------------------------------------ |
| `id` | `string` | 消息 UUID |
| `flatIndex` | `number` | 顺序位置 |
| `toolCallId` | `string` | Cursor 的工具调用 ID |
| `status` | `string` | `'loading'` 或 `'completed'` |
| `action` | `string` | 工具操作名（Read、Edit、Shell）或状态摘要 |
| `details` | `string` | 目标（文件名、终端等） |
| `filename` | `string?` | 正在编辑的文件（来自 edit 工具卡片） |
| `additions` | `number?` | 新增行数（来自 edit 工具统计） |
| `deletions` | `number?` | 删除行数（来自 edit 工具统计） |
| `summaryText` | `string?` | 完整紧凑摘要文本（回退） |
| `actions` | `RunAction[]?` | 工具级审批按钮（Fetch allow、Edit accept 等） |
| `blocked` | `string?` | 若工具被阻止，阻止原因 |
| `diffBlock` | `CodeBlockItem?` | edit/review 工具的结构化 diff/代码（Web + Telegram） |

#### ThoughtBlock（`type: 'thought'`）

| 字段 | 类型 | 说明 |
| ----------- | -------- | ----------------------------- |
| `id` | `string` | 生成的 ID |
| `flatIndex` | `number` | 顺序位置 |
| `duration` | `string` | 例如 “4s” |
| `action` | `string?` | 步骤标签（例如 “Explored”） |
| `detail` | `string?` | 额外详情 |
| `thoughtKind` | `'step_summary' \| 'thinking_step'?` | 伞形步骤行 vs 内部思考行 |

#### PlanBlock（`type: 'plan'`）

同时表示 legacy 计划执行摘要（`.plan-execution-message-content`）和丰富的 plan widget（`.composer-create-plan-container`）。widget 变体有额外字段。

| 字段 | 类型 | 说明 |
| ---------------- | -------------- | -------------------------------------------------------- |
| `id` | `string` | 消息 UUID |
| `flatIndex` | `number` | 顺序位置 |
| `label` | `string` | 计划文件名或标签徽章（例如 “Build”） |
| `title` | `string` | 计划标题（例如 “Telegram Integration Module”） |
| `todosCompleted` | `number` | 已完成 todo 数 |
| `todosTotal` | `number` | todo 总数 |
| `description` | `string?` | 计划概述/描述文本（仅 widget） |
| `descriptionHtml` | `string?` | 来自 `.markdown-root` 的原始 markdown HTML |
| `todos` | `PlanTodo[]?` | 带状态的单个 todo 项（仅 widget） |
| `todosMoreCount` | `number?` | Cursor 中藏在 “N more” 后面的隐藏 todo 行 |
| `model` | `string?` | plan widget 中显示的模型名（仅 widget） |
| `modelDropdownSelectorPath` | `string?` | 点击以打开计划作用域模型下拉 |
| `actions` | `PlanAction[]?` | View Plan 和 Build 按钮选择器（仅 widget） |

#### PlanTodo（PlanBlock 的子类型）

| 字段 | 类型 | 说明 |
| -------- | -------- | -------------------------------------------------- |
| `text` | `string` | Todo 项内容 |
| `status` | `string` | `'pending'`、`'completed'` 或 `'in_progress'` |

#### PlanAction（PlanBlock 的子类型）

| 字段 | 类型 | 说明 |
| -------------- | -------- | ----------------------------- |
| `label` | `string` | 按钮文本（“View Plan”、“Build”） |
| `type` | `string` | `'view_plan'` 或 `'build'` |
| `selectorPath` | `string` | 内部提取路径；从公开 socket 状态剥离，**不是**授权 |
| `actionId` | `string?` | 服务端 ActionRegistry 颁发的不透明 id；缺失则按钮不可执行 |

#### TodoListBlock（`type: 'todo_list'`）

独立的 todo 列表 widget（`.todo-list-container`），与 plan widget 分开。

| 字段 | 类型 | 说明 |
| ---------------- | -------------- | -------------------------------------------------------- |
| `id` | `string` | 消息 UUID |
| `flatIndex` | `number` | 顺序位置 |
| `title` | `string` | 列表标题 |
| `todosCompleted` | `number` | 已完成数 |
| `todosTotal` | `number` | 总数 |
| `todos` | `PlanTodo[]` | 项 |

#### RunCommand（`type: 'run_command'`）

agent 想执行的终端命令，显示为带完整命令文本和 Run/Skip/Allow 按钮的交互卡片。这与已完成的工具调用不同 — 它表示待决定。

| 字段 | 类型 | 说明 |
| ------------- | -------------- | -------------------------------------------------------- |
| `id` | `string` | 消息 UUID |
| `flatIndex` | `number` | 顺序位置 |
| `toolCallId` | `string` | Cursor 的工具调用 ID |
| `description` | `string` | 页头文本（例如 “Run outside sandbox:”） |
| `candidates` | `string` | 命令名摘要（例如 “cd, source, npx, python3”） |
| `command` | `string` | 完整命令文本 |
| `actions` | `RunAction[]` | 带选择器的可用按钮 |

#### RunAction（RunCommand 的子类型）

| 字段 | 类型 | 说明 |
| -------------- | -------- | ---------------------------------------------- |
| `label` | `string` | 按钮文本（“Run”、“Skip”、“Allow”） |
| `type` | `string` | `'run'`、`'skip'` 或 `'allow'` |
| `selectorPath` | `string` | 内部提取路径；从公开状态剥离，**不是**授权 |
| `actionId` | `string?` | 服务端颁发的不透明 id；客户端只提交这个 id |

#### LoadingIndicator（`type: 'loading'`）

| 字段 | 类型 | 说明 |
| ----------- | -------- | ----------------------------- |
| `id` | `string` | 生成的 ID |
| `flatIndex` | `number` | 顺序位置 |
| `text` | `string?` | 可选状态文本 |

### 4.4 ChatTab

| 字段 | 类型 | 说明 |
| ------------- | --------- | ------------------------------------- |
| `composerId` | `string` | Cursor 内部 composer ID |
| `title` | `string` | Tab 显示名 |
| `isActive` | `boolean` | 是否为当前聚焦 tab |
| `isOpen` | `boolean?` | 是否出现在 Cursor 顶部横向打开会话栏；手机端按该字段把打开会话排在历史会话之前 |
| `status` | `string` | Tab 状态（completed、running 等） |
| `selectorPath` | `string` | 点击以切换到该 tab 的 CSS 路径 |

### 4.5 ModeInfo

| 字段 | 类型 | 说明 |
| ----------- | --------------------------------------------- | -------------------------- |
| `current` | `string` | 当前 mode 名称 |
| `available` | `{ id: string; label: string; icon: string }[]` | 可选择的 mode |

### 4.6 ModelInfo

| 字段 | 类型 | 说明 |
| ----------- | -------- | ------------------------ |
| `current` | `string` | 当前模型显示名 |
| `currentId` | `string` | 内部模型标识符 |

### 4.7 CursorWindow

| 字段 | 类型 | 说明 |
| ------- | -------- | ------------------------------------------ |
| `id` | `string` | CDP target ID |
| `title` | `string` | 从窗口标题解析的项目名 |
| `url` | `string` | Target URL |
| `wsUrl` | `string?` | 页面 target 的 WebSocket 调试 URL |

### 4.8 Approval

| 字段 | 类型 | 说明 |
| ------------- | ------------------ | ---------------------------------------- |
| `id` | `string` | 唯一标识符 |
| `description` | `string` | 正在审批的内容 |
| `actions` | `ApprovalAction[]` | 可用按钮 |

### 4.9 ApprovalAction

| 字段 | 类型 | 说明 |
| -------------- | -------- | --------------------------------------------------- |
| `label` | `string` | 按钮文本（“Accept”、“Reject” 等） |
| `type` | `string` | `'approve'`、`'reject'` 或 `'approve_all'` |
| `selectorPath` | `string` | 内部提取路径；从公开状态剥离，**不是**授权 |
| `actionId` | `string?` | 服务端颁发的不透明 id |

### 4.10 Questionnaire

表示 agent 的选择题问卷工具栏（`.composer-questionnaire-toolbar`）。没有活动问卷时为 null。

| 字段 | 类型 | 说明 |
| --------------------- | ------------------------- | ---------------------------------------- |
| `questions` | `QuestionnaireQuestion[]` | 问卷中的全部问题 |
| `activeIndex` | `number` | 活动问题的 0 基索引 |
| `totalLabel` | `string` | 步进标签，例如 “1 of 3” |
| `skipSelectorPath` | `string` | Skip 的内部路径；公开状态剥离，不是授权 |
| `continueSelectorPath` | `string` | Continue 的内部路径；公开状态剥离，不是授权 |
| `skipActionId` | `string?` | Skip 的 ActionRegistry id |
| `continueActionId` | `string?` | Continue 的 ActionRegistry id |
| `continueDisabled` | `boolean` | Continue 是否禁用 |

### 4.11 QuestionnaireQuestion

| 字段 | 类型 | 说明 |
| ----------- | ------------------------- | ---------------------------------------------- |
| `number` | `string` | 显示编号（“1.”、“2.” 等） |
| `text` | `string` | 问题文本 |
| `options` | `QuestionnaireOption[]` | 可用答案选项 |
| `isActive` | `boolean` | 是否为当前活动问题 |

### 4.12 QuestionnaireOption

| 字段 | 类型 | 说明 |
| -------------- | --------- | ------------------------------------------------- |
| `letter` | `string` | 选项字母（“A”、“B”、“C”、“D”） |
| `label` | `string` | 选项文本（“Spring”、“Summer” 等） |
| `isFreeform` | `boolean` | 自由输入的 “Other...” 选项为 true |
| `selectorPath` | `string` | 内部提取路径；公开状态剥离，不是授权 |
| `actionId` | `string?` | 服务端颁发的不透明 id |

### 4.13 ComposerQueueState

| 字段 | 类型 | 说明 |
| ---------- | --------------------- | ------------------------------------------ |
| `items` | `ComposerQueueItem[]` | 排队的提示（`id` + `text`） |
| `queueLabel` | `string?` | 工具栏页头，例如 “2 Queued” |

---

## 5. 协议 — socket.io 事件

### 5.1 服务器 → 客户端

| 事件 | 载荷 | 何时 |
| ------------------- | ------------------------ | ------------------------------------- |
| `state:full` | `CursorState` | 客户端初次连接或重连时；也用于响应 `state:request` |
| `state:patch` | `Partial<CursorState>` | 任何状态字段变化时 |
| `connection:status` | `{ connected: boolean }` | CDP 连接或断开时（内部 EventEmitter 事件是 `connection:changed`） |
| `command:result` | `{ commandId, ok, error?, data? }` | 命令执行或失败后 |
| `capabilities:full` | 能力快照信封（`activeTargetId` + `snapshots[]`） | 连接初始化或显式刷新后；含 targetGeneration/revision/completeness |
| `capabilities:patch` | 带 `targetId` / `targetGeneration` / `revision` 的增量 | 能力或 adapter 诊断变化；旧 revision 必须丢弃 |
| `capabilities:stale` | `{ targetId }` | target 重建或能力过期；不表示 CDP socket 已断开 |

公开 `CursorState` 会剥离 `selectorPath` 与 `_rawSignals`。可执行按钮的授权字段是服务端 `actionId`，不是 CSS 路径。

### 5.2 客户端 → 服务器

| 事件 | 载荷 | 说明 |
| ---------------------- | --------------------------------------------- | ---------------------------------- |
| `state:request` | 无 | 重连后主动请求最新 `state:full` 快照 |
| `command:send_message` | `{ commandId, operationId, text }` | 输入并提交新提示；`operationId` 用于服务端幂等与限流 |
| `command:approve` | `{ commandId, operationId, approvalId, actionId }` | 点击审批。授权依据是服务端 `actionId`；`selectorPath` 不是授权 |
| `command:approve_all` | `{ commandId, operationId, actionId }` | 点击 “Accept All”；`actionType` 必须是 `approve_all`，不能用 `approve` 冒充 |
| `command:reject` | `{ commandId, approvalId, actionId }` | 点击 reject；仍需合法、未消费的 `actionId` |
| `command:switch_tab` | `{ commandId, tabTitle }` | 切换到不同聊天 tab |
| `command:new_chat` | `{ commandId, operationId }` | 创建新聊天 tab |
| `command:set_mode` | `{ commandId, operationId, modeId }` | 更改 agent mode；id 必须来自当前已验证能力目录 |
| `command:set_model` | `{ commandId, operationId, modelId }` | 更改模型；同样受能力目录约束 |
| `command:get_model_options` | `{ commandId }` | 刮取 Cursor 现场模型菜单（INTERACTIVE，不是 PASSIVE） |
| `command:get_plan_full` | `{ commandId, label }` | 从磁盘加载完整计划正文/todos |
| `command:get_plan_model_options` | `{ commandId, actionId }` | 刮取计划作用域模型菜单；只接受已注册的 plan-model action |
| `command:set_plan_model` | `{ commandId, operationId, planModelId, actionId }` | 把所选计划模型应用回 Cursor；属于危险写命令 |
| `command:switch_window` | `{ commandId, windowId }` | 切换到不同 Cursor 窗口 |
| `command:click_action` | `{ commandId, actionId, actionType, operationId? }` | 点击已注册动作。缺少有效 `actionId`/`actionType` 时拒绝；`approve`、`approve_all`、`allow`、`run`、`build`、`continue`、`skip`、`questionnaire_option` 要求 bounded `operationId`，`reject` 和只读动作不要求 |

每个客户端命令包含一个 `commandId`（UUID），会在 `command:result` 中回显以便关联。问卷回答没有单独的 socket 事件；Web 客户端通过 `command:click_action` 发送选项/Skip/Continue 的 `actionId`。`SIDE_EFFECT` 按动作显式批准：点 Plan **Build** 只授权 `build`，不授予 Run/Approve/Allow/Mode/Model/adapter apply。授权级别与验收分层见 §15 和 `docs/cursor-capability-sync-plan.md` 第 21 节。

---

## 6. UI/UX 规格

### 6.1 布局

移动优先、单列布局，匹配 Cursor 的深色主题。五个固定区域：

1. **页头**（顶部固定）：连接指示器 + agent 状态
2. **窗口栏**（页头下方）：项目级窗口选择器（仅 1 个窗口时隐藏）。点一个窗口会把主（长生命周期）CDP 连接移到该 target；其他窗口继续并行轮询。
3. **Tab 栏**（窗口栏下方）：活动/主窗口内的聊天 tab 选择器（≤ 1 个 tab 时隐藏）
4. **消息**（可滚动中间）：带按类型渲染的带类型聊天元素
5. **页脚**（底部固定）：审批栏（条件显示）+ 问卷栏（条件显示）+ mode/model 药丸 + 消息输入

### 6.2 聊天元素

每种 `ChatElement` 类型渲染方式不同：

- **人类消息**：右对齐气泡，纯文本和 mention 徽章
- **助手消息**：左对齐气泡，来自 Cursor markdown 渲染器的净化 HTML（仅散文：粗体、列表、行内代码、链接）。composer/Shiki widget 根从 `html` 中剥离，因此页面不依赖 VS Code 主题 CSS。**代码和 diff** 从结构化 `codeBlocks` 渲染（`CodeBlockItem`：`blockKind` 为 `code` 或 `diff`，可选 `filename`/`language`，`code` 文本，diff 还有带 `add`/`rem`/`ctx`/`meta`/`hunk` 的 `diffLines`）。块追加在散文气泡之后。每个块显示工具栏（已知时显示文件名或语言 + **全屏** 控件）。主体位于 **`.code-block-viewport`**：最多约 **7 行** 高，溢出可 **滚动**；全屏打开模态框（移动端 safe area，点背景或 Escape 关闭，大号关闭控件）。
- **工具调用**：紧凑单行，带状态图标、操作名、目标详情，以及可选的带 +/- 变更统计（绿/红）的文件名。**Edit / 文件审阅工具** 可能包含 **`diffBlock`**：与助手代码块相同的 `CodeBlockItem` 形状，渲染在摘要下的 **`.tool-diff-host`** 中，具有相同的视口、滚动和全屏行为。
- **Thought block**：静音色单行：“Thought for Xs”
- **Plan widget**：丰富卡片，带标题、描述、带彩色状态点的可滚动 todo 列表、进度条和操作按钮（Build、View Plan），以及 Web UI 中的完整计划模态框和计划作用域模型选择器。见 §6.9。
- **Todo 列表**：信息性卡片，带标题和带状态图标的 todo 行（无操作按钮）。
- **Run command**：命令卡片，带描述页头、等宽命令文本和操作按钮（Run、Skip、Allow）。见 §6.10。
- **Loading 指示器**：三个动画点

### 6.3 审批栏

- 当 `pendingApprovals.length > 0` 时出现在消息和输入之间
- 两个大按钮：Approve（绿）和 Reject（红）
- 最小 48px 按钮高度，便于可靠的移动端点按
- 没有剩余审批时消失

### 6.4 消息输入

- 全宽文本区域 + 圆形发送按钮
- Enter 发送（桌面上 Shift+Enter 换行）
- 文本通过 CDP 的 `Input.insertText` + Enter 的 `Input.dispatchKeyEvent` 提交

### 6.5 窗口选择器

- 显示所有已发现的 Cursor 窗口（URL 中含 `workbench` 的 CDP page target）
- 窗口标题是从窗口标题提取的项目名（去掉文件名前缀和 ` - Cursor` 后缀）
- **主（home）** 窗口持有长生命周期 CDP 连接，并以 `POLL_INTERVAL_MS` 持续轮询
- 其他窗口由 `WindowMonitor` 每 10s 并行轮询（临时 CDP 连接；不改变 Cursor 的焦点窗口）
- 活动/主窗口高亮；点按发出 `command:switch_window`，把主连接移到该 target（`cdp-bridge.switchWindow`）
- 只打开一个 Cursor 窗口时隐藏
- 窗口列表每 10 秒刷新

### 6.6 聊天 Tab 栏

- 显示从 `.agent-sidebar-cell` 元素（较新构建为 glass sidebar 行）提取的所有打开聊天 tab
- 活动 tab 高亮，点按通过基于标题的匹配切换
- 1 个或更少 tab 时隐藏

### 6.7 状态指示器

- **连接圆点**：绿（已连接）、黄（重连中）、红（已断开）。若 CDP 已连接但提取停滞，标签会反映 `extractorStatus`（`waiting` / `stale`），而不是笼统的浏览器断开。
- **Agent 状态**：带活动描述的文本标签（Idle、Thinking、Running tool、Needs approval、Error）

### 6.8 视觉设计

- 匹配 Cursor 实际颜色的深色主题（`#181818` 背景，`rgba(228,228,228,0.92)` 文本）
- 所有颜色使用 CSS 自定义属性
- 代码/工具描述用等宽字体，聊天文本用无衬线字体
- 无外部 CSS 框架

### 6.9 Plan widget

丰富的交互卡片，镜像 Cursor 的计划 UI。当 `PlanBlock` 填充了 `todos` 数组时渲染（widget 变体）。

**布局**：

- **页头**：计划文件名（静音、小）+ 标题（粗体）
- **描述**：标题下方的概述文本（若存在）
- **Todo 列表**：可滚动列表（最大高度约 200px）的 todo 项，每项带：
  - 状态点：绿（completed）、蓝（in_progress）、灰（pending）
  - Todo 文本
  - 若 widget 有隐藏项，折叠的 “N more” 指示器
- **进度条**：带填充部分的轨道 + “N/M” 文本标签
- **操作行**：左侧 “View Plan” 文本按钮 + 中间模型名/选择器 + 右侧 “Build” 主按钮

**行为**：

- “Build” 用 Build 按钮的 `actionId`（`actionType: 'build'`）发出 `command:click_action`。这只授权这一次 Build，不授予 Run/Approve/Allow/Mode/Model/adapter apply
- “View Plan” 打开 Web 模态框；当有已保存的计划文件时，模态框从磁盘加载完整计划正文和 todo 列表，使手机视图与 Telegram 的完整计划视图一致
- 点模型药丸打开 Web 侧选择器，选项来自 Cursor 当前计划模型菜单，再把所选选项应用回 Cursor
- 计划执行期间 todo 状态变化时，卡片就地更新

### 6.10 Run command widget

当 agent 想执行 shell 命令时显示的交互式命令审批卡片。

**布局**：

- **页头**：描述文本（例如 “Run outside sandbox:”）+ 静音色的命令 candidates
- **命令块**：等宽字体的完整命令文本，深色背景，长命令可水平滚动。带 `$` 提示符前缀。
- **操作行**：左侧 “Skip” 文本按钮 + 右侧 “Run” 主按钮。需要 sandbox 权限时出现 “Allow” 按钮。

**行为**：

- “Run” / “Skip” / “Allow” 各自用对应按钮的 `actionId` 发出 `command:click_action`，`actionType` 必须精确匹配。一般 Build 或其他动作的授权不能复用到这些按钮
- 缺少 `actionId` 时按钮不可执行；不得回退到客户端 `selectorPath` 授权

### 6.11 原生代码块与 diff（`codeBlocks`、`diffBlock`、Web UX）

**数据模型**（`src/server/types.ts` — `CodeBlockItem`）：

- `blockKind`：`'code'` | `'diff'`
- `filename`、`language`（可选）
- `code`：纯块的扁平文本，保留真实换行（面向行的回退，不是原始 `textContent`）
- `diffLines`（当 `blockKind === 'diff'`）：`{ kind: 'add'|'rem'|'ctx'|'meta'|'hunk'; text: string }[]` — kind 来自提取器中的现场 Monaco 行装饰，不是解析镜像 HTML。

**助手**：`html` **仅** 为 `.markdown-root` 的 innerHTML（散文）。DOM 提取器从 `composer-code-block-container` / `composer-message-codeblock` / 相关路径构建 **`codeBlocks`**，不把 composer widget HTML 合并进 `html`。

**工具（edit / review）**：当存在匹配的 composer 块时，**`diffBlock`** 携带相同的结构化形状；Web 客户端在 **`.tool-diff-host`** 中渲染它。

**没有 Monaco diff 的 patch 文本**：若 Cursor 发出纯 patch / unified-diff 文本（例如普通代码块内的 `@@` hunk 和 `+` / `-` 行），提取器会把它升级为 `blockKind: 'diff'`，以便原生渲染器仍显示红/绿行样式，而不是扁平原始代码块。

**Web 客户端**（`src/client/app.js`、`src/client/styles.css`）：

- **`createNativeBlockFromItem`**：工具栏 + **`.code-block-viewport`**（通过 CSS 变量 `--cb-font`、`--cb-lh`、`--cb-lines` 限制最大高度约 7 行）+ 内部 `.code-block-diff-plain`（diff 行或 `<pre><code>`）。
- **全屏**：expand 控件打开 **`.code-block-fs-overlay`**（模态、`aria-modal`、safe-area 内边距、面板主体惯性滚动）。关闭：控件、背景或 Escape。打开时锁定 body 滚动。
- **移动端**：expand 和 close 的最小触摸目标 **44×48px**；滚动区域 `-webkit-overflow-scrolling: touch`；`overscroll-behavior: contain`。

**Telegram**：`formatter.ts` 在适用时使用结构化 `codeBlocks` / diff 行前缀，把 composer 节点映射为 `<pre><code>`（无 Monaco 镜像）。

**限制**：若 Cursor 尚未绘制编辑器行（折叠的 widget），`codeBlocks` / `diffBlock` 可能为空，直到之后的轮询。

---

## 7. DOM 提取策略

### 7.1 挑战

Cursor 是基于 VS Code 的 Electron 应用。其 DOM 使用会在版本之间变化的生成 class 名。没有用于访问聊天状态的公开 API。

### 7.2 方法 — 由 data 属性驱动的提取

Cursor 的聊天 DOM 使用可靠的 `data-*` 属性做结构化识别：

- `data-flat-index="N"` — 每个消息包装器上的顺序索引（较旧构建）
- `data-message-index="N"` — Cursor 3.8+ 上的顺序索引；部分 AI 行只有这个，没有 `data-flat-index`
- `data-message-role="human|ai"` — 消息作者
- `data-message-kind="human|assistant|tool"` — 消息类型
- `data-message-id="UUID"` — 稳定的消息标识符
- `data-tool-call-id="ID"` — 工具调用标识符
- `data-tool-status="loading|completed"` — 工具执行状态
- `data-compact="true"` — 折叠的工具摘要

提取函数选择聊天容器内所有匹配 `[data-flat-index], [data-message-index], .composer-rendered-message[data-message-role], [data-message-role][data-message-id]` 的元素，然后用 `data-message-role` + `data-message-kind`（以及相关指示器）分类每个元素并提取类型特定内容：

| 类型 | DOM 指示 | 提取的内容 |
| ----------- | ----------------------------------------------------- | ----------------------------------------------------- |
| human | `role=human`，`kind=human` | `.aislash-editor-input-readonly` 文本、`.mention` 元素 |
| assistant | `role=ai`，`kind=assistant` | `.markdown-root` innerHTML + textContent；来自 composer 代码 widget 的 `codeBlocks` |
| tool | `role=ai`，`kind=tool` | `data-tool-call-id`、`data-tool-status`、`.ui-tool-call-line-action/details`、edit 统计 |
| plan | `role=ai`，`kind=tool` + `.composer-create-plan-container` | 计划文件名、标题、描述、带状态的 todo 项、Build/View Plan 选择器、模型 |
| plan（legacy） | `.plan-execution-message-content` | 标签、标题、todo 摘要计数 |
| todo_list | `.todo-list-container` | 标题、todo 项及状态 |
| run_command | `role=ai`，`kind=tool` + `.composer-terminal-tool-call-block-container` | 描述、candidates、完整命令文本、Run/Skip/Allow 按钮选择器 |
| thought | `.ui-collapsible.ui-step-group-collapsible` | 来自页头 span 的时长 |
| loading | `.loading-indicator-v3` | 仅存在性 |

对于 data 属性系统之外的元素（聊天容器、输入、approve/reject 按钮、状态、tab、mode/model），使用来自 `selectors.json` 的 CSS 选择器，采用级联策略。

### 7.3 发现工具

CLI 工具（`src/discovery/discover-dom.ts`，通过 `npm run discover` 运行）经 CDP 连接到 Cursor 并：

1. 列出所有 CDP target（页面、webview、worker）
2. 转储主窗口的摘要 DOM 树
3. 搜索匹配聊天/agent 模式的元素
4. 输出建议的 `selectors.json` 选择器

### 7.4 轮询与 Diff

- 提取器每 `POLL_INTERVAL_MS` 运行一次（`src/server/config.ts` 中默认 **300ms**；扩展设置 `cursorRemote.pollIntervalMs` 默认为 **500ms**，作为环境变量传入）
- `DEBOUNCE_MS` 的防抖（`config.ts` 中默认 **150ms**；扩展设置 `cursorRemote.debounceMs` 默认为 **300ms**）防止流式输出时的广播风暴
- 状态管理器对每个顶层字段做深度比较（JSON.stringify）
- 只有变更字段包含在 `state:patch` 事件中

---

## 8. 配置

全部配置通过带合理默认值的环境变量：

**核心**：

| 变量 | 默认值 | 说明 |
| ------------------ | -------------------------- | ---------------------------------------- |
| `CDP_URL` | `http://127.0.0.1:9222` | Cursor 的 CDP 端点 |
| `SERVER_PORT` | `3000` | Web 客户端 + socket.io 的端口 |
| `SERVER_HOST` | `127.0.0.1` | 绑定地址（仅 localhost；局域网设 `0.0.0.0`） |
| `POLL_INTERVAL_MS` | `300` | 主窗口 DOM 轮询频率，单位 ms（`config.ts`） |
| `DEBOUNCE_MS` | `150` | 最小广播间隔，单位 ms（`config.ts`） |
| `SELECTORS_PATH` | `./selectors.json` | DOM 选择器配置路径 |
| `LOG_LEVEL` | `info` | 日志详细程度（debug/info/warn/error） |
| `WEBAPP_PASSWORD` | `""`（空） | Web 客户端密码。空 = 无认证（独立运行）。扩展自动生成并存在 VS Code Settings（`cursorRemote.webappPassword`），不是 SecretStorage。 |
| `WINDOW_TITLE_QUALIFIER` | `true` | 在窗口标题中包含远程限定符（WSL/SSH） |
| `DATA_DIR` | `./data` | 持久数据目录 |

**Telegram 传输层**：

| 变量 | 默认值 | 说明 |
| ------------------------ | -------- | ------------------------------------------------ |
| `TELEGRAM_ENABLED` | `false` | 启用或禁用 Telegram 传输层 |
| `TELEGRAM_BOT_TOKEN` | — | 来自 @BotFather 的 bot token（启用时必填） |
| `TELEGRAM_ALLOWED_USERS` | — | 可选：硬编码允许的用户 ID（覆盖 token 认证） |
| `TELEGRAM_IMPL` | `grammy` | `grammy`（默认）或 `raw`（基于 fetch 的回退） |

扩展 spawn 服务器时，会从 VS Code 设置填充这些值。扩展贡献默认值有两项与 `config.ts` 不同：`cursorRemote.pollIntervalMs` 为 **500**，`cursorRemote.debounceMs` 为 **300**。这些值作为 `POLL_INTERVAL_MS` / `DEBOUNCE_MS` 传入并覆盖服务器默认值。`.env.example` 使用 500/300 以匹配扩展默认值。Web 客户端密码是 Settings 中的 `cursorRemote.webappPassword`（不是 SecretStorage）。Telegram bot token 通过设置面板存在 SecretStorage。

---

## 9. 技术要求

### 9.1 服务器

- Node.js 20+
- 严格模式 TypeScript
- 自定义轻量 CDP 客户端（`ws` 库）— 不是 Puppeteer（被 Electron 拦截）
- `express` 用于 HTTP 静态服务
- `socket.io` 用于带自动重连和传输回退的 WebSocket
- `grammy` 用于 Telegram Bot API（TypeScript 优先，支持 Bot API 9.5、论坛话题、内联键盘）
- `node-html-parser` 用于把 Cursor 的复杂 HTML 转为 Telegram 安全 HTML（DOM 树遍历）
- `tsx` 用于开发（通过 `tsx watch` 执行 TypeScript 并热重载）

### 9.2 客户端

- 原生 HTML/CSS/JavaScript（无框架，无构建步骤）
- socket.io 客户端由服务器自动提供
- 适用于现代移动浏览器（Safari iOS 15+、Chrome Android 90+）
- 无外部 CDN 依赖

### 9.3 宿主环境

- 以 `--remote-debugging-port=9222` 运行的 Cursor IDE（Windows、macOS 或 Linux）
- 中继服务器运行在同一台机器上（或 Windows 主机上的 WSL2）
- 手机与主机在同一局域网，或通过 Tailscale / 类似 VPN 连接

---

## 10. 关键技术决策

### 10.1 自定义 CDP 客户端 vs Puppeteer

**决策**：使用 `ws` 直接实现的自定义轻量 CDP 客户端。

**理由**：Electron/Cursor 会拦截 Puppeteer 需要的 `Target.getBrowserContexts`。我们的客户端直接连接到页面 target 的 WebSocket URL，绕过浏览器级 API 调用。

### 10.2 用 CDP Input 域输入文本

**决策**：用 `Input.insertText` 和 `Input.dispatchKeyEvent` 输入。

**理由**：Cursor 的聊天 composer 使用 ProseMirror/TipTap。DOM 级方法（`document.execCommand`、`element.value=`）会绕过 ProseMirror 的内部状态模型。CDP 的 Input 域走 Chromium 原生输入管道，ProseMirror 能正确处理。

### 10.3 Data 属性提取 vs 基于 Class 的选择器

**决策**：用 `data-flat-index` / `data-message-index`、`data-message-role`、`data-message-kind` 提取消息。

**理由**：Class 名是生成的，会在 Cursor 版本之间变化。Data 属性是语义化且稳定的 — 它们表示 Cursor 的内部数据模型。

---

## 11. 实现状态

| 功能 | 状态 | 备注 |
| --------------------------- | ----------- | --------------------------------------------- |
| CDP 连接 + 发现 | 完成 | 自定义 CDP 客户端，target 自动发现 |
| 多窗口支持 | 完成 | 主窗口：持久 CDP 连接 + 持续轮询。其他窗口：每 10s 并行 CDP 轮询（`window-monitor.ts`）。`switchWindow` 移动主窗口。 |
| DOM 提取（消息） | 完成 | 通过 data 属性提取带类型的 ChatElement |
| DOM 提取（tab/mode） | 完成 | `.agent-sidebar-cell` / glass sidebar tab + 来自下拉的 mode/model |
| 状态管理 + diff | 完成 | JSON diff、防抖广播、窗口与 DOM 分开跟踪 |
| 消息发送 | 完成 | 通过 CDP 的 Input.insertText + Enter |
| 审批按钮 | 代码已落地 | 文本匹配用于展示；点击授权走 ActionRegistry `actionId`。真实 Tool/审批 SIDE_EFFECT live 本批次未宣称通过 |
| 聊天 tab 切换 | 完成 | 通过 JS `.click()` 在 `.agent-sidebar-cell` 上基于标题匹配 |
| Mode 切换 | 代码已落地 / isolated tests | 受动态能力目录约束；Telegram Mode E2E deferred |
| Model 切换 | 代码已落地 / isolated tests | 受 completeness 约束；Telegram Model E2E deferred |
| 现场模型列表 | 完成 | `getModelOptions` 刮取 Cursor 的模型菜单（不再硬编码模型 ID） |
| 移动端模型菜单 | 完成 | MAX 开关、分类、brain 徽章 |
| 移动 Web 客户端 | 完成 | 按类型聊天渲染、匹配 Cursor 的主题 |
| 自动重连 | 完成 | CDP 和 socket.io 两侧 |
| 浏览器通知 | 完成 | 待审批、run command 提示和工具级操作（Fetch、Edit 等） |
| Plan widget 提取 | 完成 | `.composer-create-plan-container` → 带 todos、actions 的结构化 PlanBlock |
| Plan widget Web 渲染 | 完成 | 带 todo 列表、Build/View Plan 按钮的丰富卡片 |
| Run command 提取 | 完成 | `.composer-terminal-tool-call-block-container` → 带命令文本、actions 的 RunCommand |
| Run command Web 渲染 | 完成 | 带等宽文本、Run/Skip/Allow 按钮的命令卡片 |
| 原生代码 / diff（Web） | 完成 | `codeBlocks` / `diffBlock` → `.native-code-block`；约 7 行视口 + 滚动 + 全屏模态；无 Monaco HTML 镜像 |
| 问卷 | 代码已落地 | Web 栏 + Telegram 内联键盘走 `actionId`；Telegram Action E2E deferred |
| 传输层抽象 | 完成 | Transport 接口、SendQueue、MessageTracker、WindowMonitor |
| Telegram 传输层 | 完成（监视） / 控制 E2E deferred | grammy bot（raw 回退）、自动同步、/register 认证、并行 CDP、内联键盘。Mode/Model/Action/Tool live E2E 见 §15 |
| ActionRegistry | 代码已落地 / isolated tests | 不透明 action id、TTL、一次性消费、跨 generation 拒绝。**不宣称**真实 Tool 副作用已通过 |
| Adapter apply 激活 | **本批次禁用** | `POST /api/adapters/:id/apply` 稳定返回 `503 ADAPTER_ACTIVATION_UNAVAILABLE`。Mode 候选保持 pending，当前 selector 路径继续生效 |
| 安装文档 | 完成 | `docs/setup-guide.md`、`docs/tailscale-setup.md`、`docs/telegram-troubleshooting.md` |
| VS Code 扩展外壳 | 完成 | 见 `docs/extension_prd.md` |

---

## 12. 风险与缓解

| 风险 | 影响 | 可能性 | 缓解 |
| ---- | ------ | ---------- | ---------- |
| Cursor 版本之间 DOM 结构变化 | 提取中断 | 高 | Data 属性提取 + 外置选择器 + 发现工具 |
| 按 token 流式输出造成广播风暴 | 高 CPU/带宽 | 高 | 防抖广播，发送 diff 而不是完整状态 |
| WSL2 网络阻止手机访问 | 客户端连不上 | 中 | 记录 mirrored mode 和端口转发配置 |
| ProseMirror 拒绝程序化输入 | 消息发送失败 | 低 | CDP Input 域走原生 Chromium 管道 |
| Cursor 更新改变审批按钮布局 | Approve/reject 停止工作 | 高 | 文本内容匹配回退，发现工具用于重新映射 |
| 多个 Cursor 窗口共享一个 CDP 端口 | 命令发到错误窗口 | 低 | 主窗口长连接用于命令；其他窗口并行轮询；选择器通过 `switchWindow` 移动主窗口 |
| 元素 ID 包含点或冒号 | CSS 选择器路径损坏 | 中 | 在 `buildSelectorPath` 中转义特殊字符 |
| Telegram 消息编辑限流 | 更新丢失或延迟 | 低 | 主轮询 300ms + 防抖 150ms（`config.ts`）仍远低于 Telegram 的约 30/秒限制；SendQueue 控制出站编辑节奏 |
| Telegram 4096 字符消息限制 | 长助手消息被截断 | 中 | 拆成多条消息，跟踪每个元素的全部 message ID |
| Telegram callback_data 64 字节限制 | 无法编码完整选择器路径 | 高 | callback data 中选择器路径的基于 hash 的查找表 |
| Cursor 版本之间 plan widget DOM 变化 | 计划提取中断 | 中 | 按 `.composer-create-plan-container` class 检测，回退到 legacy `.plan-execution-message-content` |
| Run command widget 变体（sandbox、allow） | 缺少按钮或分类错误 | 中 | 按 `.composer-terminal-tool-call-block-container` 检测，按 class 模式提取全部按钮 |
| 非主窗口/tab 状态在 Telegram 中滞后 | 话题更新比主窗口慢 | 中 | `WindowMonitor` 每 10s 并行轮询非主窗口；入站命令 `switchWindow` 到目标，使操作打到正确 composer |
| 统一 agent 侧栏把其他项目的 tab 混进来 | 错误的 Telegram 话题配对 | 中 | 按窗口标题 / composerId 限定 tab；`/resync` 和 `/dedupe` 作为手动修复。见 `docs/topic-routing-analysis.md` |
| macOS 后台节流 | 提取变 stale，手机停止更新 | 中 | `extractorStatus: stale`、退避、把 Cursor 拉回前台 |

---

## 13. 后续路线图

- **Discord 传输层**：复用 Transport 接口做 Discord bot（threads 作为话题）
- **Web 代码 UX**：可选复制到剪贴板、可配置的行内预览高度（默认约 7 行）
- **自动审批规则**：可配置规则，例如 “自动批准 read 操作”
- **PWA**：Service worker + manifest，支持 “添加到主屏幕”
- **推送通知**：Web Push API，浏览器关闭时也能提醒
- **动态 mode 列表**：从 Cursor 的 DOM 提取可用 mode（PassiveProbe 当前值已旁路；完整菜单属 INTERACTIVE）。Mode 候选保持 pending，本批次不激活 adapter apply
- **ADAPTER_APPLY**：生产 `AdapterRegistry` 接入真实 Cursor build + DOM fingerprint 之后，才能解除 `503 ADAPTER_ACTIVATION_UNAVAILABLE`

---

## 14. 成功标准

当满足以下条件时，认为**产品**成功。本批次是否已经验到对应层级，以 §15 为准：代码实现、isolated tests、PASSIVE live、SIDE_EFFECT live 必须分开记录。不得把 isolated tests 写成真实 Tool 副作用已通过。

**Web 客户端**（产品目标；标了 SIDE_EFFECT 的项本批次未宣称 live 通过）：

1. 中继服务器通过 CDP 连接到正在运行的 Cursor IDE
2. 手机上的 Web 客户端以正确格式显示 agent 对话
3. 每种聊天元素类型渲染方式不同（human、assistant、tool、thought、plan widget、todo_list、run command）
4. Plan widget 显示带状态指示器的完整 todo 列表，Build/View Plan 按钮在有 `actionId` 时可用
5. Run command widget 显示完整命令文本，Run/Skip/Allow 按钮在有 `actionId` 时可用
6. 在手机上点 Approve/Reject 会触发 Cursor 中的操作（`SIDE_EFFECT`，需按动作显式批准）
7. 从手机输入并发送的消息出现在 Cursor 的 composer 中并提交
8. 可以从手机切换聊天 tab、mode 和 model（Mode/Model 属 `SIDE_EFFECT` / 菜单属 `INTERACTIVE`）
9. 系统从临时连接中断中自动恢复；连接层与能力层状态可区分（见冒烟矩阵）
10. 从操作到反映的延迟低于 2 秒

**Telegram 传输层**：

11. Telegram bot 连接，用户用 `/register <token>` 注册，`/sync` 启用到论坛群的自动同步
12. 启用同步后，为新窗口和聊天 tab 自动创建话题。主窗口使用长生命周期 CDP 连接；其他窗口每 10s 并行轮询（不切换 Cursor UI）
13. 活动窗口+tab 的对话以正确格式流进其 Telegram 话题（初始同步最近 5 条消息）
14. `/history [N]` 以限流节奏把最近 N 条消息（默认 5）发进话题
15. 每种 ChatElement 类型以适当的 Telegram 格式渲染（HTML、代码块、内联键盘）
16. 审批内联按钮（Accept/Reject/Accept All）触发 Cursor 中的正确操作 — **本批次 E2E deferred**
17. Run command 卡片显示命令，并提供 Run/Skip/Allow 内联按钮 — **Tool E2E deferred**
18. Plan widget 显示 todo 列表，并提供 Build/View Plan 内联按钮 — **Action E2E deferred**
19. 在话题中输入会把文本作为消息发到映射的 Cursor 窗口+tab
20. `/mode` 和 `/model` 命令显示当前状态，并允许通过内联键盘切换 — **Mode/Model E2E deferred**
21. agent 活动时 bot 显示输入指示器
22. 所有出站 API 调用通过 SendQueue 限流（Telegram 传输层约 300ms 发送、100ms 编辑）+ auto-retry 插件
23. 基于 token 的认证（`/register`），可选 `TELEGRAM_ALLOWED_USERS` 覆盖。数据持久化在 `data/` 目录。

**本批次明确非成功项**：

- Adapter apply 激活**不可用**。`POST /api/adapters/:id/apply` 稳定 `503 ADAPTER_ACTIVATION_UNAVAILABLE` 才算符合本批次合同。
- Mode 候选保持 pending；当前 selector 路径保持活动。
- 不得宣称真实 Tool 副作用已验收通过。

---

## 15. 本批次验收：授权级别与证据分层

完整字段、脱敏规则和 `caseId` 清单见 `docs/cursor-capability-sync-plan.md` 第 21 节。冒烟步骤见 `docs/smoke-checklist.md`。

### 15.1 授权级别

| 级别 | 允许 | 本批次 |
| --- | --- | --- |
| `PASSIVE` | 只读探测、GET、收 socket 状态 | 默认允许 |
| `INTERACTIVE` | 显式刷新时开/关菜单，不选择 | 仅 “Refresh Cursor capabilities” |
| `SIDE_EFFECT` | 单个 `actionId` + `actionType` 的状态变更 | **按动作显式批准**。一般 Build 不授予 Run/Approve/Allow/Mode/Model |
| `ADAPTER_APPLY` | 激活 pending adapter、切换生产 selector | **禁用**；503 `ADAPTER_ACTIVATION_UNAVAILABLE` |

### 15.2 证据层

必须分开记录，禁止混报：

1. `code_implemented` — 组合根已接线
2. `isolated_test` — 无真实 Cursor 的测试
3. `passive_live` — 真实 Cursor 只读（含双 workbench target 报告）
4. `side_effect_live` — 真实点击副作用；本批次 **不** 把 Tool 标为 pass

Telegram Mode / Model / Action / Tool E2E = `deferred`。

### 15.3 机器可读证据与脱敏

每条用例输出 `AcceptanceEvidenceRecord`（`schemaVersion: 1`）：`caseId`、`authorizationLevel`、`evidenceLayer`、`result`（`pass|fail|deferred|blocked`）、`observedAt`，以及可选的 `httpStatus` / `errorCode` / `capabilityState` / `adapterStatus` / `selectorPathActive`。禁止写入密码、token、cookie、WebSocket URL、完整聊天、完整 DOM、未截断路径、可执行 selector、未哈希 action id。路径与 URL 规则与 `redactDiscoveryText` 一致。

### 15.4 本批次必须覆盖的冒烟面

- Web 连接/能力状态矩阵（reconnect awaiting-full、CDP vs pills、extractor stale、caps stale、generation lock、unavailable vs degraded、ok+partial Model、恢复）
- HTTP/Socket：session、外域 Origin、CSRF、Bearer CLI、`X-Operation-Id` 去重与冲突、速率限制、JSON 400/413
- 双 target PASSIVE 报告：两个 workbench 隔离、排除 webview、preferred 保持、无 UI mutation、不把未开菜单写成 empty/removed
- ActionRegistry 负向（缺 id、过期、已消费、scope/generation、selector 不授权）与正向（reserve/consume、类型隔离、Build ≠ Run）；正向不是 live Tool 通过
- Adapter apply：确认后仍 503；pending 不变；当前 selector 路径仍活动
- Telegram Mode/Model/Action/Tool E2E：标记 deferred，不勾 pass