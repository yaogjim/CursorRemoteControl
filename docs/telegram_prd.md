# Telegram 传输模块 — 产品需求文档

## 1. 概述

Telegram 传输模块把 CursorRemote 桥接到启用了论坛话题的 Telegram 超级群组。每个话题映射到一个「项目 + 聊天 tab」组合，为监视和控制 Cursor agent 提供持久、适合移动端的界面。该模块订阅与 Web 客户端相同的 `StateManager` 事件，并通过同一套 `CommandExecutor` 路由命令，因此是并行传输层，而不是另一套系统。

### 1.1 问题陈述

Web 客户端需要浏览器，且只有标签页打开时才工作。Telegram 始终在线、原生推送通知，并且无需额外安装即可在所有设备上使用。开发者已经生活在 Telegram 里 — 让 agent 对话出现在那里可以去掉摩擦。

### 1.2 目标

- 把 Cursor agent 对话以正确格式流式写入 Telegram 论坛话题
- 为审批、计划操作和命令执行提供内联键盘按钮
- 支持用于 mode/model 切换、状态检查和话题管理的 bot 命令
- 接受来自 Telegram 的文本输入并转发到 Cursor agent
- 在 agent 活动时显示输入指示器
- 基于 token 的注册（`/register <token>`），可选硬编码用户覆盖
- 为新聊天 tab 自动创建话题，无需手动命令

### 1.3 非目标

- Webhook 模式（为简单起见只用 long polling — 不需要公开端点）
- 从 Cursor 提取媒体/图片
- Telegram inline mode 或私聊支持（仅群组）

---

## 2. 用户故事

### TG-1：基于话题的监视

**作为** 使用 Telegram 的开发者，
**我希望** 每个 Cursor 项目 + 聊天 tab 在我的 Telegram 群里有自己的论坛话题，
**这样** 对话是分门别类的，我可以跟进特定 agent。

### TG-2：实时聊天流

**作为** 开发者，
**我希望** 活动中的 agent 对话实时流进对应 Telegram 话题 — 带格式化的助手消息、工具调用摘要、plan widget 和 run command，
**这样** 我可以从 Telegram 跟进 agent 进度。

### TG-3：通过内联按钮审批

**作为** 开发者，
**我希望** 把待审批显示为带 [Accept] [Reject] [Accept All] 内联按钮的 Telegram 消息，
**这样** 我不用离开 Telegram 就能批准或拒绝工具调用。

### TG-4：Run command 审批

**作为** 开发者，
**我希望** 看到 agent 想运行的完整 shell 命令（含描述和命令文本），并点 [Run] [Skip] 或 [Allow] 内联按钮，
**这样** 我可以对命令执行做出知情决定。

### TG-5：Plan widget 交互

**作为** 开发者，
**我希望** 看到计划标题、描述和带状态指示的完整 todo 列表，并点 [Build] 或 [View Plan] 内联按钮，
**这样** 我可以从 Telegram 审阅并执行计划。

### TG-6：发送消息

**作为** 开发者，
**我希望** 在 Telegram 话题中输入文本，并把它作为提示发给映射的 Cursor agent，
**这样** 我可以从 Telegram 指挥 agent。

### TG-7：通过内联按钮回答问卷

**作为** 开发者，
**我希望** 把 agent 的选择题显示为带各选项内联键盘按钮的 Telegram 消息，外加 Skip 和 Continue，
**这样** 我不用离开 Telegram 就能回答问题。

### TG-8：Mode 与 Model 切换

**作为** 开发者，
**我希望** 运行 `/mode` 和 `/model` 命令，显示当前状态并提供内联键盘按钮来切换，
**这样** 我可以从 Telegram 调整 agent 行为。

### TG-9：自动同步

**作为** 开发者，
**我希望** 运行一次 `/sync` 启用自动同步，此后新聊天 tab 会自动获得话题，
**这样** 我永远不必手动管理话题。

### TG-10：状态检查

**作为** 开发者，
**我希望** 运行 `/status` 一眼看到连接状态、agent 状态、活动窗口和活动 tab，
**这样** 我知道系统是否健康。

### TG-11：输入指示器

**作为** 开发者，
**我希望** 在 agent 思考、生成或运行工具时看到 bot 的输入指示器，
**这样** 我不用检查消息内容就知道 agent 在活动。

---

## 3. 消息格式规范

所有消息使用 Telegram 的 HTML parse mode。Telegram 支持：`<b>`、`<i>`、`<u>`、`<s>`、`<code>`、`<pre>`、`<a href="">`、`<blockquote>`、`<tg-spoiler>`。

### 3.1 Human 消息

```html
<b>You:</b> the user's prompt text
<i>@file.ts @terminal</i>
```

若存在 mentions，会作为斜体文本追加。

### 3.2 Assistant 消息

Cursor 的 HTML 通过 `node-html-parser` 的 DOM 树遍历（不是正则）转换为 Telegram 安全 HTML。转换器处理 Cursor 复杂的嵌套 HTML 结构：

- `<strong>` / `<b>` → `<b>`
- `<em>` / `<i>` → `<i>`
- `<span class="font-semibold">` / `data-streamdown="strong"` → `<b>`（Cursor 使用基于 class 的粗体）
- `<h1>`–`<h6>` → `<b>heading text</b>`，带换行边界
- `<p>` → 带段落分隔的内容
- `<code>` → `<code>`（保留）
- 带语言的 `<pre>` → `<pre><code class="language-X">`
- `<div class="composer-message-codeblock">` / `composer-code-block-container`（composer 代码 + diff widget）→ `<pre><code>`，使用结构化 **`codeBlocks`**（`CodeBlockItem`：纯 `code` 或带 `+`/`-` 前缀的 diff 行）；必要时遍历 `.ui-default-code__line-content` / Monaco `.view-line` 文本
- 带 `<th>`/`<td>` 的 `<table>` → 管道分隔的行，表头加粗
- `<a href>` → `<a href>`
- `<blockquote>` → `<blockquote>`
- `<ul>` → `•` 前缀行，`<ol>` → 编号行（解开内部 `<p>` 标签）
- 非内容元素（按钮、滚动条、复制 overlay）→ 跳过
- 仅空白的文本节点 → 跳过（防止源 HTML 缩进泄漏）

超过 4096 字符的消息在段落或代码块边界处拆分。每部分作为单独的 Telegram 消息发送。该元素的所有 message ID 都会被跟踪。

助手消息在内容流式到达时就地编辑（约 800ms 更新周期）。

### 3.3 工具调用

```
✓ Read src/server/types.ts
```
或
```
● Edit relay.ts  (+15 -3)
```

状态图标：`✓` 表示完成，`●` 表示 loading。有文件统计时显示。同一轮询周期内连续的多个工具调用可能批进一条消息。

### 3.4 Thought block

```html
<i>💭 Thought for 4s</i>
```

进行中的 `step_summary` thought 会带 `<tg-spoiler>`（用于隐藏细节），完成后去掉。

### 3.5 Plan widget

```html
<b>📋 Telegram Integration Module</b>
<i>telegram_integration_module.plan.md</i>

Design and implement a Telegram bot transport...

<b>To-dos (3/10):</b>
✅ Write docs/telegram_prd.md
✅ Write docs/telegram_architecture.md
🔵 Add PlanWidget and RunCommand types
⚪ Update web client
⚪ Create Transport interface
<i>... 5 more</i>

Model: Opus 4.6
```

内联键盘：`[▶ Build] [📄 View Plan]`

“View Plan” 把计划描述作为单独消息发到该话题；若磁盘上有保存的计划文件（`~/.cursor/plans/<label>`），会发送完整正文和 todo 列表。

### 3.6 Run command

```html
<b>🖥 Run outside sandbox:</b> cd, source, npx, python3

<pre>$ cd /home/user/project && npx convex run ...</pre>
```

内联键盘：`[▶ Run] [⏭ Skip]`（存在时还有 `[🔓 Allow]`）

### 3.7 Loading 指示器

存在 loading 指示器时，bot 每 4 秒发送 `sendChatAction('typing')`。loading 指示器本身不发消息。

### 3.8 审批（来自 pendingApprovals）

```
⚠️ Approval needed: Accept
```

内联键盘：`[✅ Accept] [❌ Reject] [✅ Accept All]`

按钮由 `approval.actions` 生成。只显示实际存在的操作。

### 3.9 Todo 列表 widget

```html
<b>📝 To-dos (4/10):</b>
✅ BC: Disable Search Partners, keep Display ON
✅ CRM: Disable Display Network
🔵 CRM: Add negative keywords
⚪ CRM: Mark 26 unreviewed search queries
⚪ Update adjustments logs for both campaigns
```

独立的 todo 列表 widget（`.todo-list-container`，`ChatElement` 类型 `todo_list`）与 plan widget 分开提取。状态图标：`✅` 完成、`🔵` 进行中、`⚪` 待办。无内联键盘 — todo 列表仅作信息展示。

### 3.10 短暂活动指示器

agent 忙碌时，传输层可能在话题中显示 **短状态行**（来自共享的 live-activity 约定：`agentActivityText` + `agentActivityLive`），与已同步的聊天消息分开：

- **格式**：斜体行 `● {label}…`，由 `formatter.ts` 中的 `formatActivity()` 生成，并追加 `<tg-spoiler>*spoiler*</tg-spoiler>`，以触发 Telegram 的 shimmer 动画。进行中的 **thought** 行也会用 spoiler 隐藏细节。
- **生命周期**：活动文本首次出现时发送；标签变化时 **编辑**；活动清除或变 stale 时 **删除**。message ID 按论坛线程跟踪（`activityMsgIds`，持久化到 `data/telegram-activity.json` 以便清理）。
- **输入指示**：独立地，当 `agentActivityLive` 为 true（且状态为活动 mode）时，按间隔刷新 `sendChatAction('typing')`，因此单靠陈旧状态文本不能让 Telegram typing 一直亮着。
- **与 thought 去重**：若最近的 `ChatElement` 已包含进行中的 **`step_summary` thought**，且标题与活动标签匹配（`📎` 格式化行），bot **抑制** 短暂活动行，并 **删除** 该话题上已有的活动消息。这样可避免两行并行（例如都是 “Exploring…”）并带重复 spoiler。由 `activityRedundantWithInProgressStepSummary()` 实现，使用导出的 `thoughtAppearsInProgress()`。

若时间戳停止更新，过期活动行也会被定时器移除（`activity-stale.ts` 中的 `AGENT_ACTIVITY_STALE_MS`，Telegram 和 Web UI 的 `StateManager` 共用，当前为 30s）。

### 3.11 问卷（来自 state.questionnaire）

```
❓ Questions (1 of 3)

1. What is your favorite season?
```

内联键盘：`[A) Spring] [B) Summer] [C) Autumn]`（每个选项一个按钮），第二行还有 `[⏭ Skip] [▶ Continue]`。

`questionnaire` 首次变为非 null 时发送消息，活动问题变化时编辑，`questionnaire` 变为 null 时删除。只把活动问题的选项显示为按钮。

Callback data 前缀：答案选项为 `qan:<hash>`，Skip 为 `qsk:<hash>`，Continue 为 `qco:<hash>`。

---

## 4. 命令参考

Bot 使用基于 token 的认证。首次启动时生成注册 token 并打印到服务器控制台。用户运行 `/register <token>` 进行认证。可选地，`.env` 中的 `TELEGRAM_ALLOWED_USERS` 硬编码允许的用户 ID（覆盖 token 认证）。

| 命令 | 参数 | 行为 |
|---------|-----------|----------|
| `/register` | `<token>` | 用服务器控制台中的 token 注册自己。存储用户名和 ID。 |
| `/sync` | — | 为该论坛群启用自动同步。为活动 tab 创建话题并发送最近 5 条消息。新 tab 自动创建话题。 |
| `/sync_all` | — | 为所有窗口中的 **全部** tab 创建话题（不只是活动的）。需要先 `/sync`。 |
| `/unsync` | — | 关闭同步，删除已跟踪话题，清空全部状态。 |
| `/cleanup` | — | 删除未跟踪/陈旧话题，保留活动的已同步话题。 |
| `/dedupe` | `[yes]` | 合并重复话题（同一 `composerId`，或规范化后的同一窗口+tab，例如 WSL/非 WSL 变体）。无参数时预览；`/dedupe yes` 执行。 |
| `/resync` | `[窗口名]` | 把当前话题重新绑定到 Cursor 当前活动窗口/tab。可选按窗口名子串匹配非主窗口。 |
| `/purge` | — | 删除 **全部** 论坛话题（核重置，后台运行）。 |
| `/status` | — | 显示同步状态、群 ID、连接、agent 状态、mode、model |
| `/history` | `[count]` | 发送当前对话最近 N 条消息（默认 5）。 |
| `/mode` | — | 显示当前 mode，并用内联键盘切换（Agent/Ask/Plan/Debug） |
| `/model` | — | 显示当前模型，并用内联键盘切换（选项通过 `getModelOptions` 从 Cursor 现场菜单读取） |
| `/plan` | `<text>` | 切换到 Plan mode 并把文本作为提示发送 |
| `/agent` | `<text>` | 切换到 Agent mode 并把文本作为提示发送 |

话题中发送的纯文本会作为消息转发到映射到该话题的 Cursor agent。没有 `/topics` 命令；话题由 `/sync`、`/sync_all` 和自动同步创建。

---

## 5. 话题映射

### 5.1 结构

Telegram 群是启用了论坛话题的超级群组。每个话题代表一个 `窗口 + 聊天 tab` 组合。

话题名称格式：`{project} — {tab title}`

示例话题：

- `cursor-ide-remote — Fix message sending`
- `adwords-agent — Setup CI pipeline`

### 5.2 映射存储

`TopicManager` 维护双向映射。运行时主键是 `{windowId}::{tabTitle}`（会话内稳定）；持久化回退键是规范化后的 `{windowTitle}::{tabTitle}`（去掉 `[WSL: …]` / `[SSH: …]` 等后缀）。可选的 `composerId` 用于区分同名 agent。

```typescript
interface TopicMapping {
  threadId: number;       // Telegram 论坛话题 thread ID
  windowId: string;       // CDP 窗口 target ID
  windowTitle: string;    // 项目名
  tabTitle: string;       // 聊天 tab 标题
  lastActive: number;     // 上次更新的时间戳
  composerId?: string;    // 可选：data-composer-id，用于跨窗口识别同一 agent
}
```

### 5.3 话题生命周期

1. 用户在论坛群中运行 `/sync` → bot 校验（超级群组、论坛、管理员权限）
2. Bot 设置群 ID 并启用自动同步（持久化到 `data/telegram-sync.json`）
3. 对每个当前发现的窗口+tab 对，若不存在则创建话题
4. 此后，WindowMonitor 在 10s 周期中检测到新 tab 时自动创建话题
5. 映射持久化到 `data/telegram-topics.json`，带 high water mark 供 purge 使用

话题创建间隔为 **1500ms**（`TOPIC_CREATE_DELAY_MS`），以避免 Telegram 的 `createForumTopic` 限流。

### 5.4 活动话题解析

当 bot 在话题中收到消息时：

1. 在映射中按话题的 `threadId` 查找 `windowTitle` + `tabTitle`（以及 `windowId` / `composerId`）
2. 在当前窗口列表中按 ID（必要时按标题，不区分大小写）查找窗口，需要时刷新
3. 若该窗口不是当前主窗口（home），把主 CDP 连接切过去
4. 若该 tab 不是活动 tab，调用 `commandExecutor.switchTab(tabTitle)`
5. 通过 `commandExecutor.sendMessage(text)` 发送消息

路由失败时，bot 回复来自 `topic-routing.ts` 的诊断文本（例如提示在映射话题内发送，而不是 General）。

---

## 6. 访问控制

**基于 token 的认证（默认）：**

- 首次启动时生成 32 字符十六进制注册 token（`randomBytes(16).toString('hex')`），并保存到 `data/telegram-auth.json`
- 每次启动都会把 token 打印到服务器控制台
- 用户运行 `/register <token>` 进行认证。存储用户名和名字。
- 已注册用户在重启后仍然有效

**硬编码覆盖（可选）：**

- 在 `.env` 中设置 `TELEGRAM_ALLOWED_USERS=123456789,987654321`
- 一旦设置，将 **覆盖** token 认证 — 只允许列出的 ID
- 删除该变量即可回到基于 token 的认证

**通用：**

- Bot 中间件对每次更新（`/register` 除外）检查 `ctx.from?.id` 是否在已注册集合中
- 未授权用户被静默忽略
- Bot 必须是群管理员，且隐私模式关闭，才能收到全部消息

---

## 7. 限流与约束

### 7.1 Telegram API 限制

| 约束 | 限制 | 我们的用法 |
|-----------|-------|-----------|
| 消息发送速率（每个 chat） | ~20/分钟 | 发送队列在发送之间间隔约 300ms（传输层覆盖）。安全。 |
| 消息编辑速率（每条消息） | ~30/秒 | 编辑队列在编辑之间间隔 100ms。安全。 |
| 消息文本长度 | 4096 字符 | 在段落边界拆分长消息 |
| Callback data 长度 | 64 字节 | 对选择器路径使用基于 hash 的查找表 |
| `sendChatAction` | 5 秒后过期 | agent 活动时每 4 秒重发 |
| `createForumTopic` | ~20/分钟 | 每次创建间隔 1.5s |

### 7.2 限流实现

三层保护：

1. **grammy auto-retry 插件**（`@grammyjs/auto-retry`）：自动捕获 429 响应，等待 `retry_after` 后再试（最多 3 次，最长延迟 60s）。

2. **SendQueue**：所有出站 `sendMessage` 和 `editMessageText` 调用通过队列串行化，发送间隔 **约 300ms**，编辑间隔 **100ms**（`TelegramTransport` / `BaseTelegramTransport` 构造函数；见 `send-queue.ts`，其自身默认发送间隔是 500ms，传输层会覆盖）。编辑优先于发送。Typing 动作绕过队列。HTML 解析错误会自动回退到纯文本。

3. **话题创建节奏**：`/sync` 和自动创建期间的 `createForumTopic` 调用间隔 **1500ms**（`TOPIC_CREATE_DELAY_MS`）。

### 7.3 初始同步节流

当 bot 首次看到一个话题线程（例如重启后或第一次 `/sync`）时，只发送最近 5 条消息。更早的消息在 tracker 中标记为 “seen”，不会重发。用 `/history [N]` 获取更多（默认 5；必要时滚动聊天以加载更早消息）。

### 7.4 消息批处理

同一轮询周期内到达的连续工具调用会批进一条 Telegram 消息以减少噪音。若后续周期还有更多工具调用，会编辑该批处理消息。

---

## 8. 边界情况

### 8.1 找不到窗口/Tab

若用户在窗口或 tab 已不存在（窗口关闭、tab 删除）的话题中发消息：

- Bot 回复错误：“Window not found”，并列出打开的窗口。
- 陈旧映射条目会被标记但不删除（窗口可能重新打开）。

### 8.2 多个活动用户

多个已允许用户可以同时交互。命令按顺序处理（grammy 内置队列；raw 传输层同样串行处理更新）。审批按钮点击是幂等的 — 别人已经批准后再点没有效果（Cursor 的按钮会消失）。

### 8.3 Bot 重启

重启时 bot 没有消息跟踪状态。它从干净状态开始：

- 通过列出论坛话题并匹配名称重新发现已有话题
- 发送新消息（不编辑旧消息）
- 映射文件恢复话题 ↔ 窗口+tab 关联

活动消息 ID 从 `data/telegram-activity.json` 加载，以便清理孤立的短暂状态行。

### 8.4 长消息拆分

当助手消息超过 4096 字符时：

1. 在限制前最后一个 `\n\n` 处拆分，或最后一个 `\n`，或硬限制 4096
2. 每部分作为单独消息发送
3. 跟踪该元素的所有 message ID，以便编辑更新正确的部分

### 8.5 Callback data 溢出

Telegram 把 callback data 限制为 64 字节。选择器路径可能有数百字符。解决方案：

- 生成选择器路径的短 hash（8 字符）
- 把完整路径存在 `Map<string, string>`（hash → selectorPath）
- Callback data 格式：`{action}:{elementId_short}:{hash}`（能放进 64 字节）
- 问卷操作使用更短格式：`{action}:{hash}`（例如 `qan:<hash>`、`qsk:<hash>`、`qco:<hash>`）
- 当关联的审批/操作不再存在时清空 map

---

## 9. 配置

| 变量 | 默认值 | 说明 |
|----------|---------|-------------|
| `TELEGRAM_ENABLED` | `false` | 启用/禁用 Telegram 传输层 |
| `TELEGRAM_BOT_TOKEN` | — | 来自 @BotFather 的 bot token（启用时必填） |
| `TELEGRAM_ALLOWED_USERS` | — | 可选：硬编码允许的用户 ID（覆盖 /register token 认证） |
| `TELEGRAM_IMPL` | `grammy` | `grammy`（默认）或 `raw`（基于 fetch 的回退，适用于 Grammy 启动卡住） |

---

## 10. 成功标准

当满足以下条件时，认为 Telegram 传输层成功：

1. Bot 启动、打印注册 token，并通过 long polling 连接
2. `/register <token>` 认证用户；设置 `TELEGRAM_ALLOWED_USERS` 时覆盖 token 认证
3. `/sync` 校验群组（超级群组、论坛、管理员权限）并启用自动同步
4. 通过并行 CDP 监视为新窗口/tab 自动创建话题（不切换 UI）
5. 同时监视所有窗口；消息流进正确话题
6. 每种 ChatElement 类型都正确渲染（human、assistant、tool、thought、plan、run_command、todo_list）
7. 助手消息在流式输出时就地编辑；HTML 解析错误时回退到纯文本
8. 待审批显示能触发正确操作的内联键盘按钮
9. Run command 卡片显示命令文本和 [Run]/[Skip]/[Allow] 按钮
10. Plan widget 显示 todo 列表和 [Build]/[View Plan] 按钮
11. 话题中发送的文本转发到映射的 Cursor agent（自动切换窗口/tab）
12. `/history [N]` 以限流节奏发送最近 N 条消息（默认 5）
13. `/mode` 和 `/model` 命令显示当前状态并允许切换
14. agent 活动时显示输入指示器
15. `/unsync` 干净地关闭同步并删除已跟踪话题；`/purge` 删除全部话题
16. 全部状态持久化在 `data/` 目录；重启后仍然有效
17. `/resync` 和 `/dedupe` 能修复错配或重复话题（见 `docs/topic-routing-analysis.md`）