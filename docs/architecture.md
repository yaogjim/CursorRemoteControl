# 架构 — CursorRemote

## 1. 高层概览

系统有三层，由两条协议桥连接：

```
Cursor IDE  ←──CDP──→  Relay Server  ←──socket.io──→  Phone Client
(local Electron)        (Node.js)                     (Browser)
                         └── Telegram Bot API ──→ Telegram
```

- **Cursor IDE** 是以 `--remote-debugging-port=9222` 启动的原版 Electron 应用。它通过 WebSocket 暴露 Chrome DevTools Protocol。我们不以任何方式修改 Cursor。
- **中继服务器** 是 Node.js/TypeScript 进程，运行在与 Cursor 同一台机器上（Windows、macOS、Linux，或 WSL2）。一侧桥接 CDP，另一侧桥接 socket.io 和可选的 Telegram。
- **手机客户端** 是由中继提供的静态 HTML/CSS/JS 页面。它只通过 socket.io 事件通信。

最初的 Windows + WSL2 部署仍然受支持（见第 3 节）；macOS 和 Linux 上的本机安装同样是一等公民。

---

## 2. 组件架构

```
┌──────────────────────────────────────────────────────────┐
│                     Relay Server                         │
│                                                          │
│  ┌─────────────┐    ┌───────────────┐    ┌───────────┐  │
│  │  CDP Bridge  │───→│ DOM Extractor │───→│   State   │  │
│  │              │    │               │    │  Manager  │  │
│  │  CdpClient   │    │ callFunction  │    │           │  │
│  │  WebSocket   │    │ data-attr     │    │  diff     │  │
│  │  lifecycle   │    │ extraction    │    │  events   │  │
│  └──────┬───────┘    └───────────────┘    └─────┬─────┘  │
│         │                                       │        │
│         │            ┌───────────────┐          │        │
│         │            │   Command     │          │        │
│         └───────────→│   Executor    │          │        │
│                      │               │          │        │
│                      │  CDP Input    │          │        │
│                      │  evaluate     │          │        │
│                      │  approve/deny │          │        │
│                      └───────┬───────┘          │        │
│                              │                  │        │
│                      ┌───────▼──────────────────▼─────┐  │
│                      │         Relay                  │  │
│                      │  Express (static files)        │  │
│                      │  socket.io (state + commands)  │  │
│                      └────────────────────────────────┘  │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

### 2.1 CDP Client（`cdp-client.ts`）

**职责**：使用原始 WebSocket 的轻量 Chrome DevTools Protocol 客户端。

**为什么不用 Puppeteer**：Electron/Cursor 会拦截 `puppeteer-core` 连接时需要的 `Target.getBrowserContexts`。我们的客户端直接连接到页面 target 的 WebSocket URL。

**API**：

- `connect(wsUrl)` — 连接到页面 target 的 WebSocket
- `evaluate(expression)` — 带 return-by-value 的 `Runtime.evaluate`
- `callFunction(fn, ...args)` — 序列化函数 + 参数，在页面上下文中求值。注入 `__name` shim，因为 tsx/esbuild 会用 `__name()` 调用包装具名函数
- `typeText(text)` — `Input.insertText`（原生 Chromium 输入管道）
- `pressKey(key, code, keyCode, modifiers)` — `Input.dispatchKeyEvent`（keyDown + keyUp）
- `click(selector)` — evaluate 以滚动 + 点击
- `exists(selector)` — 检查元素是否存在

### 2.2 CDP Bridge（`cdp-bridge.ts`）

**职责**：发现 Cursor 窗口，建立并维持 CDP 连接，并支持窗口切换。

**多窗口支持**：所有 Cursor 窗口共享同一个 CDP 端口（9222）。每个窗口在 `/json` 上表现为单独的 `page` target。桥接发现所有 workbench 页面 target，并以 `CursorWindow[]` 暴露。

**主窗口（home）**（第一个连接的 target，或通过 `switchWindow` 选中的那个）持有长生命周期的 `CdpClient` WebSocket。DOM 提取器以 `POLL_INTERVAL_MS` 持续轮询该连接。其他窗口 **不会** 占用同一条 socket — `WindowMonitor` 每 10s（`CYCLE_INTERVAL_MS`）打开临时并行 CDP 连接，以便在不切换 Cursor 焦点窗口的情况下提取它们的聊天状态。

`switchWindow(targetId)` 仍然存在：它移动主连接（断开当前客户端，连接到新 target）。当命令必须在非主窗口中运行时使用（Web 选择器、Telegram 话题入站）。轮询本身不调用 `switchWindow`。

**工作区名称提取**：连接到 target 后，桥接运行 `Runtime.evaluate` 读取 `vscode.context.configuration().workspace.uri` — 每个 Cursor/VS Code Electron renderer 中都可用的稳定内部 API。`uri.path` 的 basename 给出项目文件夹名，`uri.authority` 提供远程限定符（WSL、SSH 等）。这与平台无关，也不受易变的 `document.title` 影响。限定符后缀（例如 `[WSL: ubuntu-24.04]`）可通过在 `.env` 中设置 `WINDOW_TITLE_QUALIFIER=false` 关闭，以得到更干净的 Telegram 话题名。对于未连接的窗口（通过 `/json` 发现但尚未轮询），桥接回退到解析 CDP target 标题：去掉 ` - Cursor` 后缀，按 ` - ` 分割，取项目段。

**生命周期**：

1. 从 `http://<CDP_URL>/json` 获取 target 列表
2. 过滤 URL 中含 `workbench` 的全部页面 → 作为 `windows` 暴露
3. 把 `CdpClient` 连接到所选（或第一个）target 的 `webSocketDebuggerUrl`
4. 向其他模块暴露 `CdpClient` 和 `activeTargetId`
5. 断开时：发出事件，以指数退避启动重连循环

**窗口切换**（`switchWindow(targetId)`）：

1. 断开当前 CdpClient
2. 发出 `disconnected`（提取器停止，执行器清空客户端）
3. 为新主窗口调用 `connect(targetId)`
4. 发出 `connected`（提取器在新的长连接上重启）

必须在非主窗口中运行的 Telegram 入站命令会调用 `switchWindow`，然后 `windowMonitor.setHomeWindow`。轮询本身不切换窗口。

**定期刷新**：每 10 秒，`WindowMonitor` 调用 `refreshWindows()`（重新获取 `/json`），然后并行轮询非主窗口。新打开或关闭的 Cursor 窗口会被发现，无需重连主 socket。

### 2.2.1 Window Monitor（`window-monitor.ts`）

**职责**：在不抢占主 CDP 连接的情况下，保持每个 Cursor 窗口的实时快照。

**行为**：

- **主窗口**：使用状态管理器来自主提取器的连续补丁（长连接 CDP）。
- **其他窗口**：每 10s 打开到每个 target 的 `webSocketDebuggerUrl` 的临时 `CdpClient`，跑一次提取，若快照变化则发出 `window:update`，然后断开。
- 并行模式：非主窗口在同一周期内轮询；Cursor UI 留在主窗口。
- 若非主 target 没有 `wsUrl`（已在别处被调试），则跳过并记录警告。

### 2.3 DOM Extractor（`dom-extractor.ts`）

**职责**：定期从 Cursor 的 DOM 提取结构化状态。

**工作方式**：

1. 提取函数通过 `client.callFunction()` 作为序列化函数传入
2. 在 Cursor 的 renderer 内，选择所有 `[data-flat-index]`、`[data-message-index]` 以及相关的 `data-message-role` 包装器（Cursor 3.8+ 对部分 AI 行使用 `data-message-index`，而不再带 `data-flat-index`）
3. 对每个元素读取 `data-message-role` + `data-message-kind` 以分类
4. 把类型特定内容提取为带类型的 `ChatElement` 对象
5. **助手消息**：`html` **仅** 为 `.markdown-root` 的 innerHTML（散文）。**`codeBlocks`** 是从 composer 代码 widget 构建的 **`CodeBlockItem`** 结构数组（Shiki 行、Monaco `.view-line` 文本、面向行的纯代码回退、diff 装饰 → 带 `add`/`rem`/`ctx`/… 的 `diffLines`）。
6. **ToolCallElement**：当 edit-review / compact / line 工具上存在 composer 代码块时，**`diffBlock`** 存储相同的 **`CodeBlockItem`** 形状，供原生 Web（和 Telegram）渲染 — 不是镜像的 widget HTML。
7. 同时提取审批按钮、基础状态 UI、聊天 tab、mode、model 信息、composer queue、问卷，以及原始活动信号（`_rawSignals`）
8. 共享辅助函数（`activity-derive.ts`）把 `_rawSignals` + 已解析消息转换为 `agentStatus`、`agentActivityText`、`agentActivityLive` 和 `agentActivitySource`，以便 Web 和 Telegram 使用同一套 live-activity 约定
9. 返回完整的 `CursorState` 对象，失败时返回 `null`

**元素分类**：

| data-message-role | data-message-kind | 结果类型 |
| ----------------- | ----------------- | ---------------- |
| human             | human             | HumanMessage 或 PlanBlock（legacy） |
| ai                | assistant         | AssistantMessage |
| ai                | tool              | PlanBlock（widget）、RunCommand、TodoListBlock 或 ToolCallElement |
| （无）            | （无）            | ThoughtBlock、LoadingIndicator，或跳过 |

在 `ai`/`tool` 分支内，分类优先级：

1. `.composer-create-plan-container` → **PlanBlock**（带 todos、actions 的 widget 变体）
2. `.composer-terminal-tool-call-block-container` → **RunCommand**（命令文本、Run/Skip/Allow）
3. `.todo-list-container` → **TodoListBlock**（独立 todo 列表）
4. `.composer-edit-file-review-wrapper` → **ToolCallElement**（edit/review 卡片；存在代码块时可选 **`diffBlock`**）
5. `.composer-tool-former-message` → **ToolCallElement**（紧凑摘要；可能包含 **`diffBlock`**）
6. `.ui-tool-call-line-action` → **ToolCallElement**（展开的工具调用行；可能包含 **`diffBlock`**）

**提取内部使用的关键 DOM 选择器**：

| 目标 | 选择器 / 属性 |
| ----------------------- | ------------------------------------------------------- |
| 消息包装器 | `[data-flat-index]`、`[data-message-index]`、`.composer-rendered-message[data-message-role]` |
| 人类文本 | `.aislash-editor-input-readonly` |
| Mentions | `.mention[data-mention-name]` |
| AI markdown 内容 | `.markdown-root` innerHTML → 助手 `html`（仅散文） |
| 代码块 | `.composer-message-codeblock`、`.composer-code-block-container`、`.ui-code-block` → `codeBlocks[]` / `diffBlock` |
| 工具结构化 diff | 工具宿主内的 composer 块 → `ToolCallElement.diffBlock`（`CodeBlockItem`） |
| 工具调用行 | `.ui-tool-call-line-action`、`.ui-tool-call-line-details` |
| 紧凑工具摘要 | `.composer-tool-former-message` |
| 编辑工具统计 | `.ui-edit-tool-call__filename`、`__additions`、`__deletions` |
| Thought 时长 | `.ui-collapsible-header span`（文本 “for Xs”） |
| Plan block（legacy） | `.plan-execution-label`、`.plan-execution-title` |
| Plan widget | `.composer-create-plan-container` |
| Plan widget 标题 | `.composer-create-plan-title` |
| Plan widget 标签 | `.composer-create-plan-label` |
| Plan widget 描述 | `.composer-create-plan-text .markdown-root` |
| Plan widget todos | `.composer-create-plan-todo-item` |
| Plan todo 状态 | `.composer-plan-todo-indicator-pending`、`-completed`、`-in_progress` |
| Plan todo 文本 | `.composer-create-plan-todo-content` |
| Plan Build 按钮 | `.composer-create-plan-build-button` |
| Plan View Plan 按钮 | `.composer-create-plan-view-plan-button` |
| Run command 容器 | `.composer-terminal-tool-call-block-container` |
| Run command 描述 | `.composer-terminal-top-header-description` |
| Run command candidates | `.composer-terminal-top-header-candidates` |
| Run command 文本 | `.composer-terminal-command-expanded-text` |
| Run skip 按钮 | `.composer-skip-button` |
| Run run 按钮 | `.composer-run-button` |
| Todo 进度 | `.todo-summary-content`（正则 `\d+ of \d+`） |
| 独立 todo 列表 | `.todo-list-container` |
| Loading 指示器 | `.loading-indicator-v3` |
| 聊天 tab | `.agent-sidebar-cell`；较新构建为 `.glass-sidebar-agent-list-container` |
| Mode | `.composer-unified-dropdown` 上的 `data-mode` |
| Model 名称 | `.composer-unified-dropdown-model` 触发器中的文本 |

聊天 tab 按窗口标题和/或 `containerComposerId` 限定到当前项目单元格，以避免 Cursor 统一 agent 侧栏把其他项目的 tab 混进来。详见 `docs/topic-routing-analysis.md`。

### 2.4 Command Executor（`command-executor.ts`）

**职责**：把远程命令转译为 Cursor DOM 上的 CDP 操作。

**命令**：

| 命令 | 实现 |
| ------- | -------------- |
| `send_message(text)` | 1. 通过选择器级联 + `evaluate()` 找到输入。2. Focus + click。3. Ctrl+A + Backspace 清空。4. 用 `Input.insertText` 输入文本。5. 用 `Input.dispatchKeyEvent` 发 Enter。 |
| `approve(selectorPath)` | Evaluate 以滚入视图 + 点击。 |
| `reject(selectorPath)` | 与 approve 相同，针对 reject 按钮。 |
| `approve_all()` | 通过文本匹配找到 “Accept All” 按钮并点击。 |
| `switch_tab(tabTitle)` | 按标题文本找到 `.agent-sidebar-cell`（或 glass sidebar 行），JS `.click()`。 |
| `new_chat()` | 通过选择器级联点击 new chat 按钮。 |
| `set_mode(modeId)` | 对 mode 下拉触发器 JS `.click()`，再对目标 mode 项 `.click()`。 |
| `set_model(modelId)` | 对 model 下拉触发器 JS `.click()`，再对目标 model 项 `.click()`。选择后验证菜单关闭。选项 ID 来自现场菜单（`getModelOptions`），不是硬编码列表。 |
| `get_model_options()` | 打开 composer 模型菜单，刮取行，返回 `{ id, label, selected }[]`。 |
| `get_plan_full(planId)` / `get_plan_model_options` / `set_plan_model` | `get_plan_full` 只接受当前 `CursorState.messages` 中 plan 的不透明 ID，中继从当前状态解析文件名并读取 `~/.cursor/plans` 下有界的普通非符号链接文件；其余命令刮取计划作用域模型菜单并把所选计划模型应用回 Cursor。 |
| `click_action(selectorPath)` | 通用操作按钮点击。Evaluate 以滚入视图 + JS `.click()`。用于带 `selectorPath` 提取的 Run、Skip、Allow、Build、View Plan 和问卷按钮。 |

**为什么用 CDP Input 域输入文本**：Cursor 的聊天 composer 使用 ProseMirror/TipTap。DOM 级方法（`document.execCommand`、`element.value=`）会绕过 ProseMirror 的内部状态模型。CDP 的 `Input.insertText` 和 `Input.dispatchKeyEvent` 走 Chromium 原生输入管道，ProseMirror 通过 `beforeinput`/`input` 事件处理程序正确处理。

**重试策略**：最多 2 次重试，间隔 500ms。返回 `{ ok: boolean, error?: string }`。

### 2.5 State Manager（`state-manager.ts`）

**职责**：对连续状态做 diff，并发出细粒度变更事件。

**算法**：

1. 从提取器接收新的 `CursorState`
2. 用 JSON.stringify 比较每个顶层字段与上一状态
3. 构建只含变更字段的 patch 对象
4. 对补丁做防抖（`DEBOUNCE_MS`；`config.ts` 中默认 **150ms**，从扩展设置启动时为 **300ms**），以防止流式输出时的广播风暴
5. 发出 `state:patch` 事件

提取返回 `null` 时，`onExtractionFailure` 递增失败计数，并把 `extractorStatus` 设为 `stale`（若曾成功过）或 `waiting`。连续 10 次失败后记录警告，提示选择器可能需要更新，或 Cursor 窗口可能被后台节流。`_rawSignals` 会从 socket 面向的 `state:full` / `state:patch` 中剥离（`toPublicState` / `toPublicPatch`）；可通过 `/debug/state` 检查。

**由桥接管理的字段**：`windows` 和 `activeWindowId` 不由 DOM 提取填充（提取只看到一个窗口）。它们由 `index.ts` 在 CDP 桥接连接或刷新后调用 `updateWindows()` 设置。应用提取时，diff 会保留这些字段。

**发出的事件**：

- `state:patch` — 部分状态变更
- `connection:changed` — CDP 连接状态翻转（Web 传输层把它作为 socket.io 的 `connection:status` 转发出去）

### 2.6 传输层

系统使用与传输无关的架构。状态管理器发出事件；任意数量的传输层可以独立订阅。每个传输层处理自己的连接生命周期、客户端格式和命令路由。

#### Web 传输层（`relay.ts`）

**职责**：提供 Web 客户端，并把 socket.io 与后端桥接。

**HTTP**：

- `GET /` → 把 `src/client/` 作为静态文件提供
- `GET /health` → 返回 `{ ok, authRequired, sessionValid, connected, extractorStatus, lastExtractionAt, consecutiveExtractionFailures, lastExtractionError, agentStatus, clients, uptime, windows, activeWindowId, mode, model, chatTabCount, pendingApprovalCount, generation }`。未认证的局域网客户端只收到公开精简体（`ok`、`authRequired`、`sessionValid`）。
- `GET /debug/state` → 完整内部状态（含 `_rawSignals`）；启用密码时需要会话

**socket.io**：

- 新连接时：发送 `state:full`
- 把 `command:*` 事件路由到 Command Executor
- 把 `command:switch_window` 路由到 CDP Bridge（`switchWindow` 移动主连接）
- 把状态管理器事件转发给所有已连接 socket

**Web 客户端**（`src/client/app.js`、`src/client/styles.css`、`src/client/index.html`）：

- 这是对 `CursorState` 的客户端投影。布局重构不改变 `CursorState`、socket.io 命令事件、CDP 提取、Telegram 传输或动作授权；继续只使用服务端颁发的 `actionId`。
- 信息架构：两层顶部（品牌状态层 + 项目会话层）、唯一 `#messages` 主滚动区、条件式阻塞层（审批提醒或问卷入口）、输入区（mode/model + 发送）。主题和能力诊断在系统面板中；Windows & Sessions 抽屉只负责窗口和会话。
- 可映射审批只在消息卡片内提交 Run/Skip/Allow；`#approval-bar` 显示摘要和定位。不可映射 / `approve_all` / legacy 审批保留 Accept/Reject 和 `submitApproval()`。问卷使用紧凑入口 + 半屏面板，命令载荷不变。
- 把 `ChatElement` 类型渲染进 `#messages`；助手 HTML 经过 `sanitizeHtml`（剥离脚本、事件处理程序，以及嵌入的 composer/Shiki 根）。
- **原生代码/diff**：`createNativeBlockFromItem()` 构建带工具栏（标题 + 全屏）的 `.code-block.native-code-block`，**`.code-block-viewport`** 限制约 7 行（`--cb-font`、`--cb-lh`、`--cb-lines`）并可滚动，结构化 diff 使用绿/红行样式。助手 **`codeBlocks`** 追加在散文之后；工具 **`diffBlock`** 挂在 **`.tool-diff-host`** 下（`syncToolDiffHost` / `updateToolEl`）。纯 patch 文本也会在服务端分类为 `diffLines`，因此非 Monaco diff 仍以增/删颜色渲染。
- **全屏阅读器**：Expand 打开 **`.code-block-fs-overlay`**（模态、safe-area 内边距、背景 + Escape 关闭、44px+ 控件）。打开时锁定 body 滚动。

#### Telegram 传输层（`transports/telegram/`）

**职责**：把 Cursor 状态桥接到带论坛话题的 Telegram 超级群组。

**两种实现**（通过 `TELEGRAM_IMPL` 环境变量选择）：

- `grammy`（默认）— 使用 Grammy bot 框架做 polling 和 API 调用。Grammy 的 `fetch` 包了 30s HTTP 超时，以防止无限挂起。
- `raw` — 用 Node 原生 `fetch` 直接打 Telegram Bot API。无外部 bot 框架。所有 API 调用有显式 30s HTTP 超时，以及带退避的独立 long-poll 循环。若 Grammy 启动卡住（在部分 macOS 配置上观察到），使用这个。

**共享组件**（两种实现都用）：

- `base.ts` — `BaseTelegramTransport` 抽象类，包含全部业务逻辑：认证持久化、同步状态、活动指示器、话题自动创建、消息处理、输入指示器、事件处理。Grammy 和 raw 传输层都继承它。
- `tg-types.ts` — 无 Grammy 依赖的类型定义：`TelegramApiClient`（出站 API 接口）、`BotContext`（命令处理上下文）、`TgKeyboard`（内联键盘构建器）
- `formatter.ts` — 把每种 `ChatElement` 类型转换为 Telegram HTML。使用 `node-html-parser` DOM 树遍历做准确 HTML 转换（处理 Shiki 代码块、标题、基于 class 的粗体、表格）。处理 4096 字符拆分、为操作生成内联键盘。无 Grammy 依赖。
- `topic-manager.ts` — 把 `windowId::tabTitle`（标题回退）映射到 Telegram 论坛话题 `threadId`。通过 `TelegramApiClient.createForumTopic` 创建话题
- `topic-routing.ts` — 入站话题路由失败诊断
- `commands.ts` — Bot 命令处理（`/sync`、`/mode`、`/model`、`/status`、`/plan`、`/agent`、`/dedupe`、`/resync` 等）。使用 `BotContext` 接口，无 Grammy 依赖。

共享基础设施（`transports/` 根目录）：

- `message-tracker.ts` — 跟踪每个话题的 `ChatElement.id` → Telegram `message_id`。决定是发新消息还是编辑已有消息
- `send-queue.ts` — 限流出站 send/edit
- `types.ts` — `Transport` 接口

**Grammy 特定**（`transports/telegram/index.ts`）：Grammy `Bot` 构造、`autoRetry` 插件、通过 `bot.start()` 的 long-poll、Grammy context → `BotContext` 适配器。

**Raw 特定**（`transports/telegram-raw/`）：`RawTelegramApiClient`（基于 fetch）、带 offset 跟踪和错误退避的 `getUpdates` long-poll 循环、原始 update → `BotContext` 适配器。

**入站流**（Telegram → Cursor）：

1. 用户在论坛话题中发送文本 → 把话题解析为窗口+tab → 必要时切换 → `commandExecutor.sendMessage(text)`
2. 用户点内联键盘按钮 → 解码 callback data → 调用对应执行器方法（`clickApproval`、`clickAction`、`setMode`、`setModel`）
3. 用户发送 `/mode` 命令 → bot 用当前 mode + 内联键盘回复 → 用户点选 → `commandExecutor.setMode(modeId)`

**出站流**（Cursor → Telegram）：

1. 状态管理器发出带变更 `messages`（及相关字段）的 `state:patch`
2. `WindowMonitor` 对每个已映射话题驱动 `doProcessWindow`：**活动行**（仅当 `agentActivityLive` 为 true 时根据 `agentActivityText` 发送/编辑/删除，并与进行中的 step-summary thought 去重）、**composer queue** 消息，然后是聊天元素
3. 传输层按话题对新增 vs 已跟踪消息做 diff
4. 新元素 → 带格式化 HTML + 可选内联键盘的 `sendMessage`
5. 变更元素（例如流式助手文本）→ 对已跟踪 message ID 做 `editMessageText`
6. 当 `agentActivityLive` 为 true 且 `agentStatus` 为活动 mode 时 → 每 4 秒 `sendChatAction('typing')`

**访问控制**：中间件对照 `TELEGRAM_ALLOWED_USERS` 允许名单检查 `update.from.id`。Bot 必须是群管理员，且隐私模式关闭。

**配置**：见 `docs/prd.md` §8 中的 `TELEGRAM_*` 环境变量。

完整规格：`docs/telegram_prd.md`。详细架构：`docs/telegram_architecture.md`。

---

## 3. 网络模型

### 3.1 CDP 连接（中继 → Cursor）

本机安装时，中继连接到 `127.0.0.1:9222`。

WSL2 部署：

```
WSL2 process → localhost:9222 → Windows Cursor
```

WSL2 默认把 localhost 转发到 Windows 主机。

### 3.2 客户端连接（手机 → 中继）

```
Phone → <host-lan-ip>:3000 → Relay server
```

WSL2 需要以下之一：

- **WSL2 mirrored networking**：`.wslconfig` 中的 `networkingMode=mirrored`
- **端口转发**：`netsh interface portproxy` 转发端口 3000

两者都需要 Windows 防火墙入站规则允许 TCP 3000。

macOS/Linux 上把 `SERVER_HOST` 设为 `0.0.0.0`（或 Tailscale IP）即可从局域网或 VPN 访问。详见 `docs/setup-guide.md` 和 `docs/tailscale-setup.md`。

---

## 4. 错误恢复

### 4.1 CDP 断开

1. CdpClient 检测到 WebSocket 关闭
2. CDP Bridge 发出 `disconnected` → 状态管理器 → 客户端看到 “Disconnected”
3. 以指数退避重连循环（1s、2s、4s… 最长 30s）
4. 重连时：重新发现 target、重新连接、恢复轮询

### 4.2 DOM 提取失败

1. 提取捕获全部错误，返回 `null`
2. 状态管理器把 `null` 当作失败（保留最后已知状态，设置 `extractorStatus`）
3. 连续 10 次失败后，记录警告，提示选择器可能需要更新，或窗口可能被后台节流

### 4.3 客户端断开

1. socket.io 以指数退避自动重连
2. 重连时，服务器发送 `state:full` 以追上

### 4.4 命令执行失败

1. 命令执行器最多重试 2 次，间隔 500ms
2. 向特定客户端返回 `{ ok: false, error }`
3. 客户端显示错误 toast

---

## 5. 文件结构

```
cursor-ide-remote/
├── docs/
│   ├── initial_prd.md            # 原始需求（历史保留）
│   ├── prd.md                    # 综合 PRD（本项目规格）
│   ├── architecture.md           # 本文档
│   ├── extension_prd.md          # VS Code 扩展规格
│   ├── setup-guide.md            # 安装与故障排除
│   ├── telegram_prd.md           # Telegram 模块 PRD
│   ├── telegram_architecture.md  # Telegram 模块架构
│   ├── telegram-troubleshooting.md
│   ├── topic-routing-analysis.md
│   ├── tailscale-setup.md
│   ├── cdp-record-replay.md
│   └── smoke-checklist.md
├── temp/                         # 保存的 DOM 快照与 server.log
├── data/                         # 运行时持久化（gitignore）
├── src/
│   ├── server/
│   │   ├── index.ts              # 入口：装配 + 启动
│   │   ├── config.ts             # 环境配置 + 选择器加载
│   │   ├── types.ts              # 全部共享 TypeScript 接口
│   │   ├── persist.ts            # 原子 JSON 写入
│   │   ├── plan-files.ts         # 读取 ~/.cursor/plans
│   │   ├── activity-derive.ts    # 共享 live-activity 派生
│   │   ├── activity-stale.ts     # 活动过期超时
│   │   ├── webapp-sessions.ts    # Web 登录会话
│   │   ├── cdp-client.ts         # 轻量 CDP 客户端（原始 WebSocket）
│   │   ├── cdp-bridge.ts         # CDP 连接生命周期 + 重连
│   │   ├── window-monitor.ts     # 主窗口长连接 + 其他窗口并行轮询
│   │   ├── dom-extractor.ts      # DOM 轮询 + ChatElement 提取
│   │   ├── command-executor.ts   # CDP 操作转译
│   │   ├── state-manager.ts      # 状态 diff + 事件发出
│   │   ├── relay.ts              # Web 传输层：Express + socket.io
│   │   └── transports/
│   │       ├── types.ts          # Transport 接口
│   │       ├── send-queue.ts     # 出站限流
│   │       ├── message-tracker.ts
│   │       ├── telegram/
│   │       │   ├── base.ts       # BaseTelegramTransport（共享逻辑）
│   │       │   ├── tg-types.ts   # 无 Grammy 依赖的类型
│   │       │   ├── index.ts      # Grammy TelegramTransport
│   │       │   ├── formatter.ts  # ChatElement → Telegram HTML
│   │       │   ├── commands.ts   # Bot 命令处理
│   │       │   ├── topic-manager.ts
│   │       │   └── topic-routing.ts
│   │       └── telegram-raw/
│   │           ├── index.ts      # RawTelegramTransport（无 Grammy）
│   │           └── raw-api.ts    # 基于 fetch 的 Telegram API 客户端
│   ├── client/
│   │   ├── index.html            # SPA 壳
│   │   ├── app.js                # 客户端逻辑（socket.io、按类型渲染）
│   │   └── styles.css            # 匹配 Cursor 的深色样式
│   └── discovery/
│       └── discover-dom.ts       # DOM 结构发现 CLI
├── extension/
│   ├── src/
│   │   ├── extension.ts           # VS Code 扩展入口（直接启动，无 license）
│   │   ├── server-manager.ts      # 子进程生命周期 + health 轮询
│   │   ├── lifecycle-lock.ts      # 启动/停止互斥
│   │   ├── secrets.ts             # 仅 Telegram bot token 的 SecretStorage 键
│   │   ├── status-bar.ts          # 状态栏项
│   │   ├── output-channel.ts      # OutputChannel 包装
│   │   ├── config-bridge.ts       # VS Code 设置 + SecretStorage token → 环境变量
│   │   ├── setup-panel.ts         # 网络、密码（Settings）、Telegram 向导
│   │   └── tree-view.ts           # 侧栏 TreeDataProvider
│   ├── media/
│   │   └── walkthrough/           # 入门 walkthrough markdown
│   ├── esbuild.js                 # 扩展打包配置
│   └── tsconfig.json              # 扩展专用 tsconfig
├── scripts/
│   ├── dev-wrapper.ts             # 开发启动（立即启动；无 license 提示）
│   ├── record-cdp.ts / replay-cdp.ts
│   ├── bump-build.ts / release.ts / publish.ts
│   └── update-vsix-install-docs.ts
├── tests/
├── fixtures/recordings/
├── selectors.json                # 外置 DOM 选择器（用户可编辑）
├── package.json
├── tsconfig.json
├── CHANGELOG.md
├── .vscodeignore
└── .gitignore
```

---

## 6. 实现中的发现

在构建和调试与 Cursor DOM 的 CDP 集成时学到的经验。对扩展系统或 Cursor 版本更新后的故障排除有用。

### 6.1 聊天 Tab 使用 `.agent-sidebar-cell`（以及较新的 glass sidebar）

聊天 tab 从 Cursor 侧栏中的 `.agent-sidebar-cell` 元素提取。它们表示 agent 聊天历史条目。每个单元格有包含聊天名称的 `aria-label` 或 `title` 属性。`data-selected` 或 `data-highlighted` 属性指示活动 tab。切换通过基于标题的匹配和 JS `.click()` 完成 — 从不使用脆弱的 CSS 选择器路径或基于坐标的 CDP 鼠标事件。

较新的 Cursor 构建用 glass sidebar 行替换 `.agent-sidebar-cell`（`.glass-sidebar-agent-list-container li.ui-sidebar-menu-item > div.glass-sidebar-agent-menu-btn`）。提取器两种都处理。统一 agent 侧栏可能显示多个项目；tab 必须按窗口标题 / `composerId` 限定范围（见 `docs/topic-routing-analysis.md`）。

**注意**：VS Code tablist（`ul[role="tablist"] li.composite-bar-action-tab`）包含编辑器/终端/输出 tab，**不能** 用于聊天 tab。

### 6.2 CSS 选择器路径必须转义 ID 中的点

Cursor 的 workbench 使用带点的元素 ID（例如 `workbench.parts.auxiliarybar`）。通过 `buildSelectorPath` 构建 CSS 选择器路径时，必须转义：`#workbench\\.parts\\.auxiliarybar`。不转义时，`querySelector` 会把点解释为 class 选择器并静默失败。

### 6.3 下拉交互：JS `.click()` 有效，CDP 鼠标事件无效

mode 和 model 下拉都通过 `Runtime.evaluate` 的普通 JavaScript `.click()` 打开并选择项。发现 CDP `Input.dispatchMouseEvent`（基于坐标的鼠标事件）对这些元素不可靠 — 点击看起来成功，但不会注册到 React 的事件处理程序，导致下拉打不开或选择不生效。

`setMode` 和 `setModel` 都使用的有效模式：

1. `document.querySelector(trigger).click()` — 打开下拉
2. 等待 250–300ms 让菜单渲染
3. `document.querySelector(item).click()` — 选择该项
4. 验证菜单已关闭（确认选择被接受）

### 6.4 Model 选择器：Hover vs 活动状态

在 Cursor 的 model 选择器菜单中，`data-is-selected="true"` 指示 **悬停/焦点** 项，而不是当前活动模型。真正活动的模型由项右侧容器中的勾选图标（`codicon-check`）指示。模型触发按钮（`.composer-unified-dropdown-model`）以文本显示活动模型名称。

现场选项通过 `getModelOptions` 刮取；ID 必须稳定（React `useId` 值如 `_r_ld_` 不能往返，回退到 `label::<text>`）。

### 6.5 Mode 提取

当前 mode（Agent、Plan、Debug、Ask）作为 `.composer-unified-dropdown` 元素上的 `data-mode` 属性存储。下拉中的 mode 项 ID 遵循模式 `composer-mode-*-{modeId}`。`available` 列表目前在提取器中硬编码为 agent / plan / debug / chat（Ask）。

---

### 6.6 Plan widget 使用 `.composer-create-plan-container`

丰富的 plan widget（带 todo 列表、Build 按钮、View Plan 按钮）嵌套在 `.composer-tool-former-message` 下的 `data-message-kind="tool"` 包装器内。必须在通用紧凑工具摘要提取 **之前** 检测。关键选择器：`.composer-create-plan-title`、`.composer-create-plan-label`、`.composer-create-plan-todo-item`、`.composer-create-plan-build-button`、`.composer-create-plan-view-plan-button`。

legacy 计划格式（`.plan-execution-message-content`）有不同的 DOM 结构，出现在 `role=human` 包装器内。两者都映射到 `PlanBlock` 类型。

远程控制时，Web 客户端不再只依赖紧凑的已提取 widget 载荷：

- `View Plan` 打开本地 Web 模态框。
- 中继可以读取 `~/.cursor/plans/<label>` 并返回完整计划正文/todos，在保存文件存在时与 Telegram 更丰富的完整计划渲染一致。
- 计划模型药丸通过中继请求 Cursor 当前计划模型菜单中的现场选项，再把所选选项发回 Cursor，无需用户直接操作桌面 UI。

### 6.7 Run command widget 使用 `.composer-terminal-tool-call-block-container`

终端命令审批卡片包含完整 shell 命令、描述头，以及 Run/Skip/Allow 按钮。容器 class 是 `.composer-terminal-tool-call-block-container`（或 `.composer-tool-call-container.composer-terminal-compact-mode`）。命令文本在 `.composer-terminal-command-expanded-text`。按钮由 `.composer-run-button` 和 `.composer-skip-button` 识别。sandbox 权限请求会出现 “Allow” 按钮。

`selectors.json` / `config.ts` 默认值已在 `rejectButton.textMatch` 中包含 `Skip`。

### 6.8 通用工具操作提取

所有工具类型 — 包括 Fetch、Edit review、终端命令，以及未来任何 Cursor 工具 widget — 共享同一按钮约定：Skip 用 `.composer-skip-button`，Run/Allow/Accept 用 `.composer-run-button` / `.anysphere-secondary-button`。`dom-extractor.ts` 中的 `extractToolActions(container)` 辅助函数通用地扫描任意工具容器中的这些按钮，并把它们分类为 `skip`、`run` 或 `allow`。这避免了按工具类型编写按钮提取代码，并确保新工具类型自动在 Telegram 和 Web 应用中露出其审批操作。

紧凑工具路径（`.composer-tool-former-message`）从 header 叶子文本、truncate 预览和 title/aria-label 取操作/详情，不读取 thinking 正文。

### 6.9 浏览器通知

当浏览器标签页未聚焦且出现可操作事件时，Web 客户端触发原生 `Notification` API 提醒。覆盖的事件：

- 全局审批（来自 `pendingApprovals`）
- Run command 提示（`type: 'run_command'` 且带 actions 的消息）
- 工具级审批（`type: 'tool'` 且带 actions 的消息，例如 Fetch 白名单、Edit accept）
- 问卷（`state.questionnaire`）

每条通知使用每个消息 ID 的唯一 tag 以防止重复。权限在首次触发时惰性请求。

---

## 7. VS Code 扩展外壳

项目也可以作为 VS Code / Cursor 扩展安装。扩展是薄包装 — 它把现有服务器作为子进程拉起，并提供原生编辑器集成。

完整规格：`docs/extension_prd.md`。

### 7.1 架构

扩展运行在 Extension Host（一个 Node.js 进程）中。它通过以下方式与服务器通信：

1. **环境变量** — 在 spawn 时传入配置（`config-bridge.ts`）。没有 license key。
2. **HTTP 轮询** — 每 5 秒 `GET /health` 获取状态数据
3. **stdout/stderr 解析** — 服务器日志行管道到 `LogOutputChannel`

扩展从不导入服务器模块。激活时，若缺少 Web 客户端密码则生成一个（存在 VS Code Settings，不是 SecretStorage），必要时把遗留 Telegram bot token 迁入 SecretStorage，并在 `cursorRemote.autoStart` 为 true 时启动服务器。无购买或激活步骤。

**单例服务器模式：** 所有 Cursor 窗口只运行一个服务器进程。启动时，`ServerManager` 在配置的端口上探测 `GET /health`。若服务器已在运行，该窗口以 **观察者** 身份附着（轮询 health，不拥有进程）。若没有，它拉起服务器并成为 **所有者**。若所有者窗口关闭：

1. 观察者检测到 3 次连续失败的 health 轮询
2. 随机抖动（0–3s）以避免竞态后，一个观察者调用 `attemptTakeover()`
3. 它拉起新的服务器进程并成为新所有者
4. 其他观察者检测到健康的服务器并保持观察者身份

同时 spawn 的竞态通过捕获 stderr 中的 `EADDRINUSE` 并回退到观察者模式来处理。

### 7.2 组件

| 文件 | 职责 |
| --- | --- |
| `extension/src/extension.ts` | 激活/停用、命令注册、自动启动、把密码生成写入 Settings |
| `extension/src/server-manager.ts` | 单例生命周期：spawn/kill、所有者/观察者、health 轮询、自动恢复 |
| `extension/src/lifecycle-lock.ts` | 启动/停止互斥，防止重叠的生命周期操作 |
| `extension/src/secrets.ts` | Telegram bot token 的 SecretStorage 键名（不用于密码） |
| `extension/src/config-bridge.ts` | 读取 VS Code 设置 + SecretStorage token → 子进程环境变量 |
| `extension/src/status-bar.ts` | 带连接状态颜色的状态栏项 |
| `extension/src/output-channel.ts` | 支持 `info`/`warn`/`error` 级别的 `LogOutputChannel` 包装 |
| `extension/src/tree-view.ts` | 侧栏 TreeDataProvider：服务器状态、Start/Stop 按钮、CDP、agent、客户端 |
| `extension/src/setup-panel.ts` | WebviewPanel：网络配置、密码管理、Telegram 向导 |

### 7.3 构建

- **扩展包：** esbuild 把 `extension/src/extension.ts` 打包为 `dist/extension.cjs`（CJS 格式，external: `vscode`）
- **服务器包：** esbuild 把 `src/server/index.ts` + 全部 Node.js 依赖打包为 `dist/server/bundle.mjs`（ESM 格式）。banner 注入 CJS 兼容 shim（`__dirname`、`__filename`、`createRequire`），因为像 Express 这样的打包包依赖这些全局量。
- **客户端文件：** `tsc` 编译 TypeScript，然后把 `src/client/` 连同 `node_modules` 中的 `socket.io.min.js` 复制到 `dist/client/`。
- 所有步骤通过 `vscode:prepublish` 在用 `vsce` 打包前运行。

### 7.4 实现说明

**grammY 原生 fetch：** Telegram bot 库（grammY）默认使用基于 `node:https` 的自有 HTTP 客户端，在 esbuild 打包的 ESM 环境中会损坏。bot 以 `{ client: { fetch } }` 构造，以改用 Node.js 原生 `fetch` API。

**Webview 生命周期：** 设置面板 webview 使用 `retainContextWhenHidden: true` 以保留状态。在同一 ViewColumn 中打开 VS Code 的 Settings 编辑器，同时保留 webview，可能导致 Cursor 渲染器死锁。“Open All Settings” 处理程序先销毁面板，再通过 `setTimeout` 在延迟 tick 上打开 Settings。

---

## 8. 扩展专用环境变量

这些环境变量由扩展在把服务器作为子进程 spawn 时设置。它们都向后兼容 — 缺失时行为与独立模式相同。

| 环境变量 | 默认（独立运行） | 扩展设置 | 用途 |
| --- | --- | --- | --- |
| `DATA_DIR` | 未设置 → `./data` | `context.globalStorageUri` | 与扩展安装目录隔离的持久存储 |
| `LOG_FORMAT` | 未设置 → 带时间戳的纯文本 | `json` | 供 Output Channel 解析的结构化 JSON 行 |
| `WEBAPP_PASSWORD` | 空 → 无 Web 认证 | Settings 中的 `cursorRemote.webappPassword` | Web 客户端密码（Settings，不是 SecretStorage） |
| `TELEGRAM_BOT_TOKEN` | `.env` / 空 | SecretStorage（迁自遗留 settings.json） | Bot token |
| `TELEGRAM_IMPL` | `grammy` | `cursorRemote.telegram.impl` | Grammy vs raw 传输层 |
| `POLL_INTERVAL_MS` | `300`（`config.ts`） | `cursorRemote.pollIntervalMs` 默认 **500** | 主窗口 DOM 轮询间隔 |
| `DEBOUNCE_MS` | `150`（`config.ts`） | `cursorRemote.debounceMs` 默认 **300** | 状态广播防抖 |

---

## 9. 依赖

| 包 | 版本 | 用途 |
| ------------------ | ------- | ---------------------------------------------------- |
| `express` | ^4.21 | 静态文件 + health 的 HTTP 服务器 |
| `socket.io` | ^4.8 | 实时双向通信 |
| `ws` | ^8.18 | CDP 客户端的原始 WebSocket |
| `grammy` | ^1.41 | Telegram Bot API 框架（TypeScript） |
| `@grammyjs/auto-retry` | ^2.0 | Telegram 429 重试 |
| `node-html-parser` | ^7.1 | Telegram formatter 的基于 DOM 的 HTML 解析 |
| `tsx` | ^4.19 | 开发：带 watch 模式的 TypeScript 执行 |
| `typescript` | ^5.7 | 类型检查与编译 |
| `@types/vscode` | ^1.85 | 开发：VS Code 扩展 API 类型 |
| `esbuild` | ^0.24 | 开发：扩展打包 |
| `@vscode/vsce` | ^3.0 | 开发：扩展打包与发布 |

没有 Puppeteer。没有前端框架。客户端没有构建工具。