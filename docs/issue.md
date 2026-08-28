# Issues #52、#48、#43、#28、#18 评估与实施方案

> 本文是对 GitHub Issues 的需求核验、边界判断和实现设计。本文只记录方案，不包含功能代码修改。

## 1. 评估范围与结论

已确认以下五个 Issue 在 GitHub 仓库中真实存在：

- [#52 支持图片/文件等非文本输入](https://github.com/len5ky/CursorRemote/issues/52)
- [#48 浅色主题与跟随系统主题](https://github.com/len5ky/CursorRemote/issues/48)
- [#43 虚拟化聊天列表导致历史消息提取不完整](https://github.com/len5ky/CursorRemote/issues/43)
- [#28 通过 `/` 命令执行 skills、commands 和 summarize](https://github.com/len5ky/CursorRemote/issues/28)
- [#18 移动 Web 推送通知](https://github.com/len5ky/CursorRemote/issues/18)

| Issue | 真实存在 | 需求合理性 | 必要性 | 可行性 | 建议优先级 |
| --- | --- | --- | --- | --- | --- |
| #52 非文本输入 | 是 | 是 | 高：移动端无法方便地把图片或文件交给 Agent | 有条件可行；需要依赖 Cursor 当前版本的附件控件 | P1 |
| #48 浅色/系统主题 | 是 | 是 | 中：影响可读性、可访问性和白天使用场景 | 可行；主要是客户端样式和主题状态 | P1 |
| #43 历史消息缓存 | 是 | 是 | 高：当前远程视图无法保证完整上下文 | 可行；需要处理虚拟化、滚动加载和缓存上限 | P0 |
| #28 `/` 命令与上下文整理 | 是 | 是，但要限制为安全的命令转发 | 中：可减少手机端重复输入；不是 Agent 基础能力 | 部分可行；命令发现和 Cursor 版本兼容需要明确 | P2 |
| #18 Web Push 通知 | 是 | 是 | 中高：页面在后台或被系统挂起时仍需知道审批/完成 | 可行；完整 Web Push 需要 HTTPS、Service Worker 和 VAPID | P1 |

优先顺序建议为 **#43 → #48/#18 → #52 → #28**。#43 直接影响现有远程监控的正确性；#48 风险低且收益明确；#18 对移动端使用价值高，但基础设施和安全要求较多；#52 需要先确认 Cursor 附件入口的稳定能力；#28 的核心依赖 Cursor 对 slash command 的实际支持，适合在前述链路稳定后实施。

## 2. 当前实现基线

当前系统通过 Chrome DevTools Protocol（CDP，Chrome DevTools 调试协议）连接 Cursor，在 `src/server/dom-extractor.ts` 中提取当前 DOM，再由 `src/server/state-manager.ts` 管理状态并通过 Socket.IO 推送给 Web 客户端。命令通过 `src/server/relay.ts` 转发到 `src/server/command-executor.ts`，客户端位于 `src/client/app.js` 和 `src/client/styles.css`。

当前基线有以下限制：

1. `CursorState.messages` 表示一次提取时当前已挂载的消息包装器。提取器使用 `data-flat-index`、`data-message-index` 等 Cursor DOM 属性；虚拟化列表中没有挂载的行不会出现在结果中。
2. `CommandExecutor` 已有 `scrollChatUp()` 和 `scrollChatToBottom()`，但 Relay 尚未提供面向 Web 客户端的历史加载命令，因此远程客户端无法可靠地请求“再加载一页历史”。
3. `CommandPayload` 当前主要支持文本发送、审批、切换标签页/窗口、模式/模型切换和计划操作，没有附件、slash command、历史加载或推送订阅字段。
4. Web 客户端已有基于浏览器 `Notification` API 的部分通知和去重逻辑。它只能覆盖页面仍在运行、且浏览器允许通知的场景，不等同于关闭页面后仍可到达的 Web Push。
5. 当前界面以暗色为主，CSS 中存在 `color-scheme: dark`，尚未形成浅色、暗色、跟随系统三种模式的完整主题模型。
6. 当前 Relay 已有密码、Session Cookie、Bearer Token、同源校验和 Socket.IO 鉴权。新接口必须复用这些鉴权边界，不应新增绕过认证的上传、订阅或命令入口。

## 3. 通用设计原则

- **不依赖未经验证的 Cursor 内部 API。** 与 DOM、附件控件、slash command 相关的选择器和行为，先用现有 discovery/probe 工具验证目标 Cursor 版本，再加入 `selectors.json` 或版本兼容分支。
- **保持旧客户端兼容。** 现有 `state:full`、`state:patch`、`command:result` 和 `send_message` 的文本路径继续有效；新字段使用可选字段，新事件使用独立事件名。
- **所有远程输入都以服务端为边界。** 上传内容、命令名称、大小、类型、路径和调用频率在服务端校验，不能把客户端传来的路径直接交给 CDP 或文件系统。
- **不把大对象放入实时状态。** 图片/文件使用临时附件引用，推送使用短通知数据，消息缓存设置数量、字节数和 TTL 上限。
- **状态变化与用户操作分离。** 自动提取可以产生状态和通知；会改变 Cursor UI 的操作（滚动历史、发送附件、执行命令）必须通过显式命令，并返回可追踪的 `commandId` 结果。

---

## 4. Issue #43：虚拟化历史消息与 Relay 缓存

### 4.1 判断

该问题真实存在且是当前最必要的功能问题。DOM 提取器只能看到当前已挂载的聊天行；用户向上滚动后，旧行可能被挂载，新行可能被卸载。若状态直接用本次快照替换，远程客户端会看到不完整历史，甚至在下一次轮询时丢失已经看到的消息。

需求合理、必要且可行。单纯在 Relay 中保存每次快照还不够：必须同时提供“让 Cursor 加载更早消息”的显式操作，否则缓存只能保存用户已经让 Cursor 挂载过的部分历史。

### 4.2 设计目标与边界

目标：

- 对同一对话合并多次 DOM 快照，已见消息在虚拟化卸载后仍保留。
- 同一消息 ID 的内容变化可以更新，不产生重复消息。
- 远程 Web 客户端可以请求有限批次的更早消息。
- 服务重启、对话切换、缓存上限和异常提取不会造成无限内存增长或跨对话串消息。

边界：

- 第一阶段只保证“从服务启动后观察到的历史”以及通过 `load_history` 主动加载的历史。
- 不承诺从 Cursor DOM 读取服务启动前、且从未挂载过的全部历史。
- 不自动无限向上滚动，不把完整消息历史持久化到磁盘。若未来需要重启恢复，另行设计加密存储和生命周期。

### 4.3 服务端数据结构

建议在 `src/server/state-manager.ts` 附近新增独立的 `MessageHistoryCache`，而不是把缓存逻辑混入 DOM 解析器：

```ts
interface ConversationKey {
  windowId: string;
  composerId: string;
  tabTitle: string;
}

interface CachedMessage {
  message: ChatElement;
  firstSeenAt: number;
  lastSeenAt: number;
  revision: number;
}

interface ConversationHistory {
  key: ConversationKey;
  messages: Map<string, CachedMessage>;
  oldestFlatIndex: number | null;
  newestFlatIndex: number | null;
  hasMore: boolean | null;
  lastObservedAt: number;
  estimatedBytes: number;
}
```

实现要求：

1. 优先使用 `ChatElement.id` 作为键；对没有稳定 ID 的元素使用 `type + flatIndex + 内容 hash` 作为临时键，并在存在稳定 ID 后替换。不能只用数组下标。
2. 每次提取只更新当前快照中出现的消息，不因为某条消息暂时未挂载就删除缓存。对同一 ID 比较内容 hash，内容变化时递增 `revision`。
3. 输出时按 `flatIndex` 排序；同一索引冲突时按首次发现时间和消息 ID 稳定排序。
4. 缓存键必须至少包含 `windowId + activeComposerId + tabTitle`。切换窗口、聊天标签页或 Composer 时切换到另一份缓存，避免相同标题的不同 Agent 串线。
5. 设置硬上限，例如每个对话最多 2,000 条消息、最多 8 MiB，整个进程最多 20 MiB；超限从最旧的非近期消息开始淘汰。设置 30 分钟无观察 TTL，并在窗口/对话生命周期结束时清理。
6. `loading` 元素只用于表示当前状态，不应永久写入历史缓存，除非它已经拥有稳定 ID 且后续可以被同 ID 的最终消息替换。

建议给公共状态增加可选的元数据，而不改变 `messages` 的含义：

```ts
interface HistoryMeta {
  conversationKey: string;
  loadedCount: number;
  hasMore: boolean | null;
  loading: boolean;
  oldestFlatIndex: number | null;
}
```

`CursorState.messages` 仍然是当前对话的合并结果；`history` 或 `historyMeta` 作为可选字段供新客户端显示。旧客户端会忽略未知字段。

### 4.4 历史加载协议

新增命令 `command:load_history`，建议 payload：

```ts
interface LoadHistoryPayload {
  commandId: string;
  type: 'load_history';
  windowId?: string;
  composerId?: string;
  batches?: number; // 服务端限制为 1..5
}

interface LoadHistoryResult {
  commandId: string;
  ok: boolean;
  data?: {
    loadedCount: number;
    hasMore: boolean | null;
    oldestFlatIndex: number | null;
  };
  error?: string;
}
```

处理流程：

1. Web 客户端点击“加载更早消息”后发送命令，服务端验证目标窗口/Composer 与当前活动上下文一致。
2. `CommandExecutor` 复用已有 `scrollChatUp()`，但把每次滚动、等待和提取绑定为有限批次；单次请求最多 5 批，整个请求设置超时。
3. 滚动期间由正常轮询提取新挂载的行，`MessageHistoryCache` 合并快照。若当前架构不能在命令内等待提取事件，则命令先执行滚动，随后由状态管理器发出带 `historyMeta.loading` 的最终状态，客户端根据状态更新按钮。
4. 检测滚动位置或 `oldestFlatIndex` 没有变化时设置 `hasMore: false`，避免客户端重复触发无效滚动。
5. 加载完成后可选择调用 `scrollChatToBottom()`，但默认不强制跳转，以免破坏用户在 Cursor 中查看历史的位置；Web 客户端应保留自己的滚动位置。

### 4.5 改动点

- `src/server/types.ts`：增加历史元数据和 `load_history` 命令类型。
- `src/server/state-manager.ts`：加入按对话隔离的缓存、合并、淘汰和状态输出。
- `src/server/relay.ts`：增加 `command:load_history` 校验、排队、结果返回；禁止客户端指定任意 CDP 目标。
- `src/server/command-executor.ts`：将现有滚动逻辑封装为有限批次并返回是否发生滚动变化。
- `src/client/app.js`：显示“加载更早消息”、加载中、没有更多消息和失败状态；合并/渲染以服务端合并结果为准。
- `tests/`：增加缓存单元测试和 Relay/Socket.IO 协议测试。

### 4.6 风险与测试

重点风险是消息 ID 在 Cursor 版本变化、同一对话在多个窗口出现、滚动触发当前 Agent UI 变化，以及缓存消息占用内存。测试至少覆盖：

- 快照 A 只有后 20 条，快照 B 只有前 20 条，结果包含两部分且顺序正确。
- 同一消息内容从 loading 变为 completed 时只保留一个 ID 并更新 revision。
- 两个相同标题但不同 Composer 的对话不会合并。
- 消息未出现在下一次虚拟化快照时不会被删除。
- 达到条数/字节上限会淘汰旧消息，TTL 会清理闲置对话。
- `load_history` 并发请求被串行化、批次被限制、断开 CDP 时返回明确错误。

---

## 5. Issue #48：浅色主题与跟随系统主题

### 5.1 判断

该问题真实存在、合理、必要性中等且技术风险低。当前界面按暗色设计，白天环境、强光环境和对暗色不适应的用户会受到影响。实现不需要改变服务端协议，适合独立交付。

### 5.2 主题模型

提供三个用户选项：

- `system`：跟随 `prefers-color-scheme`。
- `light`：固定浅色。
- `dark`：固定暗色。

客户端将选择保存到 `localStorage`，使用 `document.documentElement.dataset.theme` 或等价属性应用主题。`system` 模式通过 `matchMedia('(prefers-color-scheme: dark)')` 监听系统变化。首次加载应在首屏绘制前应用已保存选择，减少闪烁。

### 5.3 样式设计

在 `src/client/styles.css` 中建立颜色 Token，而不是逐个覆盖现有组件：

```css
:root {
  color-scheme: light;
  --bg: #f7f8fa;
  --surface: #ffffff;
  --text: #1f2328;
  --muted: #667085;
  --border: rgba(31, 35, 40, 0.14);
  --accent: #0969da;
}

:root[data-theme='dark'] {
  color-scheme: dark;
  --bg: #181818;
  --surface: #232323;
  --text: rgba(228, 228, 228, 0.92);
  --muted: rgba(228, 228, 228, 0.55);
  --border: rgba(255, 255, 255, 0.10);
  --accent: #3794ff;
}

@media (prefers-color-scheme: dark) {
  :root[data-theme='system'] {
    color-scheme: dark;
    /* system 暗色 Token */
  }
}
```

实际实现中应把背景、文本、边框、状态色、审批色、代码块和弹层颜色全部映射到 Token，并检查浅色背景上的红/黄/绿状态色对比度。`index.html` 中的 `theme-color` 以及登录页的颜色也要同步主题；登录页不能永远固定暗色。

### 5.4 改动点与测试

- `src/client/index.html`：增加主题选择控件、主题初始值脚本和动态 `theme-color` 支持。
- `src/client/app.js`：读取/保存选择、监听系统主题变化、渲染主题控件。
- `src/client/styles.css`：整理 CSS Token 和浅色/暗色组件样式。
- `tests/web-client.test.ts`：测试默认值、localStorage 恢复、三种选择、`matchMedia` 变化和通知/审批颜色在主题切换后仍可读。
- 浏览器测试：覆盖登录页、空状态、聊天消息、审批条、计划弹窗、模型菜单、Toast 和窄屏布局。

兼容性上，浏览器不支持 `matchMedia` 监听时退回首次读取的系统值；不支持 `color-scheme` 时仍应通过显式 Token 保证可用。

---

## 6. Issue #18：移动 Web 通知与完整 Web Push

### 6.1 判断

该问题真实存在且合理。当前客户端已有页面级 `Notification` API 的部分实现，能够在页面后台但仍运行时提醒用户；它无法覆盖页面关闭、浏览器暂停脚本或移动系统回收页面的情况。Issue 所需的“移动 Web 推送”应明确分为两层：

1. **阶段一：页面级通知。** 完善权限申请、通知设置、前台/后台条件和去重。无需服务器推送基础设施。
2. **阶段二：Web Push。** 使用 Service Worker、Push API 和 VAPID（Web Push 的服务端身份密钥）在页面不打开时发送推送。这才是完整 Issue 目标。

### 6.2 通知事件模型

不要根据每个状态 patch 直接发通知；应在服务端由状态变化派生稳定事件：

```ts
type NotificationKind = 'approval_required' | 'agent_completed' | 'agent_error';

interface NotificationEvent {
  id: string;
  kind: NotificationKind;
  dedupeKey: string;
  title: string;
  body: string;
  createdAt: number;
  windowId: string;
  composerId: string;
}
```

事件规则：

- `approval_required`：待审批 ID 集合新增时发出；同一审批不能因重复轮询重复发送。
- `agent_completed`：同一 Agent 从 thinking/generating/running_tool 进入 idle，且确实观察到过运行状态时发出，避免启动时误报。
- `agent_error`：从非 error 状态进入 error 时发出。
- `dedupeKey` 至少包含对话身份、事件类型和审批 ID/运行代次；服务重连或新浏览器页不应无限重发旧事件。
- 通知正文默认只放“需要审批”或“Agent 已完成”等最小信息，不放完整提示词、文件内容、代码差异或附件内容。

### 6.3 Web Push 协议与存储

新增受认证保护的 HTTP 接口：

- `GET /api/push/config`：返回是否启用 Push、VAPID public key 和当前浏览器是否已有订阅。
- `POST /api/push/subscribe`：接收浏览器 `PushSubscription` JSON、设备标签和通知偏好。
- `DELETE /api/push/subscribe`：删除当前会话或当前设备的订阅。
- 可选 `POST /api/push/test`：仅用于设置页的测试通知，并限流。

订阅记录建议如下：

```ts
interface PushSubscriptionRecord {
  id: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  sessionId: string;
  userAgent?: string;
  kinds: NotificationKind[];
  createdAt: number;
  lastSeenAt: number;
}
```

- VAPID private key只放服务端配置或受保护的数据目录，不能通过 Web 客户端返回。
- 订阅以 `dataDir` 中的受保护存储保存；每个 Session/设备可有多个订阅，失效 endpoint 在推送返回 404/410 时自动删除。
- 所有 Push 接口复用现有 Web App 鉴权；订阅不能由未登录客户端写入。
- Web Push 要求 HTTPS；`localhost` 可作为开发例外，手机通过局域网 IP 访问时不能假定浏览器允许 Service Worker。文档和 Setup Panel 必须提示使用 HTTPS 反向代理、Tailscale HTTPS 或等价方案。
- 服务端应设置每事件/设备限流和队列，避免 Agent 快速状态变化产生推送风暴。

### 6.4 客户端流程

1. `index.html` 注册同源 `/sw.js` Service Worker。
2. 用户点击“启用通知”后才调用 `Notification.requestPermission()`；不要在页面加载时弹权限框。
3. 浏览器支持 Push 且权限为 granted 时，使用服务端 VAPID public key 调用 `pushManager.subscribe()`，再 POST 到 `/api/push/subscribe`。
4. Service Worker 处理 `push` 和 `notificationclick`：展示通知，点击后打开或聚焦 Web 客户端，并带上对话/窗口定位参数。
5. 页面保持现有 `Notification` API 作为低延迟前台回退，但必须和 Push 事件共用 dedupe key。
6. 用户可分别关闭审批、完成和错误通知；权限被系统拒绝时显示可操作的浏览器设置提示，而不是反复申请。

### 6.5 分阶段改动与测试

- 阶段一：整理 `src/client/app.js` 的通知条件、权限控件、前后台判断和去重测试。
- 阶段二：新增 `src/client/sw.js`、Relay Push 路由、推送存储、VAPID 配置、状态事件派生器和发送队列。
- 阶段三：加入 Setup Panel 配置、HTTPS 文档、失效订阅清理和监控日志。

测试至少包括：审批只通知一次、完成状态不重复通知、重连不重复通知、前台/后台行为、权限 denied、Service Worker 注册失败、订阅创建/删除、无效 endpoint 清理、未鉴权请求被拒绝、通知正文不泄露敏感内容，以及 Android/iOS 支持能力差异下的降级行为。

---

## 7. Issue #52：图片和文件输入

### 7.1 判断

该问题真实存在、使用场景合理且移动端价值高。当前 `send_message` 只通过 CDP 输入文本；没有附件选择、上传、临时存储和 Cursor 附件注入的完整链路。

需求可行，但可行性取决于目标 Cursor 版本是否提供可操作的文件输入或拖放接收控件。Cursor DOM 属于应用内部实现，不能把某个版本的隐藏 `<input type="file">` 当作永久协议。因此建议先交付图片，再扩展一般文件，并在不支持的版本返回明确错误。

### 7.2 推荐的端到端链路

1. Web 客户端使用受保护的 `multipart/form-data` HTTP 上传到 Relay；Socket.IO 不承载二进制附件。
2. Relay 验证认证、文件大小、扩展名与 MIME 类型，并读取文件头做基本类型校验；客户端传来的 MIME 不能作为唯一依据。
3. 文件写入 `dataDir/attachments` 下的随机 ID 文件，权限设为仅当前用户可读，原始文件名只作为显示元数据保存。设置单文件、单请求、总存储上限和 TTL 自动清理。
4. 服务端返回短期 `attachmentId`，而不是暴露任意本地路径：

```ts
interface AttachmentRef {
  id: string;
  name: string;
  mime: string;
  size: number;
  sha256: string;
  kind: 'image' | 'file';
  expiresAt: number;
}
```

5. `send_message` 保持原有 `text` 字段，并增加可选 `attachments: AttachmentRef[]`。旧客户端继续发送纯文本。
6. `CommandExecutor` 在 Cursor 的附件入口可用时，通过 CDP 的文件输入能力设置文件，或模拟 Cursor 已验证的拖放/粘贴流程，再填入文本并提交。完成后立即删除或标记已消费的临时文件。
7. 如果 Cursor 当前界面没有可验证的附件入口，Relay 不应把本地路径作为文本假装发送成功，而应返回“不支持当前 Cursor 版本的附件输入”。

### 7.3 安全和兼容限制

- 默认限制单文件 25 MiB、单次 5 个文件；允许的图片类型先限定为 PNG/JPEG/WebP，普通文件类型采用明确 allowlist，并允许配置覆盖。
- 禁止路径穿越、符号链接逃逸、任意本地路径上传和通过附件名执行命令。
- HTTP 下载/预览接口必须鉴权、使用随机 ID、设置 `Content-Disposition: attachment`，不把用户文件放在公开静态目录。
- 附件不写入 `CursorState.messages`，状态只保留必要的附件引用；日志不打印文件内容。
- 不在第一阶段承诺 OCR、压缩、病毒扫描或大文件断点续传；这些属于后续能力。

### 7.4 改动点与测试

- `src/server/types.ts`：增加 `AttachmentRef` 和带附件的发送 payload。
- `src/server/relay.ts`：增加鉴权上传、引用获取/删除、限流和错误响应；复用现有 Session。
- `src/server/command-executor.ts`、`src/server/cdp-client.ts`：增加经过探测验证的文件输入 CDP 调用。
- `src/client/index.html`、`src/client/app.js`、`src/client/styles.css`：文件选择、图片预览、上传进度、失败重试、删除附件和发送状态。
- `src/server/attachment-store.ts`（建议的新模块）：临时文件保存、hash、TTL 清理和配额。
- 测试：MIME/文件头校验、大小/数量限制、鉴权、路径穿越、过期清理、上传中断、纯文本回归、图片和普通文件的 CDP 注入，以及不支持附件入口时的明确失败。

建议实施顺序为：探测 Cursor 附件 DOM → 图片上传闭环 → 文件上传闭环 → 多附件/进度优化。每一步都要在至少一个实际支持的 Cursor 版本上验证，而不是只验证 mock DOM。

---

## 8. Issue #28：`/` 命令、skills、commands 与 summarize

### 8.1 判断

该问题真实存在，目标也合理，但需要收窄“执行”的含义。Web 客户端可以可靠地发现并发送 Cursor 支持的 slash command；它不能凭空获得 Cursor 内部命令执行 API，也不应在 Relay 中直接执行来自工作区的任意脚本。

因此：

- **可纳入范围：** Web 端 `/` 菜单、命令搜索、参数输入、已允许名称的转发、`/summarize` 的显式发送、执行结果/错误反馈。
- **暂不纳入范围：** Relay 直接运行任意 skill/command 文件、从任意路径读取指令、绕过 Cursor 权限执行 shell、自动替用户确认高风险命令。

### 8.2 推荐协议

定义一个独立的命令发现和执行协议：

```ts
interface SlashCommandInfo {
  name: string;
  kind: 'builtin' | 'skill' | 'command';
  description?: string;
  source: 'cursor' | 'workspace' | 'user';
  supportsArgs: boolean;
}

interface SlashInvokePayload {
  commandId: string;
  type: 'invoke_slash';
  name: string;
  args?: string;
}
```

处理方式：

1. 服务端在受控根目录中发现项目/用户配置的 skill 和 command 元数据；目录范围、文件名和大小均受 allowlist 限制。默认只读取项目约定的 `.cursor/skills`、`.cursor/commands` 等目录，实际路径以探测结果和配置为准。
2. 对 Cursor 原生 slash command，优先通过已探测的 Composer 交互获取名称；若没有稳定发现入口，使用显式配置，不猜测任意 DOM 文本。
3. 客户端输入 `/` 时显示搜索菜单，但保留普通文本输入能力；只有用户选择菜单项或明确提交已识别命令时，才走 `invoke_slash`。
4. Relay 校验 `name` 是否存在于当前允许列表，再将规范化后的 `/name args` 交给现有 `sendMessage` 路径。这样 Cursor 仍负责真正的 command/skill 语义、权限和上下文。
5. `/summarize` 作为内置候选，但只有探测确认当前 Cursor 支持时才显示；执行本质是向 Cursor 发送 `/summarize`。服务端不能宣称自己直接清理了模型上下文。若 Cursor 不支持，返回明确的 capability error。
6. 命令发现结果带版本/时间戳或短 TTL；工作区文件变化后重新扫描，避免长期使用过期命令列表。

### 8.3 安全限制

- `name` 只允许字母、数字、短横线、下划线和点，禁止 `/`、`..`、绝对路径和路径分隔符。
- 读取 command/skill 文件时使用 realpath 校验其仍位于允许根目录内；限制文件大小，禁止把文件内容作为未经审查的可执行代码交给 Node。
- 参数作为文本传给 Cursor，不在 Relay 中拼接 shell 命令；不允许通过参数改变服务器读取路径或执行策略。
- 发现不到的命令不允许“猜测执行”；发送失败、Cursor 不支持和权限等待都应通过 `CommandResult` 返回。
- skills/commands 中的敏感文件内容不通过列表接口完整返回，菜单只展示名称和短描述。

### 8.4 改动点与测试

- `src/server/types.ts`：增加 slash command 类型、能力信息和 payload。
- `src/server/relay.ts`：增加 `command:list_slash`、`command:invoke_slash`，加入鉴权、名称校验和当前工作区边界。
- `src/server/command-executor.ts`：复用文本发送，必要时增加 Cursor 原生 slash 菜单探测；不新增任意代码执行器。
- `src/client/app.js`、`src/client/index.html`、`src/client/styles.css`：`/` 菜单、键盘导航、参数输入、加载/错误状态。
- 测试：命令发现 allowlist、路径穿越、参数原样传递、未知命令拒绝、`/summarize` capability error、普通以 `/` 开头的文本不被误拦截、重连和重复点击去重。

推荐先做“发送已知 slash command + `/summarize` 能力探测”，再做工作区 skill/command 发现。这样可以先验证 Cursor 版本兼容性，避免先建立一个无法执行的本地命令抽象。

---

## 9. 分阶段交付计划

### Phase 0：验证与协议准备

- 对目标 Cursor 版本探测附件入口、虚拟化滚动边界和 slash command 行为。
- 固化类型、能力查询、错误码和 Socket.IO 命令结果格式。
- 为历史缓存、附件临时存储和推送订阅分别设置配额、TTL 和日志脱敏策略。

### Phase 1：正确性和低风险体验

- 交付 #43 的消息合并缓存、`load_history` 和 Web 端加载按钮。
- 交付 #48 的三态主题、CSS Token 和浏览器测试。
- 完成 #18 的页面级通知权限/去重整理。

### Phase 2：移动端输入与后台通知

- 按实际探测结果交付 #52 图片附件，再交付普通文件附件。
- 为 #18 加入 Service Worker、PushSubscription、VAPID、订阅管理和 HTTPS 指引。
- 加入端到端鉴权、限流、失效资源清理和敏感信息检查。

### Phase 3：命令体验

- 先交付已知 slash command 和 `/summarize` capability 检测。
- 再交付受控目录下的 skills/commands 发现、搜索和参数转发。
- 根据 Cursor 版本兼容数据决定是否支持更深的命令详情或参数表单。

### 每个阶段的验收条件

- 旧版纯文本发送、审批、状态同步和 Telegram 传输回归通过。
- 断开重连、无 CDP、鉴权失败、浏览器不支持新能力时都有可理解的错误和降级行为。
- 没有把本地绝对路径、完整附件内容、完整提示词或敏感 command 文件内容泄露到公共状态、日志或未经授权的 HTTP 响应。
- 真实 Cursor 界面验证与单元测试同时通过；仅 mock DOM 通过不能作为附件、滚动或 slash command 功能的最终验收。

## 10. 本次变更范围

本次仅新增本文档，用于记录五个 Issue 的存在性确认、必要性/合理性/可行性判断、技术边界、协议草案、测试策略和分阶段计划；没有修改上述功能代码，也没有改变现有运行行为。