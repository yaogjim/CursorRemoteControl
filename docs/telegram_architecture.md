# Telegram 传输层 — 架构文档

## 1. 组件概览

```
┌───────────────────────────────────────────────────────────┐
│                    TelegramTransport                       │
│                    (BaseTelegramTransport)                 │
│                                                           │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────────┐  │
│  │ TopicManager │  │ MessageTracker│  │   Formatter     │  │
│  │              │  │              │  │                 │  │
│  │ threadId ↔   │  │ elementId →  │  │ ChatElement →   │  │
│  │ window+tab   │  │ msgId[]      │  │ Telegram HTML   │  │
│  └──────┬───────┘  └──────┬───────┘  └────────┬────────┘  │
│         │                 │                    │           │
│  ┌──────▼─────────────────▼────────────────────▼────────┐  │
│  │         API client (grammy or raw fetch)             │  │
│  │                                                      │  │
│  │  Commands: /sync /sync_all /unsync /cleanup /dedupe  │  │
│  │            /resync /purge /status /history           │  │
│  │            /mode /model /plan /agent /register       │  │
│  │  Callbacks: approve, reject, run, skip, build, etc.  │  │
│  │  Text: forwarded as sendMessage to Cursor            │  │
│  │  Typing: sendChatAction loop while agent active      │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                           │
└────────────────────────┬──────────────────────────────────┘
                         │
            subscribes to│ calls
                         │
         ┌───────────────▼───────────────┐
         │         Core System           │
         │                               │
         │  StateManager  (events)       │
         │  CommandExecutor  (methods)   │
         │  CDPBridge  (switchWindow)    │
         │  WindowMonitor (window:update)│
         └───────────────────────────────┘
```

没有 `/topics` 命令。话题由 `/sync`、`/sync_all` 和 WindowMonitor 驱动的自动创建产生。

## 2. 模块结构

```
src/server/transports/
├── types.ts              # Transport 接口
├── send-queue.ts         # 出站 send/edit 串行队列
├── message-tracker.ts    # ChatElement.id → Telegram message_id 跟踪
├── telegram/
│   ├── index.ts          # Grammy TelegramTransport — 生命周期、事件装配
│   ├── base.ts           # BaseTelegramTransport（共享业务逻辑）
│   ├── tg-types.ts       # 无 Grammy 依赖的类型（API、context、keyboard）
│   ├── formatter.ts      # ChatElement → Telegram HTML 转换
│   ├── commands.ts       # Bot 命令处理 + callback query 处理
│   ├── topic-manager.ts  # 话题 ↔ 窗口+tab 双向映射
│   └── topic-routing.ts  # 入站话题路由失败诊断
└── telegram-raw/
    ├── index.ts          # RawTelegramTransport（无 Grammy）
    └── raw-api.ts        # 基于 fetch 的 Telegram API 客户端
```

`TELEGRAM_IMPL=grammy`（默认）或 `raw` 选择实现。两者都继承 `BaseTelegramTransport`。

## 3. 数据流

### 3.1 出站：Cursor → Telegram

```
StateManager emits 'state:patch'
  │
  ▼
TelegramTransport.onStatePatch(patch)
  │
  ├─ patch.messages? → 经 WindowMonitor / 主窗口快照处理（见下）
  │
  ├─ patch.pendingApprovals? → sendOrUpdateApprovalMessage(threadId, approvals)
  │
  ├─ patch.agentStatus? / patch.agentActivityLive? → updateTypingIndicator(status)
  │
  ├─ patch.questionnaire? → processQuestionnaire
  │
  ├─ patch.mode? / patch.model? → （不自动推送，在 /mode /model 命令中显示）
  │
  └─ patch.chatTabs? / patch.windows? → （不自动推送，在 /status 中显示）
```

**窗口快照**：生产路径中，`WindowMonitor` 发出 `window:update` → `TelegramTransport.processWindow` → 对每个已映射话题执行 `doProcessWindow`。该路径发送 **短暂活动**（带 thought 去重）、**composer queue** 摘要和 **内容消息**，使用与上面相同的 `formatter` + `MessageTracker` — 不只依赖 `state:patch`。

### 3.2 入站：Telegram → Cursor

```
User sends text in topic
  │
  ▼
Bot middleware: check allowlist → reject if unauthorized
  │
  ▼
topicManager.resolveThread(threadId)
  │
  ├─ Returns { windowId, tabTitle, ... }
  │
  ├─ If windowId !== activeWindowId → cdpBridge.switchWindow(windowId) → wait for 'connected'
  │
  ├─ If tabTitle !== activeTab → commandExecutor.switchTab(tabTitle) → wait
  │
  └─ commandExecutor.sendMessage(text) → reply with confirmation or error
```

路由失败时，用户看到 `topic-routing.ts` 中的诊断文本（例如在映射话题内发送，而不是 General）。

```
User taps inline keyboard button
  │
  ▼
Bot callback_query handler
  │
  ├─ Parse callback data: "{action}:{shortId}:{selectorHash}"
  │
  ├─ Look up full selectorPath from hash map
  │
  ├─ Route by action:
  │   ├─ approve / reject / approve_all → commandExecutor.clickApproval(selectorPath)
  │   ├─ run / skip / allow → commandExecutor.clickAction(selectorPath)
  │   ├─ build / view_plan → commandExecutor.clickAction(selectorPath)
  │   ├─ questionnaire (qan / qsk / qco) → commandExecutor.clickAction(selectorPath)
  │   ├─ set_mode:{modeId} → commandExecutor.setMode(modeId)
  │   └─ set_model:{modelId} → commandExecutor.setModel(modelId)
  │
  └─ Answer callback query with result text
```

## 4. 组件细节

### 4.1 TelegramTransport（`index.ts` + `base.ts`）

主类实现 `Transport` 接口。Grammy 变体在 `telegram/index.ts`；共享逻辑在 `BaseTelegramTransport`（`base.ts`）。Raw 变体在 `telegram-raw/`。

**构造函数**接收：`TelegramConfig`、`WindowMonitor`、`StateManager`、`CommandExecutor`、`CDPBridge`

**生命周期**：

- `start()`：创建 grammy `Bot`（或 raw API 客户端）并加上 auto-retry 插件，注册中间件（允许名单）、命令和 callback 处理，订阅 StateManager / WindowMonitor 事件，开始 long polling
- `stop()`：停止 long polling，取消订阅

**限流**：

- Bot 上的 `@grammyjs/auto-retry` 插件：捕获 429 响应，等待 `retry_after`，最多重试 3 次（最长延迟 60s）
- `SendQueue` 类（在 `BaseTelegramTransport` 中配置）：把出站 `sendMessage` / `editMessageText` 串行化，发送间隔 **约 300ms**，编辑间隔 **100ms**（`send-queue.ts` 默认发送间隔是 500ms；传输层覆盖为 300ms）
- `seenThreads` 集合：首次遇到线程时只发送最近 5 条消息（更早的在 tracker 中标记为 “skipped”）

**活动消息**（短暂状态行）：

- 每次窗口快照时，`doProcessWindow` 把 `snapshot.agentActivityText` 与每个 `threadId` 的已跟踪状态比较，但仅当 `snapshot.agentActivityLive` 为 true。
- 若活动与最近消息中匹配的进行中 `step_summary` thought **冗余**，则 **删除** 已有活动 Telegram 消息，且不再发送新的（`formatter.ts` 中的 `activityRedundantWithInProgressStepSummary`）。
- 否则：发送 → 标签变化时编辑 → 实时活动清除时删除；`cleanStaleActivity()` 在 `AGENT_ACTIVITY_STALE_MS`（`src/server/activity-stale.ts`，30s）之后移除卡住的行。同一超时通过 `StateManager` 清除 Web 页头。
- 把活动 `message_id` 映射持久化到 `data/telegram-activity.json`，以便重启后清理孤立消息。
- `formatActivity()` 发出斜体 `● label…` 行，并带 `<tg-spoiler>*spoiler*</tg-spoiler>` 以触发 shimmer。

**状态订阅**：

- `stateManager.on('state:patch', this.onStatePatch)`
- `stateManager.on('connection:changed', this.onConnectionChanged)`

**Typing 循环**：

- 当 `agentActivityLive` 为 true 且 `agentStatus` 为 `thinking`、`generating` 或 `running_tool` 时，`setInterval` 每 4 秒向活动话题调用 `sendChatAction('typing')`
- 实时活动一下降，即使 Cursor DOM 中仍有陈旧状态标签，也会清除该 interval
- Typing 动作绕过 SendQueue（廉价且非关键）

### 4.2 Formatter（`formatter.ts`）

纯函数，把 `ChatElement` 对象转换为 Telegram HTML 字符串和可选的 `InlineKeyboard` 对象。

**关键函数**：

- `formatElement(element: ChatElement): { html: string; keyboard?: InlineKeyboard }` — 按元素类型分发
- `formatAssistant(msg: AssistantMessage): string` — 把 Cursor HTML 转为 Telegram HTML，传入 `msg.codeBlocks` 以准确渲染代码
- `formatActivity(text: string): string` — 短暂活动行（`● label…` + spoiler 标签）
- `thoughtAppearsInProgress(msg: ThoughtBlock): boolean` — 导出；用于活动去重和 thought 格式化
- `activityRedundantWithInProgressStepSummary(activityText, elements): boolean` — 抑制与 `📎` step-summary thought 重复的活动
- `formatPlan(plan: PlanBlock): { html: string; keyboard: InlineKeyboard }` — 带 todo 列表的完整计划卡片
- `formatRunCommand(cmd: RunCommand): { html: string; keyboard: InlineKeyboard }` — 带按钮的命令卡片
- `formatApprovals(approvals: Approval[]): { html: string; keyboard: InlineKeyboard }` — 带按钮的审批消息
- `formatQuestionnaire(questionnaire, hashCallback)` — 问卷消息 + 选项按钮
- `splitMessage(html: string, limit?: number): string[]` — 在段落/代码边界拆分

**HTML 转换**（`cursorHtmlToTelegram`）：

使用 `node-html-parser` 把 Cursor 的 HTML 解析成 DOM 树，再递归遍历以生成 Telegram 安全 HTML。这取代了最初的正则方案，后者无法处理 Cursor 复杂的嵌套结构（带逐行 div 的 Shiki 代码块、基于 class 的粗体 span、表格）。

关键转换：

- Composer 代码块（`composer-message-codeblock`、`composer-code-block-container`）→ `<pre><code>`，使用结构化 **`codeBlocks`**（`CodeBlockItem`：拼接的 `code` 或带 `+`/`-` 前缀的 diff 行）；必要时回退到遍历 `.ui-default-code__line-content` / Monaco 行元素
- 标题（`<h1>`–`<h6>`）→ `<b>text</b>`，带换行边界
- 粗体 span（`<span class="font-semibold">`、`data-streamdown="strong"`）→ `<b>`
- 段落（`<p>`）→ 带换行的内容
- 表格 → 管道分隔的行，表头加粗
- 列表（`<ul>`/`<ol>`）→ `•` / `1.` 前缀行，解开内部 `<p>`
- 保留 `<code>`、`<pre>`、`<a href>`、`<blockquote>`、`<b>`、`<i>`、`<u>`、`<s>`
- 跳过非内容元素（按钮、滚动条、复制 overlay、光标图标）
- 跳过仅空白的文本节点，防止源 HTML 缩进泄漏
- 转义文本节点中的 `<`、`>`、`&`
- 把连续 3 个及以上换行折叠为双换行

### 4.3 TopicManager（`topic-manager.ts`）

管理 Telegram 论坛话题 thread ID 与 Cursor 窗口+tab 对之间的双向映射。

**状态**：

- `byWindowIdTab: Map<string, TopicMapping>` — 键为 `{windowId}::{tabTitle}`（运行时主键）
- `byTitleTab: Map<string, TopicMapping[]>` — 规范化 `{windowTitle}::{tabTitle}` 回退（多个窗口可能同名）
- `byThread: Map<number, TopicMapping>` — 按 threadId 反向查找

`normalizeWindowTitle()` 去掉 Cursor 的连接上下文后缀（`[WSL: …]`、`[SSH: …]`、`[Dev Container: …]` 等），以便同一项目跨会话解析到同一话题。

**方法**：

- `createTopics(bot, chatId, windows, chatTabs)` — 创建缺失话题，返回映射
- `resolveThread(threadId): TopicMapping | undefined` — 查找线程对应的窗口+tab
- `getThreadForSnapshot(...)` — 用 windowId 作为主键查找线程
- `getActiveThread(state): number | undefined` — 获取当前活动窗口+tab 的线程

**持久化**：

- 变更时保存映射到 `data/telegram-topics.json`
- 启动时加载以在重启后保留

### 4.4 MessageTracker（`transports/message-tracker.ts`）

跟踪每个话题内 `ChatElement.id` 与 Telegram message ID 的关系。

**状态**：

- `messages: Map<string, TrackedMessage>`，键为 `{threadId}:{elementId}`

```typescript
interface TrackedMessage {
  telegramMsgIds: number[];  // 消息被拆分时有多个
  threadId: number;
  elementId: string;
  lastContent: string;       // 上次发送内容的 hash，用于变更检测
  type: string;              // ChatElement 类型，用于格式化决策
}
```

**方法**：

- `getTracked(threadId, elementId): TrackedMessage | undefined`
- `track(threadId, elementId, msgIds, contentHash, type): void`
- `clearThread(threadId): void` — 清除某话题的全部已跟踪消息（聊天重置时）
- `hasChanged(threadId, elementId, newContentHash): boolean`

持久化到 `data/telegram-messages.json`。

### 4.5 Commands（`commands.ts`）

注册 bot 命令和 callback query 处理程序。处理函数是无 Grammy 依赖的，通过 `BotContext` 工作。

**命令处理**（每个都接收 `ctx` 和共享的 state/executor 引用）：

- `/register <token>` — 用服务器 token 认证用户
- `/sync` — 校验超级群组 / 论坛 / 管理员权限，启用自动同步，为活动 tab 创建话题
- `/sync_all` — 为所有窗口中的全部 tab 创建话题（需先 `/sync`）
- `/unsync` — 关闭同步，删除已跟踪话题
- `/cleanup` — 删除未跟踪/陈旧话题
- `/dedupe [yes]` — 按 `composerId` 或规范化标题合并重复话题
- `/resync [窗口名]` — 把当前话题重新绑定到 Cursor 当前活动窗口/tab
- `/purge` — 后台删除全部论坛话题
- `/status` — 读取 `stateManager.getCurrentState()`，格式化并回复
- `/history [N]` — 发送映射话题最近 N 条消息（默认 5），必要时切换窗口/tab 并做新提取；块之间按限流节奏发送
- `/mode` — 显示当前 mode，内联键盘列出可用 mode
- `/model` — 显示当前模型；通过 `commandExecutor.getModelOptions()` 加载现场选项
- `/plan <text>` — 切换到 plan mode 然后发送文本
- `/agent <text>` — 切换到 agent mode 然后发送文本

**Callback query 处理**：

- 解析 `callbackData` 以确定操作类型
- 路由到对应的 CommandExecutor 方法
- 用确认或错误回答 callback query

话题创建节奏：每次 `createForumTopic` 调用间隔 1500ms。

## 5. Callback Data 编码

Telegram 把 `callback_data` 限制为 64 字节。我们的编码方案：

```
{action}:{shortId}:{hash}
```

- `action`：短字符串，如 `apr`、`rej`、`all`、`run`、`skp`、`alw`、`bld`、`vpl`、`mode`、`mdl`
- `shortId`：元素/审批 ID 的前 8 个字符
- `hash`：选择器路径 hash 的前 8 个字符

`Map<string, string>` 存储 `hash → selectorPath`。每当发送新操作时更新 map，当操作不再出现在状态中时清理。

示例：

- `apr:abc12345:f7e3a1b2` — 批准操作
- `run:tool1234:9c8d7e6f` — 运行命令
- `mode:agent` — 切换到 agent mode（不需要 hash）
- `mdl:claude-4-opus` — 切换模型（截断以适应限制）
- `qan:<hash>` / `qsk:<hash>` / `qco:<hash>` — 问卷答案 / Skip / Continue

## 6. 消息生命周期

### 6.1 新元素出现

1. Formatter 把元素转换为 HTML + 可选键盘
2. 若 HTML > 4096 字符，拆成多部分
3. 通过 `bot.api.sendMessage(chatId, html, { message_thread_id, parse_mode: 'HTML', reply_markup })` 发送每部分
4. 在 MessageTracker 中跟踪所有返回的 message ID

### 6.2 元素内容变化（流式）

1. 计算新元素的内容 hash
2. 若 hash 与已跟踪 hash 匹配，跳过（无变化）
3. 若变化，重新格式化并调用 `bot.api.editMessageText(chatId, msgId, html, { parse_mode: 'HTML', reply_markup })`
4. 若消息曾被拆分且新内容能放进更少部分，编辑已有部分（多余部分保持原样）
5. 若新内容需要更多部分，编辑已有部分并发送额外消息
6. 更新已跟踪的内容 hash

### 6.3 审批已解决

1. 下一次 state patch 时，`pendingApprovals` 为空
2. 编辑审批消息以显示 “Resolved”（或移除内联键盘）
3. 清理已解决审批的 callback data hash map 条目

## 7. 错误恢复

### 7.1 Telegram API 错误

- **限流（429）**：grammy 用 retry-after 自动处理（raw 传输层同样尊重 429）
- **找不到消息（400）**：从 tracker 移除，下次更新时发送新消息
- **找不到 chat（400）**：记录错误，跳过该话题直到重新 `/sync`
- **网络错误**：long polling 自动重连

### 7.2 CDP 断开

当 `connection:changed` 以 `false` 触发时：

- 向活动话题发送状态消息：“⚠️ Disconnected from Cursor IDE”
- 停止输入指示器
- 重连后发送：“✅ Reconnected to Cursor IDE”

### 7.3 Bot 重启

- TopicManager 若存在则从 `telegram-topics.json` 加载映射
- MessageTracker 从空开始 — 不编辑旧消息
- 通过匹配名称重新发现已有话题
- 新消息从下一次 state patch / 窗口快照正常流动

## 8. 依赖

| 包 | 用途 |
|---------|---------|
| `grammy` | Telegram Bot API 框架（TypeScript，Bot API 9.5）；`TELEGRAM_IMPL=raw` 时不使用 |
| `node-html-parser` | 基于 DOM 的 HTML 解析，用于 Cursor HTML → Telegram HTML 转换 |

grammy 处理 long polling、限流和类型安全的 API 调用。`node-html-parser` 提供轻量（约 40KB，零子依赖）DOM API（`querySelector`、`textContent`、`classList`），把 Cursor 深度嵌套的 HTML 结构（Shiki 代码块、基于 class 的样式、表格）转换为 Telegram 安全 HTML。