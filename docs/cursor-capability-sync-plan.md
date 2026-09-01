# CursorRemote：Cursor 能力自动发现、差异检测与适配方案

## 1. 文档目的

本文记录 CursorRemote 当前与 Cursor IDE 的连接和能力同步现状，并提出一套可实施的“发现 → 校验 → 差异检测 → 半自动适配 → 回滚”的方案。

本文解决的问题是：

- Cursor 实际可用的 Mode（工作模式）、Model（模型）和 Tool（工具及其可操作动作）与 `http://127.0.0.1:3000/` 展示的不一致。
- Cursor 升级后 DOM（文档对象模型）结构、选择器、ARIA 语义属性或 CDP target（Chrome DevTools Protocol 调试目标）发生变化时，系统无法自动判断是“没有能力”还是“提取失败”。
- 现场发现的可用信息无法安全地沉淀到 `selectors.json`，也没有版本化、校验和回滚流程。

本文是设计和实施方案。代码落地、授权级别和验收分层以第 19–21 节为准：P0/P1 安全边界与 P3 `ActionRegistry` 已接入组合根，但 **ADAPTER_APPLY 本批次禁用**；Mode 候选保持 pending，当前 selector 路径继续生效。不得把 isolated tests 或 PASSIVE live 观测宣称为 SIDE_EFFECT live 通过，也不得宣称真实 Tool 副作用已验收。当前结论以仓库当前代码为准；Cursor DOM 属于易变的内部界面，任何新增解析规则都必须先通过 live probe（实时探测）确认。

---

## 2. 结论摘要

### 2.1 当前系统可以连接 Cursor，但不是完整的能力同步系统

当前系统通过 CDP 访问 Cursor renderer（渲染器）页面，能够：

1. 访问 CDP HTTP endpoint，例如 `http://127.0.0.1:9222/json`。
2. 枚举部分 Cursor 页面 target，并连接其中一个 target。
3. 使用 `Runtime.evaluate` 在目标页面读取聊天 DOM。
4. 使用 `Input.insertText`、键盘事件和页面点击执行部分远程操作。
5. 将提取后的状态通过 Relay（中继服务器）和 Socket.IO 推送到网页端。

这条链路证明了“可以连接 Cursor”，但不等于“可以发现 Cursor 当前全部能力”。目前缺少能力目录、候选证据、置信度、版本指纹和配置生命周期管理。

### 2.2 本次发现的主要差异

| 能力 | 当前实现 | 现场表现 | 结论 |
| --- | --- | --- | --- |
| CDP target | 从 `/json` 选择 URL 中包含 `workbench` 的 page target | Cursor 3.17.21 现场有两个有效 `page/workbench` target；二者均可读取 workspace、消息、文本框和 `[data-mode]` | target discovery 仍需作为身份与路由安全门槛，但 target 误选不是当前已证实的主因 |
| Mode | `src/server/dom-extractor.ts` 返回固定的 4 个模式 | 有效 workbench target 中存在可见 `[data-mode]` 元素；Cursor 界面显示的模式数量仍与固定列表不同 | 当前值具备直接探测信号，但可用列表不会自动跟随 Cursor |
| Model | 依赖 `selectors.json` 的固定触发器，并通过打开菜单读取选项 | 两个有效 workbench target 中，`.ui-model-picker`、`.ui-model-picker__trigger`、`.composer-unified-dropdown-model` 均为 0 命中 | 当前主要故障是 Model 入口选择器/语义识别失效，而不是无法连接 renderer |
| Tool | 已能针对部分消息和工具调用读取 `data-*` 属性及动作按钮 | 没有统一的 Tool 能力目录和发现状态 | 需要将工具类型、动作、可执行性、来源纳入能力快照 |
| 配置更新 | `selectors.json` 可被加载 | 未发现探测结果自动写回、校验或回滚流程 | 不能直接将现场 DOM 结果覆盖配置 |
| 前端同步 | `src/client/app.js` 渲染服务端的 `mode.available` 和模型数据 | 前端仍有固定模式标签映射 | 服务端动态能力与前端固定展示逻辑可能再次产生差异 |

### 2.3 推荐的产品决策

推荐将“自动适配”设计为**半自动确认**，而不是无条件覆盖配置：

- 自动发现和生成候选适配方案可以无人值守运行。
- 自动校验只能使用安全、只读的实时探测和受限的动作验证。
- 只有候选方案通过结构校验、语义校验、目标唯一性校验和回归检查后，才进入“待确认”。
- **本批次不激活 pending adapter。** `POST /api/adapters/:id/apply` 在通过确认字段校验后仍稳定返回 `503 ADAPTER_ACTIVATION_UNAVAILABLE`；Mode 候选保持 `pending_confirmation`，当前 `selectors.json` / builtin 选择器路径继续作为活动命令路径。
- 设计上的 ADAPTER_APPLY（用户确认后按 capability kind 激活、紧急管理员显式 `apply`、备份与按 binding 回滚）要等生产 `AdapterRegistry` 接入真实 Cursor build 与 DOM fingerprint 之后才能解除 503。在此之前不得把 apply 200、Web 激活按钮或“候选已生效”写成当前行为。

原因是选择器错误通常不是普通读取错误：它可能把另一个按钮误识别为“Approve（批准）”、把计划模型识别为全局模型，或在错误的目标页面上执行点击。无条件覆盖会把一次探测错误变成远程控制风险。

---

## 3. 当前实现和现场证据

### 3.1 现有数据流

当前主要数据流如下：

```text
Cursor Electron renderer
        │ CDP WebSocket / Runtime.evaluate / Input
        ▼
CDPBridge + CdpClient
        ▼
DOM Extractor ──► CursorState
        ▼
StateManager ──► state:full / state:patch
        ▼
Relay ──► Socket.IO Web client / Telegram transport
```

控制命令则沿相反方向经过 Relay 和 `CommandExecutor`，再通过 CDP 对 Cursor 页面进行点击、输入或键盘操作。

### 3.2 当前 Mode 提取的限制

`src/server/dom-extractor.ts` 当前先使用配置传入的模式选择器寻找元素，然后读取 `data-mode`。如果没有找到有效元素，仍会使用默认当前模式和固定的 `available` 列表。当前固定列表包括 Agent、Plan、Debug、Ask 四项。

该实现有两个独立问题：

1. **当前模式不一定可信**：未找到触发器时使用 `agent`，这会把“提取失败”误报为“当前是 Agent”。
2. **可用模式不是实时发现的**：列表在代码中固定，无法表达 Cursor 新增、删除、重命名或按账户/版本隐藏的模式。

建议将“当前模式”和“可用模式”都标记来源及置信度，并区分以下状态：

- `observed`：在当前页面直接看到并解析成功。
- `inferred`：通过可信的页面语义或已验证映射推断。
- `unknown`：当前页面无法确认。
- `stale`：曾经观察到，但本轮无法重新确认。

### 3.3 当前 Model 提取和控制的限制

当前实现已有较多模型菜单 fallback（回退）逻辑：

- 使用 `modelDropdown.strategies` 打开模型菜单。
- 通过 `aria-expanded`、`aria-controls`、`role="menu"`、可见菜单等方式寻找打开的菜单。
- 通过菜单项、稳定 DOM id、文本和合成的 `label::文本` id 读取和选择模型。
- 避免将 React `useId` 生成的易变 id 作为长期模型标识。

这些 fallback 只在已经连接到正确 renderer 且能够打开菜单时有效。本次现场探测显示：

- `probe-model-picker.ts` 仍在尝试 `.ui-model-picker...` 等固定/旧触发器。
- 直接检查时，`.ui-model-picker`、相关 Composer 选择器以及 `[data-mode]` 没有得到有效元素。
- 模型菜单读取失败时，网页可能显示 `No models available`，但这不能直接证明 Cursor 没有模型。

因此模型状态必须把“菜单为空”和“菜单未能打开”分开处理。菜单未打开时，应该返回 `unknown` 或保留上一次的 `stale` 状态，而不是返回空模型列表。

### 3.4 当前 Tool 提取的限制

当前提取器已经利用一批 Cursor 的 `data-*` 属性和工具相关 DOM 标志识别消息、工具调用、命令审批、编辑和计划等元素。`CommandExecutor` 也已有动作按钮解析、模型菜单和计划模型菜单逻辑。

但当前没有一个统一的 Tool 能力模型来回答这些问题：

- 当前 Cursor 页面有哪些 Tool 类型？
- 每个 Tool 当前是否存在可执行动作？
- 动作是批准、拒绝、运行、跳过、允许还是查看？
- 动作是否安全地绑定到唯一的 DOM 对象？
- 这个 Tool 是当前版本原生存在、配置发现得到，还是一次消息实例临时出现？

因此需要把“工具实例提取”和“能力发现”分开：工具实例用于展示当前消息；能力发现用于描述当前页面支持的工具类别和安全动作。

### 3.5 当前 CDP target 基线与仍需解决的问题

`CDPBridge` 会从 CDP `/json` 获取 targets，并把 URL 中含有 `workbench` 的 page target 转换为 Cursor 窗口。独立的 `src/discovery/discover-dom.ts` 也会优先选择 URL 中含 `workbench` 的 page，再退回任意 page。

本次 review 重新对 Cursor 3.17.21 的 live CDP endpoint 进行了只读探测，确认：

1. `/json/version` 的 User-Agent 明确包含 Cursor 3.17.21、Electron 40.10.3 和 Chrome 144。
2. `/json` 同时存在两个 `page/workbench` target、两个 `webview` target 和若干 worker target。
3. 两个 page target 均可通过 `Runtime.evaluate` 读取各自 workspace 路径。
4. 两个 page target 均存在 Workbench、消息包装器、文本框、可见 `[data-mode]` 和多个菜单按钮。
5. 旧 Model 触发器 `.ui-model-picker`、`.ui-model-picker__trigger` 和 `.composer-unified-dropdown-model` 在两个 page target 中均为 0 命中。

因此，`webview about:blank` 的存在不能作为“未连接到 Composer”的证据；现有发现脚本会列出所有 target，真正需要诊断的是它最终选择了哪个 page、该 page 的语义探测结果以及后续 selector 命中情况。当前已证实的直接问题是 Model 触发器适配失效，Mode 列表则仍被固定代码覆盖。

Target discovery 仍然是必要的安全和正确性边界，但目标应调整为：

- 验证 CDP endpoint 确实属于 Cursor，而不是普通 Chrome、VS Code 或其他 Electron 应用。
- 验证 page target 是 Cursor Workbench，并安全排除 webview、worker 和扩展页面。
- 在首次连接时对多个合法 Workbench 排序，同时保留用户选择的 preferred target 重连语义。
- 将“合法 Cursor 窗口”和“当前是否打开 Composer”分开判断；没有打开 Composer 的窗口仍是合法窗口，只是 capability readiness 为 unavailable。
- 为每个 target 输出可解释的身份、路由和能力诊断，避免把 target 问题与 selector 问题混为一谈。

---

## 4. 目标和非目标

### 4.1 目标

1. 自动发现所有候选 Cursor renderer target，并排除无关 webview、about:blank 和扩展页面。
2. 通过语义化信息提取 Mode、Model 和 Tool 能力，减少对易变 class 名称的依赖。
3. 对每个候选数据记录来源、置信度、目标 target、页面指纹和验证时间。
4. 运行时检测“没有能力”“暂时不可见”“提取失败”“配置过期”这几种不同情况。
5. 为 selector（选择器）提供多级 fallback、版本兼容、校验、激活、持久化和回滚机制。
6. 保持当前 `CursorState`、Socket.IO 和命令协议的兼容，并逐步增加能力元数据。
7. 在探测失败时提供可操作的诊断信息，而不是只显示空列表。
8. 对所有可执行动作实施安全边界，防止网页 DOM 结果直接生成任意脚本或危险点击。

### 4.2 非目标

1. 不调用未验证的 Cursor 内部网络 API、私有 IPC API 或数据库作为第一阶段依赖。
2. 不把 Cursor 页面任意 DOM 当作可信配置源。
3. 不允许远端客户端提交任意 JavaScript 给 `Runtime.evaluate` 执行。
4. 不承诺 Cursor 每次升级后都可以零人工恢复全部功能。
5. 不将完整 DOM、聊天全文或敏感配置持久化到 selector 配置中。
6. 不在第一阶段实现跨 Cursor 版本的无限通用解析器；优先覆盖已验证的版本族和安全降级路径。

---

## 5. 总体设计

新增一个独立的 Capability Discovery（能力发现）层，与现有 DOM 消息解析器和命令执行器解耦：

```text
Cursor CDP endpoint
        │
        ▼
┌─────────────────────┐      hard identity gate      ┌──────────────────────┐
│ Target Discovery     │─────────────────────────────►│ CDPBridge             │
│ app/workbench probe  │                              │ preferred target      │
│ initial ranking      │                              │ window lifecycle      │
└──────────┬──────────┘                              └──────────┬───────────┘
           │                                                     │
           │ passive evidence                                    │ CdpClient
           ▼                                                     ▼
┌─────────────────────┐                              ┌──────────────────────┐
│ Capability Extractor │◄─────────────────────────────│ Target UI Coordinator│
│ mode/model/tool      │   serialized interactive    │ per-target lock       │
│ completeness/source  │   probes and commands       │ cancel/cleanup        │
└──────────┬──────────┘                              └──────────┬───────────┘
           │                                                     │
           ▼                                                     ▼
┌─────────────────────┐      validated strategy      ┌──────────────────────┐
│ Adapter Registry     │─────────────────────────────►│ Runtime Validator    │
│ build/fingerprint/   │                              │ read/action recheck  │
│ capability binding   │                              └──────────┬───────────┘
└──────────┬──────────┘                                         │
           │                                                     ▼
           ▼                                          ┌──────────────────────┐
┌─────────────────────┐                               │ Action Registry       │
│ Adapter Store        │                               │ target/generation/TTL │
│ pending/history      │                               │ one-time consumption │
│ atomic rollback      │                               └──────────┬───────────┘
└──────────┬──────────┘                                         │
           │                                                     │
           └────────────────────┬────────────────────────────────┘
                                ▼
                     ┌────────────────────────┐
                     │ CapabilityStateManager │
                     │ per-target revision    │
                     │ full/patch/stale       │
                     └───────────┬────────────┘
                                 │ EventEmitter
                                 ▼
                      Relay / Web / Telegram
```

能力状态不直接由 DOM `CursorState` 所有。`CapabilityStateManager` 是动态能力的唯一状态所有者；现有 `StateManager` 继续管理聊天和连接状态。`index.ts` 只负责通过 EventEmitter 连接两条状态流，Relay 再向旧字段投影兼容的 `mode`/`model` 值。

### 5.1 组件职责

#### `TargetDiscovery`

负责请求 CDP targets、运行轻量身份探测、计算候选分数并返回目标候选。它不负责解析聊天内容，也不负责执行用户命令。

#### `PassiveProbe` 与 `InteractiveProbe`

`PassiveProbe` 在指定 target 页面中执行固定、只读的结构化探测，只读取当前 DOM，不点击、不改变焦点、不打开菜单。启动、周期健康检查和无人工介入的灰度观测只能运行 PassiveProbe。

`InteractiveProbe` 允许在用户明确请求、Mode/Model 命令执行前或候选 adapter 验证时临时打开菜单。它属于 UI mutation，必须通过 `TargetUiCoordinator` 串行化，并负责超时、取消、关闭自己打开的菜单和恢复焦点。不能把“打开菜单但不选择”称为只读操作。

两类 probe 均不返回完整 DOM，也不执行页面提供或客户端提交的脚本字符串。

#### `TargetUiCoordinator`

按稳定 `targetId` 管理共享操作队列，供 InteractiveProbe、`CommandExecutor` 和临时非主窗口连接共同使用。锁不能只按 `CdpClient` 对象建立，因为多个 CDP WebSocket 可能同时操作同一个 target。窗口切换、target generation 改变或连接断开时取消队列中尚未开始的操作。

#### `CapabilityExtractor`

将探测摘要转换为 Mode、Model、Tool 的候选能力。每个候选带有 `source`、`confidence`、`evidence` 和 `scope`。

#### `AdapterRegistry`

管理不同 Cursor 版本族或页面结构族的适配策略。策略包含受限 selector、语义提取器名称、验证规则和优先级，不包含任意 JavaScript。

#### `RuntimeValidator`

在激活候选前进行验证。读取类能力优先只读验证；可执行动作只允许在明确的测试上下文、用户确认或安全的现有命令流程中验证。

#### `AdapterStore`

管理活动配置、待确认候选、历史备份、版本和回滚。它可以将已批准的有限 selector 写入独立适配文件，避免直接修改源代码或无条件覆盖根目录 `selectors.json`。

#### `DifferenceEngine`

比较期望能力、当前活动适配器的结果和实时观察结果，生成结构化差异，并决定是否属于能力变化、页面暂不可见、适配器失效或探测不完整。只有 `completeness === 'complete'` 的菜单快照可以产生 `removed` 或 `empty`。

#### `CapabilityStateManager`

动态能力的唯一状态所有者。它按 target/window 保存 revision、完整性、来源、adapter binding、最后成功快照和 stale 状态，并通过 EventEmitter 发出 `capabilities:full`、`capabilities:patch` 和状态变化。DOM 提取器不得覆盖这些字段。

#### `ActionRegistry`

把可执行能力转换成服务端生成的不透明 action id，并在服务端保存 window、target、target generation、Composer、tool call、adapter 和 TTL 绑定。客户端只提交 action id；执行前再次验证作用域和 DOM，成功后一次性消费危险动作。

---

## 6. Cursor CDP target 自动发现

### 6.1 两阶段发现

#### 阶段 A：HTTP target 枚举

按以下顺序请求并记录诊断：

1. `${CDP_URL}/json/version`：读取 Browser、User-Agent、Protocol-Version 和 WebSocket 调试地址。
2. 对应用身份执行硬门槛校验：User-Agent 或其他经过验证的应用标识必须证明 endpoint 属于 Cursor。普通 Chrome、VS Code 或未知 Electron 应用不得进入命令执行链路。
3. `${CDP_URL}/json/list` 或兼容的 `/json`：取得 target id、type、title、url、webSocketDebuggerUrl。
4. 对每个存在 `webSocketDebuggerUrl` 的 page target 建立短连接，设置严格超时。

如果 endpoint 不支持 `/json/version` 或无法证明应用身份，可以继续运行脱敏诊断，但状态必须为 `endpoint_unverified`；不得把 client 注入 `CommandExecutor`，不得执行 InteractiveProbe 或任何远程命令。应用身份硬门槛与后续 target 评分是两个独立步骤，分数不能弥补身份校验失败。

#### 阶段 B：运行时身份探测

对每个 page target 执行一个只读、短时、无副作用的 probe，至少收集：

- `document.title`、`location.href`、`document.visibilityState`。
- `document.body` 是否存在及其 class 数量。
- 是否存在 `vscode` 运行时对象，且是否能读取 workspace 信息。
- 是否存在 Workbench 特征，如 `#workbench\.parts\.auxiliarybar`、编辑器区域、辅助栏或已知 Composer 语义结构。
- 是否存在文本框、聊天消息包装器、菜单触发器、模式/模型相关的 ARIA 或 `data-*` 属性。
- 页面可视区域尺寸和候选元素的 `getBoundingClientRect()`，用来排除隐藏 webview。
- target 与 probe 的耗时、异常、返回值完整性。

probe 只返回结构化摘要和截断文本，不返回 HTML、script、style 或任意事件处理器内容。

### 6.2 候选目标评分

建议使用可解释的评分，而不是单一的 URL 判断：

| 信号 | 建议分值 | 说明 |
| --- | ---: | --- |
| `type === page` | +20 | 只将 page 作为主候选 |
| 存在 debugger WebSocket URL | +15 | 没有 URL 无法连接 |
| URL 包含 `workbench` | +15 | 兼容当前版本，但不是必要条件 |
| 页面可读取 workspace | +25 | 强身份信号 |
| 发现可见 Composer/聊天容器 | +25 | 强业务信号 |
| 发现消息包装器 | +10 | 说明已进入聊天页面 |
| 发现可见文本框或模式/模型触发器 | +10 | 说明页面可操作 |
| `about:blank` | -40 | 通常是 webview 或空页面 |
| target type 为 `webview` | -50 | 默认不作为主 renderer |
| 页面无 body 或 Runtime.evaluate 超时 | -50 | 不能进行 DOM 提取 |

候选策略：

- 评分只在**首次连接且没有用户或系统 preferred target** 时用于排序合法 Cursor Workbench。
- 用户显式选择或上次成功连接的 preferred target 只要仍存在、可握手且通过身份校验，就必须优先于评分；不得静默切换到更高分窗口。
- preferred target id 在 Cursor 重启后失效时，使用 workspace identity、窗口限定符和页面指纹尝试唯一映射；映射歧义时保持 `target_unverified`，等待用户选择。
- 最高分 target 必须达到最低阈值，例如 60，但阈值只表示 Workbench 候选质量，不能替代 Cursor 应用身份硬门槛。
- 多个高分 target 保留为独立窗口候选，不自动合并。
- 没有打开 Composer 的 Cursor Workbench 仍是合法窗口；它的 capability readiness 为 `unavailable`，不能因缺少 Composer 而从窗口列表删除。
- 若无 target 达到阈值，状态为 `target_unverified`，不得连接到任意第一个 page。
- 用户在诊断页面显式选择 target 后仍需重新运行身份 probe。

所有分数和命中信号必须出现在诊断结果中，便于解释“为什么选中这个 target”。同时记录选择原因：`preferred_exact`、`preferred_remapped`、`initial_ranked` 或 `manual`。

### 6.3 多窗口和 target 生命周期

现有 `CDPBridge` 已支持多个 Cursor 窗口和主连接/临时连接的概念。能力发现应沿用该模型：

- target id 是运行时连接和锁的路由标识，不是长期适配器标识。
- Cursor 重启或窗口重建后 target id 可能变化，应通过 workspace identity、远程限定符和页面指纹尝试唯一关联。
- 用户选择的 preferred target 必须在仍有效时保持；自动评分不能覆盖它。
- 每次 target 重建生成新的 `targetGeneration`，旧能力 revision、旧 action id 和未开始的 InteractiveProbe 全部失效。
- 每个窗口单独保存 target probe 和 capability snapshot。
- 主窗口持续轮询；非主窗口按照现有 `WindowMonitor` 的周期进行短连接探测，但所有 UI mutation 按 target id 进入同一协调队列。
- 目标从 `/json` 消失后，标记为 `disconnected`，保留最近快照供诊断，但不继续执行命令。
- `webview about:blank` 和 CursorRemote 自身 WebView 不应作为 Cursor 工作窗口展示给前端。

### 6.4 target 身份指纹

建议生成以下指纹字段：

```json
{
  "targetId": "runtime-only-id",
  "targetType": "page",
  "browserFamily": "cursor",
  "protocolVersion": "observed-value",
  "workspaceKey": "authority-and-normalized-path",
  "domSignature": "hash-of-allowed-structural-signals",
  "featureSignature": "hash-of-semantic-feature-names",
  "observedAt": 0
}
```

`targetId` 和 WebSocket URL 不应作为长期配置写入 selector 适配文件。指纹中只保留用于匹配的归一化信息，避免持久化路径中的不必要敏感内容。

---

## 7. Mode、Model、Tool 的语义化提取

### 7.1 通用提取原则

解析优先级建议如下：

1. 稳定的语义属性：`data-*`、`aria-*`、`role`、`aria-controls`、`aria-expanded`、`aria-selected`、`aria-checked`。
2. 经过实时验证的 test id 或 command id。
3. 结构化可见文本和菜单层级。
4. 已登记、带 Cursor 版本范围的 CSS selector。
5. class 名称和位置链只作为低优先级候选或诊断信息。

必须遵守：

- 先探测，再解析；解析器不能凭猜测创建可执行能力。
- 通过唯一性、可见性、文本一致性和父子关系验证候选。
- 一个元素同时匹配多个能力时标记冲突，不自动选择危险动作。
- “本轮没有找到”不能直接转换成“能力不存在”。
- 文本只用于展示和比对，不能将未验证文本直接变成命令或脚本。

### 7.2 Mode 提取方案

Mode 应使用以下发现流程：

1. 在 Composer 作用域内寻找当前模式触发器：
   - `aria-haspopup="menu"` 或 `aria-expanded` 的按钮。
   - `data-mode`、`data-mode-id`、`data-command-id` 等稳定属性。
   - 可见按钮文本或 `aria-label` 中的模式名称。
2. 读取当前按钮的：
   - 规范化显示名称。
   - 稳定 id 或 command id。
   - `aria-expanded` 状态。
   - 当前选中/激活属性。
3. PassiveProbe 只读取当前触发器；需要完整列表时，由用户请求、设置命令或 adapter 验证启动 InteractiveProbe，并通过 `TargetUiCoordinator` 打开模式菜单。
4. 从该 probe 自己打开且已关联的可见菜单读取顶层选项：
   - 只接受具有菜单项语义的行，如 `role="menuitem"`、`role="option"` 或经验证的选项容器。
   - 从专用 label、`aria-label`、文本节点读取显示名。
   - 排除 Settings、Configure、Help、编辑按钮等操作项。
   - 用稳定 id；没有稳定 id 时使用 `mode::<规范化标签>` 的临时 id。
5. 对每个选项进行唯一性检查和动作语义检查，再生成 `ModeCapability`。

建议的逻辑数据结构：

```ts
interface ModeCapability {
  id: string;
  label: string;
  icon?: string;
  current: boolean;
  source: 'data_attribute' | 'aria' | 'menu' | 'registered_adapter' | 'inferred';
  confidence: number;
  scope: 'composer';
  selectable: boolean;
  observedAt: number;
}
```

`icon` 只作为展示信息。前端不应通过固定 id 映射决定模式是否存在；如果没有图标，使用通用图标。已有的固定映射应改为未知模式的通用展示回退。

#### Mode 设置

`set_mode` 必须满足：

- 目标 mode id 必须来自本次或最近一次已验证的能力快照，或来自明确登记的安全 adapter。
- 打开菜单后再次读取选项，防止使用过期 id。
- 只对唯一且标签精确匹配的菜单项点击。
- 点击后重新读取当前模式并确认发生变化；确认失败时返回错误，不把命令结果报告为成功。
- 菜单打开失败、菜单选项为空和目标不存在使用不同错误码。

### 7.3 Model 提取方案

Model 分为 Composer 全局模型和 Plan/执行计划作用域模型，二者不能混合。

发现流程：

1. 在 Composer 作用域寻找模型触发器，优先使用 `role`、`aria-haspopup`、`aria-expanded`、`aria-controls`、稳定 `data-*` 或已验证 test id。
2. 通过触发器 id、`aria-controls`、DOM 祖先关系和 plan 标识判断作用域。
3. 读取触发器的当前可见文本和稳定标识，形成当前模型候选。
4. PassiveProbe 不打开菜单；需要完整列表时，由 InteractiveProbe 在共享 target 锁内打开与触发器关联的菜单。
5. 在关联菜单中读取当前已挂载的顶层模型行，并同时探测 `scrollHeight/clientHeight`、`aria-setsize/aria-posinset`、分组、搜索过滤和异步加载状态。
6. 排除 Edit、Configure、Remove、Delete、Star 等动作按钮和嵌套按钮。
7. 记录模型行的显示标签、稳定 id、选中状态、是否有副标题/套餐标记。
8. 生成稳定的展示 id：
   - 首选经验证的稳定业务 id。
   - React `useId` 形式的 id 不持久化。
   - 没有稳定 id 时使用规范化标签，并记录 `idStability: 'label'`。
9. 计算菜单完整性：
   - `complete`：能够证明所有选项均已观察到。
   - `partial`：存在虚拟列表、滚动加载、搜索过滤或只观察到部分行。
   - `unknown`：无法判断列表是否完整。
10. 在 `finally` 中只关闭该 probe 自己打开的菜单，并恢复原焦点；关闭失败产生诊断，不继续执行后续 UI mutation。

建议的数据结构：

```ts
interface ModelCapability {
  id: string;
  label: string;
  selected: boolean;
  scope: 'composer' | 'plan';
  idStability: 'stable' | 'label' | 'runtime_only';
  source: 'aria' | 'data_attribute' | 'menu' | 'registered_adapter';
  confidence: number;
  selectable: boolean;
  observedAt: number;
}

type MenuCompleteness = 'complete' | 'partial' | 'unknown';

interface ModelCapabilitySnapshot {
  items: ModelCapability[];
  completeness: MenuCompleteness;
  filterActive: boolean;
  observedAt: number;
}
```

模型菜单失败时需要明确返回：

- `trigger_not_found`：没有找到可验证的触发器。
- `menu_not_opened`：触发器存在，但菜单没有打开。
- `menu_scope_ambiguous`：发现多个可能菜单，无法安全判断。
- `menu_open_empty`：菜单已打开且可见，但确实没有模型行。
- `model_parse_partial`：菜单可读，但部分行缺少稳定字段。

只有菜单完成异步稳定等待、`completeness === 'complete'` 且未启用过滤时，`menu_open_empty` 才可以报告“模型列表为空”，也只有该状态可以产生模型 `removed`。`partial` 和 `unknown` 快照可以发现新增项，但不得把未挂载项标记为删除，也不得覆盖上一份 complete 快照。

#### Model 设置

保留现有 `MODEL_MENU_LOOKUP_JS` 和 `MODEL_ITEM_HELPERS_JS` 的复用方向，但将其收敛为受限、可测试的语义解析器：

- 每次设置前重新打开并重新收集模型项。
- 不依赖 React 生成的 id。
- 目标匹配优先精确 id，其次精确 label，最后才允许经过长度保护的 label fallback。
- 若多个行同名，返回歧义错误，不点击。
- 选择后验证菜单关闭和当前模型文本/选中状态。

### 7.4 Tool 能力提取方案

Tool 能力不应只通过 class 名称列举。建议将工具分成三层：

#### A. 工具类型

例如：

- `shell`：运行 shell 命令。
- `edit`：编辑或应用文件变更。
- `fetch`：网络或白名单相关操作。
- `plan`：创建、查看、构建计划。
- `questionnaire`：多选问题或自由填写。
- `generic_tool`：能够识别为工具调用但尚未归类的工具。

以上只是分类示例，不能把示例列表当成固定能力列表。

#### B. 工具实例

工具实例从当前消息包装器中读取：

- `data-tool-call-id`。
- `data-tool-status`。
- `data-message-kind`、`data-message-role`。
- 可见动作按钮及其 label/ARIA。
- 工具描述、命令文本、文件名和结果状态。

#### C. 可执行动作

每个动作必须包含：

```ts
interface ToolActionCapability {
  /** 服务端生成的不透明 id；客户端不得据此推导 selector。 */
  id: string;
  type: 'approve' | 'reject' | 'run' | 'skip' | 'allow' | 'view' | 'build' | 'continue';
  label: string;
  executable: boolean;
  requiresConfirmation: boolean;
  expiresAt: number;
}

interface RegisteredActionTarget {
  actionId: string;
  windowId: string;
  targetId: string;
  targetGeneration: number;
  composerId: string;
  toolCallId: string;
  adapterId: string;
  actionType: ToolActionCapability['type'];
  expectedLabel: string;
  selectorStrategyId: string;
  createdAt: number;
  expiresAt: number;
  consumed: boolean;
}
```

`RegisteredActionTarget` 只保存在服务端 `ActionRegistry`，不通过公开状态发送给客户端。客户端只收到 `ToolActionCapability.id`、展示字段和过期时间。

Tool 发现只报告“当前页面存在且可验证的动作”。它不应扫描任意按钮后将按钮文本直接上报为可执行动作。动作候选必须满足：

- 位于已识别的工具实例作用域内。
- 是 button 或已验证的 button-like 元素。
- label 与已登记动作语义匹配。
- 目标唯一且可见。
- 不在 disabled、hidden、aria-disabled 状态。
- 可以在执行前再次解析和确认。

未知工具可以展示为 `generic_tool`，但默认 `executable: false`，直到增加专门解析器并完成验证。

#### D. Action 注册、执行和失效

1. CapabilityExtractor 发现可执行动作后，向 ActionRegistry 注册服务端目标并取得随机、不可预测的 action id。
2. action 必须绑定 `windowId + targetId + targetGeneration + composerId + toolCallId + adapterId + actionType`，并设置短 TTL。
3. 客户端执行时只提交 action id 和 command id；Relay 不接受 selectorPath 作为授权依据。
4. 执行前确认 action 未过期、未消费、目标窗口仍存在、generation 未变化、Composer/tool call 仍匹配。
5. 在 `TargetUiCoordinator` 队列内重新定位元素，并再次检查作用域、label、唯一性、可见性和 enabled 状态。
6. Approve、Run、Allow、Build、Continue 等改变状态的动作在成功后一次性消费；失败是否允许重试由错误类型决定。
7. target 切换、generation 变化、adapter 变更、tool call 完成或 TTL 到期时立即失效相关 action。
8. ActionRegistry 设置每窗口和全局容量上限，避免 DOM churn 导致内存无限增长。

---

## 8. 多级 selector、fallback 和版本兼容

### 8.1 Selector 层级

每个能力入口使用分层策略，建议顺序如下：

1. `data-testid`、`data-command-id`、稳定的业务 `data-*`。
2. `aria-label`、`aria-controls`、`role` 与 `aria-expanded` 组合。
3. 语义 DOM 关系，例如“Composer 内部唯一的菜单按钮”。
4. 已验证的版本适配 selector。
5. 文本 label + 作用域 + 唯一性验证。
6. class/层级 selector，仅作最后回退和诊断。

每个 strategy 必须说明：

- 目标能力和作用域。
- 适用 Cursor 版本或 DOM 指纹。
- 是否只读或可执行。
- 验证条件。
- 失败时的错误码。

### 8.2 适配器版本模型

建议新增独立配置文件，例如 `data/adapters.json`，而不是让运行时直接覆盖根目录 `selectors.json`。源代码中的 `selectors.json` 仍作为默认安全基线。

示例结构：

```json
{
  "schemaVersion": 1,
  "activeBindings": [
    {
      "cursorBuild": "3.17.x",
      "domSignature": "allowed-hash",
      "capabilityKind": "model",
      "adapterId": "builtin-default-model"
    }
  ],
  "adapters": [
    {
      "id": "candidate-2025-01-01-abc123",
      "status": "pending_confirmation",
      "cursorVersionRange": "3.17.x",
      "domSignature": "allowed-hash",
      "capabilityKinds": ["mode", "model"],
      "strategies": {
        "modeTrigger": [
          {
            "id": "mode-trigger-aria-menu",
            "kind": "aria_role",
            "selector": "button[aria-haspopup='menu']",
            "scope": "composer",
            "operationClass": "passive_read",
            "validation": { "requiresUniqueVisible": true }
          }
        ]
      },
      "evidence": [],
      "createdAt": 0,
      "verifiedAt": null
    }
  ]
}
```

这里的 `selector` 只能是受限 CSS selector，`kind` 和 `operationClass` 由服务端枚举校验。禁止配置任意脚本、函数体、事件处理器或 `javascript:` URL。

`activeBindings` 不是单一全局 adapter 开关，而是按 Cursor build、DOM/feature 指纹和 capability kind 选择 adapter。Mode、Model、Tool 可以独立启用、熔断和回滚；一个窗口的瞬时失败不能直接影响其他指纹或其他 capability。无法唯一匹配 binding 时使用安全内置基线并标记 degraded，不采用“最近一个任意 adapter”。

### 8.3 兼容策略

- 内置适配器按版本族和 DOM 指纹匹配，而不是硬编码单一 Cursor 版本号。
- 当前 selector 配置作为 fallback，但每次命中都记录为 `legacy_selector`。
- 新候选不会自动获得高于内置策略的优先级，除非通过验证和确认。
- 若某策略连续失败达到阈值，标记 `degraded`，但不立即删除。
- 如果新策略验证失败，保留旧策略继续运行，直到旧策略也失效或用户选择切换。
- 提取器和命令执行器共享同一个策略注册表，避免“能读不能点”或“能点但读不到”的不一致。

### 8.4 Selector 安全校验

持久化前必须执行：

1. 长度限制，例如单个 selector 不超过 512 字符，整个候选配置不超过固定字节数。
2. 语法解析，拒绝无效 CSS。
3. 规则白名单：只允许标签、class、id、属性选择器、有限的 `:scope`、`:nth-of-type` 等经测试语法。
4. 拒绝 `script`、`style`、`iframe`、`javascript:`、事件属性和任何函数文本。
5. 限制组合深度、通配符数量和 `querySelectorAll` 扫描范围，避免性能攻击。
6. 只允许写入预定义能力 key，例如 `chatContainer`、`modeTrigger`、`modelTrigger`、`toolAction`，拒绝任意 key。
7. 对可执行动作要求更严格：必须有作用域、label 校验和唯一匹配验证。
8. 序列化前对文本和路径做脱敏，不能把聊天内容、token、密码或完整本地路径作为 evidence 写入配置。

---

## 9. 运行时差异检测

### 9.1 三套状态

差异检测需要比较三类数据：

1. `expected`：当前激活适配器声明的能力和验证规则。
2. `observed`：本轮实时探测得到的能力和证据。
3. `lastKnown`：最近一次成功观察到的能力快照。

建议状态包含：

```ts
interface CapabilityStatus {
  state: 'ok' | 'changed' | 'degraded' | 'unknown' | 'stale' | 'unavailable';
  confidence: number;
  completeness: 'complete' | 'partial' | 'unknown';
  revision: number;
  targetGeneration: number;
  expectedCount: number;
  observedCount: number;
  missing: string[];
  added: string[];
  changed: string[];
  conflicts: string[];
  lastObservedAt: number | null;
  lastVerifiedAt: number | null;
  diagnosticIds: string[];
}
```

### 9.2 差异分类

| 分类 | 判断条件 | 对外表现 | 是否建议自动适配 |
| --- | --- | --- | --- |
| `unchanged` | 目标、指纹和能力均通过验证 | `ok` | 不需要 |
| `added` | 发现新 Mode/Model/Tool，证据充分 | `changed` | 生成待确认候选 |
| `removed` | 旧能力在同一 target generation、同一作用域、未过滤且 `completeness=complete` 的有效菜单中不存在 | `changed` | 标记对应 capability 过期，不删除历史 |
| `selector_failed` | 触发器或作用域找不到 | `degraded` | 生成探测任务 |
| `target_unverified` | CDP target 无法证明是 Cursor renderer | `unknown` | 不适配，先诊断 |
| `menu_unavailable` | 菜单未打开或页面暂时隐藏 | `stale` | 不适配，稍后重试 |
| `ambiguous` | 多个候选无法唯一选择 | `degraded` | 必须人工确认 |
| `parse_partial` | 能力可见但字段不完整 | `degraded` | 只允许只读展示候选 |
| `action_unverified` | 找到文本但不能安全定位点击目标 | `unavailable` | 禁止自动适配执行动作 |

### 9.3 避免空列表误报

以下规则必须落实：

- `mode.available = []` 不能代表 Cursor 没有 Mode；必须同时有 `modeDiscovery.status`。
- Model 菜单未打开时，不覆盖上一轮有效模型列表。
- target 变化时，旧窗口状态不能直接复用到新 target。
- 连接断开、提取超时、权限错误、页面未加载分别记录不同错误。
- 连续失败次数达到阈值时，前端显示“提取异常/数据过期”，而不是继续显示看似实时的数据。

### 9.4 差异检测频率和缓存

建议分层执行：

- 聊天状态：沿用现有轮询频率和状态 debounce。
- target 健康检查：每 5–10 秒，窗口变化或连接断开时立即触发。
- Mode/Model 轻量当前值：每次状态提取只运行 PassiveProbe，不打开菜单。
- 完整 Mode/Model 菜单发现：仅在用户手动刷新、菜单操作前或候选 adapter 验证时运行 InteractiveProbe；启动和普通指纹变化只产生“需要交互探测”的状态，不自动点击。
- InteractiveProbe 与命令执行均按 target id 进入 `TargetUiCoordinator` 队列，不能并发改变同一页面 UI。
- Tool 能力：从当前消息实例增量更新；页面空闲时不反复扫描整个 DOM。
- 差异报告：只在签名变化、状态转变或定时刷新时广播。

缓存 key 至少包含 `workspaceKey`、`composerId`、`scope` 和适配器指纹；不能只用 tab title。

---

## 10. 配置持久化、校验和回滚

### 10.1 存储层次

建议保留三层配置：

1. **内置基线**：代码和根目录 `selectors.json`，随版本发布，人工审查。
2. **本机活动适配器**：`DATA_DIR` 下的版本化文件，只包含已批准且通过验证的候选。
3. **待确认候选和诊断记录**：同样位于 `DATA_DIR`，有大小和数量上限，过期后清理。

不建议直接改写仓库中的 `selectors.json`，因为运行服务可能没有写仓库权限，也因为运行时发现结果不应悄悄改变下次发布的基线。

### 10.2 原子写入

AdapterStore 写入流程：

1. 读取当前文件并校验 schemaVersion。
2. 生成新版本和内容摘要。
3. 写入同目录临时文件。
4. `fsync`（可用时）并原子 rename。
5. 保留最近 N 个备份。
6. 写入一条不含敏感内容的审计记录。
7. 重新读取文件并校验，失败则恢复上一版本。

如果进程异常退出，启动时应选择最后一个完整且校验通过的版本；不应选择半写入文件。

### 10.3 激活前验证

候选适配器从 `pending_confirmation` 到 `active` **在设计上**至少要经过下列校验。**本批次不得走完这条路径**：`POST /api/adapters/:id/apply` 稳定返回 `503 ADAPTER_ACTIVATION_UNAVAILABLE`，pending 保持 pending，当前 selector 路径保持活动。

- JSON/schema 校验。
- CSS selector 语法和安全白名单校验。
- 目标页面身份校验。
- selector 唯一性和可见性校验。
- Mode/Model 读取结果与语义期望一致。
- Tool 动作只读定位校验。
- 如需验证点击，必须是低风险、可取消、用户确认的验证步骤；默认不自动点击 Approve、Run、Allow、Build 等会改变 Cursor 状态的动作。
- 回归测试和现有命令测试通过。

### 10.4 Capability 熔断与 adapter 回滚

运行时异常先触发 capability 级 circuit breaker（熔断），而不是立即回滚全局 adapter。熔断统计必须按 `cursorBuild + domSignature + capabilityKind + adapterId` 隔离，并满足最小样本数、固定时间窗口和失败比例阈值。

可计入熔断的失败包括：

- 已确认正确 target 和作用域后，同一 capability adapter 连续无法通过只读验证。
- `set_mode` 或 `set_model` 在执行前重新发现成功，但目标精确匹配或执行后验证持续失败。
- 同一策略持续产生多个可执行动作候选，无法唯一定位。

以下情况不得直接触发 adapter 回滚：

- target 断开、重建或尚未完成身份验证。
- 页面隐藏、Composer 未打开、菜单异步加载或 snapshot completeness 不是 complete。
- 单个窗口的一次命令失败。
- 旧前端无法解析新 schema；这属于客户端兼容问题。

熔断后：

1. 仅禁用对应 binding 的 capability kind，继续保留其他能力和其他窗口。
2. 回退到该 binding 最近一个验证通过的 adapter；没有安全回退时标记 unavailable，禁止相关写命令。
3. 将失败 adapter/binding 标记为 `rejected_runtime`，保留脱敏诊断摘要。
4. 向 `/health`、`/debug/state` 和能力事件报告熔断范围、样本、阈值和回退结果。
5. 不自动重复激活同一失败 binding，除非 Cursor build/DOM 指纹变化或用户手动重试。

---

## 11. Relay API、前端同步和缓存策略

### 11.1 保持现有接口兼容

现有健康检查、调试状态、Socket.IO 的 `state:full`、`state:patch` 和 `command:result` 继续保留。新增字段应使用可选字段，旧客户端忽略未知字段即可。

建议新增以下 HTTP API，全部放在现有认证中间件之后：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/api/capabilities` | 返回当前窗口的能力快照、状态、来源和时间戳 |
| `GET` | `/api/capabilities/diff` | 返回 expected/observed/lastKnown 差异 |
| `GET` | `/api/discovery/status` | 返回 target probe、最近错误、适配器状态 |
| `POST` | `/api/discovery/run` | 请求一次只读发现；支持指定 window/target |
| `POST` | `/api/adapters/:id/validate` | 对待确认候选执行非破坏性验证（不改变活动 binding） |
| `POST` | `/api/adapters/:id/apply` | **本批次禁用。** 即使 `confirmed: true` 且 binding 字段齐全，也稳定返回 `503 ADAPTER_ACTIVATION_UNAVAILABLE`，不得激活 pending adapter。设计目标仍是确认后按 capability kind 激活，须待生产 `AdapterRegistry` 接入真实 Cursor build + DOM fingerprint。 |
| `POST` | `/api/adapters/rollback` | 回滚到指定的上一版本（只作用于已存在的 active binding；不能用来绕过 apply 的 503） |
| `GET` | `/api/adapters/history` | 返回脱敏的版本、状态、时间和摘要 |

这些 API 使用独立 router，注册顺序必须明确，不能依赖当前位于 `setupRoutes()` 末尾的通用 auth middleware：

```ts
app.post('/api/login', loginRateLimit, loginHandler);
app.use(
  '/api',
  apiBodyLimit,
  requireApiSession,
  requireSameOrigin,
  requireCsrfOrBearer,
  apiRateLimit,
  apiRouter
);
```

请求必须执行：

- 当前 Web session 或有效 Bearer token 鉴权。
- 对 cookie 鉴权的写请求验证 `Origin` 与 `Host`，并要求 CSRF token；也可以规定敏感写接口必须使用 Bearer token。不能把 Socket.IO 的 Origin 校验当作 HTTP API 已有保护。
- 对每个路由设置请求体大小、频率和并发上限；`express.json()` 使用显式 limit。
- window/target id 必须来自服务端已验证 target 列表，并与当前 generation 匹配。
- `apply`、`rollback`、InteractiveProbe 和 action execute 使用 command-like operation id；服务端在短 TTL 内去重，重复请求返回同一结果而不是重复执行。
- `apply` 即使带显式确认也必须保持本批次 503 fail-closed；`rollback` 必须是显式动作，并记录脱敏审计信息。不得把 apply 的确认字段当成激活授权。
- `/api/login` 必须在受保护 API router 之前单独注册；其他 `/api/*` 不允许在 auth middleware 之前注册。

### 11.2 Socket.IO 事件

建议新增：

- `capabilities:full`：连接初始化或手动刷新后的完整能力快照。
- `capabilities:patch`：能力变化、状态转移或适配器状态变化。
- `discovery:status`：探测进度、target 选择、候选数量和失败原因。
- `adapter:pending`：生成待确认适配器时通知客户端。
- `adapter:changed`：激活或回滚后通知客户端。

能力快照不应包含完整 HTML、任意 selector 路径详情或敏感证据。诊断页面可以在认证后请求经过截断和脱敏的证据。

### 11.3 状态所有权与兼容投影

动态能力不直接写入 DOM Extractor 每轮生成的 `CursorState`。新增独立的 `CapabilityStateManager` 作为唯一所有者，避免 `StateManager.onExtraction()` 用新快照替换状态时丢失 discovery 结果，也避免 `mode.current` 未变化时漏发 `mode.available` 更新。

```ts
interface DiscoverySummary {
  status: 'idle' | 'running' | 'ok' | 'degraded' | 'failed' | 'stale';
  targetId: string;
  targetGeneration: number;
  fingerprint?: string;
  lastRunAt: number | null;
  diagnosticIds: string[];
}

interface CapabilitySummary {
  targetId: string;
  targetGeneration: number;
  revision: number;
  modes: ModeCapability[];
  models: ModelCapabilitySnapshot;
  tools: ToolCapability[];
  status: CapabilityStatus;
  adapterBindings: Record<'mode' | 'model' | 'tool', string>;
}
```

状态规则：

1. 每个 target 独立维护单调递增 revision；同一 target generation 中，旧 revision 不得覆盖新 revision。
2. target generation 变化时，旧 action 全部失效，旧能力先转为 stale，不能直接投影到新页面。
3. `CapabilityStateManager` 通过 EventEmitter 发出 full/patch；`index.ts` 负责 wiring，不能让 Relay、Extractor 或 CommandExecutor 互相直接导入业务状态。
4. Relay 连接初始化发送 `capabilities:full`，后续发送带 targetId、generation 和 revision 的 patch。
5. 为兼容旧客户端，服务端从当前 target 最近一份有效能力快照生成旧 `mode`/`model` 字段；这只是只读投影，不是第二个状态源。
6. capability 列表、状态、完整性或 adapter binding 任一变化都必须递增 revision，即使当前 Mode/Model 文本没有变化。
7. 当前 target 没有有效能力快照时，兼容投影使用 `unknown/stale` 对应的安全展示值，禁止伪造 Agent/Auto 为实时观察结果。

### 11.4 前端渲染策略

`src/client/app.js` 应调整为服务端驱动：

- Mode 标签、图标和列表来自能力快照；未知 mode 使用通用图标和服务端 label。
- 不再使用固定的“只有几个模式”的映射决定可选项。
- Model 列表在 `unknown`、`stale`、`empty` 时显示不同状态。
- Tool 操作按钮只有 `executable === true` 且目标证据仍有效时才启用。
- 对待确认 adapter 只展示 pending 数量、风险/验证摘要和诊断。本批次 Web **不**提供激活按钮（无 `[data-adapter-apply]`）；不得把“查看/应用/拒绝”写成当前 UI。reject 可以保留；apply 必须 fail-closed。
- 将来若解除 ADAPTER_APPLY，应用和回滚必须显示确认对话框，明确会影响后续 Cursor DOM 适配，而不是立即执行 Cursor 工具。
- Socket 断线时缓存最后一份快照，但明显标记时间戳和过期状态。

### 11.5 缓存策略

- 内存中保留每个 window/composer/scope 的最近成功能力快照。
- 磁盘只保留适配器元数据和脱敏诊断，不保留完整 DOM。
- 快照设置 TTL，例如 30 分钟；超过 TTL 只能作为 `stale` 展示。
- 不同 workspace、window、composer 的能力不能互相覆盖。
- 发生 Cursor target 重建时，必须重新验证，不能因为 label 相同就直接复用可执行动作目标。

---

## 12. 安全边界

### 12.1 主要风险

1. 恶意或错误 DOM 诱导系统把普通按钮当成 Approve/Run。
2. 发现结果直接写入配置后，下一次远程命令在错误位置点击。
3. 任意 selector 造成大范围 DOM 扫描、性能问题或定位到页面外部元素。
4. 任意 JavaScript 注入让网页端或远端客户端控制 Cursor renderer。
5. 诊断结果包含聊天内容、本地路径、workspace 信息、token 或其他敏感数据。
6. 未认证的局域网用户触发发现、应用适配或回滚。

### 12.2 强制规则

- CDP endpoint 默认仅连接 loopback；不扩大监听范围来解决 target 问题。
- Relay 继续使用现有密码、session cookie、Bearer token 和 Socket.IO 鉴权；HTTP 写 API 额外使用独立 API router、Origin/Host 与 CSRF/Bearer 校验。
- `/health` 的未认证响应只返回最小状态；所有其他 discovery/adapter/action API 必须经过 API router，不能依赖路由末尾的通用 middleware。
- 页面探测脚本必须是代码中固定的、经过审查的 probe；客户端只能选择枚举参数，不能提交脚本字符串。
- selector 只允许安全白名单，并且服务端执行前再次验证。
- 动作执行必须绑定 ActionRegistry 生成的不透明 action id，不能让客户端提交任意 selectorPath 作为授权依据。
- action id 必须绑定 target generation、window、Composer、tool call、adapter 和 TTL；危险动作成功后一次性消费。
- 可执行动作在 `TargetUiCoordinator` 队列内重新定位元素，检查作用域、label、唯一性、可见性和 enabled 状态。
- “发现了按钮”不等于“允许点击按钮”。Approve、Run、Allow、Build 等动作默认需要显式用户命令。
- 诊断日志截断文本并脱敏路径、token、密码、消息正文；日志级别为 debug 时也不得打印认证秘密。
- 配置文件权限按当前用户限制；写入失败必须安全降级到内置适配器。
- 任何新适配器都不能修改 `CommandExecutor` 的执行语义，只能提供受限目标发现和验证信息。

### 12.3 防止网页 DOM 结果直接执行选择器或脚本

推荐的信任边界：

```text
网页 DOM
  └─ 只能产生候选证据和文本
       └─ 语义提取器转换为结构化候选
            └─ schema + selector 白名单校验
                 └─ RuntimeValidator 验证唯一目标
                      └─ ActionRegistry 绑定 target/generation/scope/TTL
                           └─ 客户端只获得不透明 action id
                                └─ TargetUiCoordinator 串行执行并再次验证
```

任何一步失败都只能产生诊断或只读展示，不能自动获得执行资格。

---

## 13. 探测失败时的诊断信息

### 13.1 诊断对象

建议新增统一诊断类型：

```ts
interface DiscoveryDiagnostic {
  id: string;
  code:
    | 'cdp_unreachable'
    | 'endpoint_unverified'
    | 'target_list_failed'
    | 'target_unverified'
    | 'preferred_target_ambiguous'
    | 'webview_target'
    | 'runtime_evaluate_failed'
    | 'composer_not_found'
    | 'mode_trigger_not_found'
    | 'mode_menu_not_opened'
    | 'model_trigger_not_found'
    | 'model_menu_not_opened'
    | 'model_menu_empty'
    | 'model_menu_partial'
    | 'tool_scope_ambiguous'
    | 'action_expired'
    | 'action_scope_changed'
    | 'action_consumed'
    | 'selector_invalid'
    | 'selector_non_unique'
    | 'adapter_validation_failed'
    | 'capability_circuit_open'
    | 'adapter_rollback';
  severity: 'info' | 'warning' | 'error';
  windowId?: string;
  targetId?: string;
  adapterId?: string;
  message: string;
  evidence: Record<string, string | number | boolean | null>;
  createdAt: number;
}
```

### 13.2 最小诊断字段

每次失败至少记录：

- CDP endpoint 的脱敏地址和 HTTP 状态。
- target 数量、各 target 的 type/title/url 摘要和候选分数。
- 选择的 target id 的短 hash，而不是完整可复用凭据。
- Runtime.evaluate 是否成功及耗时。
- 页面 title、可见性、尺寸和特征计数。
- 使用过的 strategy id，不只记录最终 selector 文本。
- selector 命中数、可见命中数、唯一性结果。
- 当前 adapter id、DOM/feature 指纹、上一次成功时间。
- 最终错误码、建议的下一步和重试时间。

### 13.3 用户可执行的下一步

诊断界面应给出具体动作，例如：

- “发现了 3 个 page target，但没有 target 通过 Cursor renderer 验证；请确认 CDP 端口对应 Cursor，并运行重新探测。”
- “当前连接到 `webview` 子页面；请选择评分更高的 renderer target。”
- “Composer 已找到，但 Mode 菜单触发器未找到；当前只保留上次模式状态，不执行 `set_mode`。”
- “Model 菜单触发器存在但未打开；请在 Cursor 中展开一次模型菜单后重试实时探测。”
- “发现新的 Mode 候选，已生成待确认 adapter；未自动激活。”

错误信息中不应包含密码、token 或完整聊天内容。

---

## 14. Relay、类型和文件实施拆分

### 14.1 第一批：类型和纯函数

新增或修改建议：

- `src/server/types.ts`
  - `DiscoverySummary`、`CapabilitySummary`、`CapabilityStatus`、`MenuCompleteness`、`DiscoveryDiagnostic`。
  - `ToolActionCapability` 只暴露不透明 action id、展示字段和过期时间。
  - 兼容扩展 `ModeInfo`/`ModelInfo`，但明确它们由能力状态投影生成，不是独立状态源。
- `src/server/capability-normalize.ts`
  - label、id、scope 和稳定性归一化。
  - 不访问 CDP，不产生副作用。
- `src/server/selector-validation.ts`
  - CSS 白名单、长度、深度、允许 key 和 schema 校验。
- `src/server/capability-diff.ts`
  - expected/observed/lastKnown 比较和状态分类。

这些模块优先写单元测试，降低后续实时探测改动的风险。

### 14.2 第二批：target 和 probe

新增：

- `src/server/target-discovery.ts`
  - `/json/version` Cursor 身份硬门槛、`/json`、首次候选排序、preferred target 保持和生命周期诊断。
- `src/server/capability-probe.ts`
  - 固定、结构化的 PassiveProbe 与受协调的 InteractiveProbe。
- `src/server/target-ui-coordinator.ts`
  - 按 target id 串行化 InteractiveProbe 和命令；处理 generation、取消、超时和清理。
- `src/server/capability-extractor.ts`
  - Mode/Model/Tool 的语义化提取和菜单完整性判断。

修改：

- `src/server/cdp-bridge.ts`
  - 调用新的 target discovery，排除未验证的 webview target。
  - 保存每个 window 的 probe 摘要，不把 target id 当长期配置。
- `src/discovery/discover-dom.ts`
  - 改为使用与服务端相同的 target 评分和 probe，避免脚本和生产逻辑各自判断。
- `scripts/probe-model-picker.ts`
  - 输出 target 评分、作用域、触发器证据和失败码，不只测试旧 class selector。

### 14.3 第三批：适配器和持久化

新增：

- `src/server/adapter-store.ts`
  - activeBindings、pending/history、原子写入、备份、按 capability 回滚。
- `src/server/adapter-registry.ts`
  - 按 Cursor build、DOM 指纹和 capability kind 合并内置与本机策略。
- `src/server/runtime-validator.ts`
  - selector 和语义候选验证，默认不执行 UI mutation。
- `src/server/capability-circuit-breaker.ts`
  - 按 binding 聚合失败样本，执行 capability 熔断和受控回退。

修改：

- `src/server/config.ts`
  - 增加适配器存储路径、TTL、备份数量、自动发现开关等配置。
- `selectors.json`
  - 继续作为默认基线；只增加经过人工审查的稳定策略，不作为运行时数据库。

### 14.4 第四批：Relay 和前端

修改：

- `src/server/relay.ts`
  - 使用独立受保护 `/api` router 增加能力、发现和适配器 API。
  - 显式执行 API auth、Origin/Host、CSRF/Bearer、body limit、速率限制和 operation 去重。
  - 广播带 target generation/revision 的能力和诊断事件。
- `src/server/capability-state-manager.ts`
  - 作为动态能力唯一所有者，管理 per-target full/patch/stale 和兼容投影事件。
- `src/server/state-manager.ts`
  - 继续只管理聊天/连接状态；不存储或覆盖 capability 内部状态。
- `src/server/index.ts`
  - 通过 EventEmitter 连接 CapabilityStateManager、Relay、TargetDiscovery 和现有模块。
- `src/client/app.js`
  - 动态渲染 Mode、Model、Tool；未知和 stale 状态分开显示。
  - 增加探测、候选确认、应用和回滚界面。
- `src/client/index.html`、`src/client/styles.css`
  - 增加能力状态和诊断区域，保持移动端布局。

### 14.5 第五批：命令安全改造

修改：

- `src/server/action-registry.ts`
  - 生成不透明 action id，保存 target/generation/scope/TTL 绑定、容量限制和一次性消费状态。
- `src/server/command-executor.ts`
  - `setMode`、`setModel` 和通用 action 通过 `TargetUiCoordinator` 执行。
  - ActionRegistry 在执行前解析 action id，客户端 selectorPath 不再构成授权。
  - 执行前重新发现并校验目标，返回目标不存在、目标歧义、菜单未打开、action 过期/已消费和验证失败。
- `src/server/relay.ts`
  - 校验 command/operation id、action id 和 window generation；重复 operation 不重复执行。
- `src/client/app.js`
  - 只发送服务端 action id，不再把 DOM 快照中的 selectorPath 作为长期命令目标。

---

## 15. 测试方案

### 15.1 单元测试

新增测试文件建议：

- `tests/target-discovery.test.ts`
  - Cursor 身份硬门槛、首次排序、webview/about:blank 排除、preferred target 重连、target id 重建、同名 workspace 和无 Composer 窗口。
- `tests/target-ui-coordinator.test.ts`
  - 同 target 串行、不同 target 并行、临时 CDP 连接共享锁、generation 变化取消、超时清理和焦点/菜单恢复。
- `tests/semantic-capabilities.test.ts`
  - Mode/Model/Tool 的 ARIA、data 属性、菜单和文本 fallback；模型虚拟列表、滚动加载、过滤和异步稳定。
- `tests/capability-state-manager.test.ts`
  - per-target revision、旧 patch 丢弃、target 切换 stale、DOM extraction 不覆盖能力和旧字段兼容投影。
- `tests/capability-diff.test.ts`
  - added/removed/stale/unknown/ambiguous/degraded；partial/unknown 不得产生 removed/empty。
- `tests/selector-validation.test.ts`
  - 合法 selector、危险语法、过长 selector、深层组合、非法能力 key。
- `tests/adapter-store.test.ts`
  - schema、原子写入、activeBindings、按 capability 回滚、损坏文件恢复和多指纹隔离。
- `tests/action-registry.test.ts`
  - action id 不可预测、跨窗口重放、过期、已消费、generation/adapter 变化、重复提交和容量清理。
- `tests/command-capability-guard.test.ts`
  - 未验证 action 不可执行、客户端 selector 不授权、歧义目标拒绝、执行前重新校验和 operation 去重。
- `tests/relay-capability-auth.test.ts`
  - API 路由顺序、未认证、错误 Origin、缺少 CSRF、Bearer、body limit、速率限制和合法同源请求。

现有 `tests/model-picker-fallback.test.ts` 和 `tests/state-manager.test.ts` 应保留，并增加新能力字段的向后兼容断言。

### 15.2 Fixture 测试

由于不能依赖每次测试都运行真实 Cursor，建立脱敏 DOM fixture：

- 旧版 Composer 选择器结构。
- 新版语义菜单结构。
- 多个 webview 和多个 renderer target 的 probe 响应。
- 普通 VS Code/未知 Electron endpoint，验证不能进入命令链路。
- 五个或更多 Mode 的菜单。
- 模型标签相同但 scope 不同的全局/计划菜单。
- 虚拟化、可滚动、异步加载、带搜索过滤的 Model 菜单。
- Tool action 的嵌套 Edit/Configure 按钮。
- 隐藏、disabled、重复 label、菜单未打开和 target generation 变化情况。

Fixture 只保留必要标签、属性和短文本，不放真实项目路径、消息、token 或账号信息。

### 15.3 Live probe 合同测试

在明确设置 `LIVE_CURSOR_TEST=1` 且检测到授权 CDP endpoint 时运行：

1. 列出 targets，验证 endpoint 属于 Cursor，并确认至少有一个 target 通过 Workbench 身份 probe。
2. PassiveProbe 读取当前 Composer、Mode 当前值和 Model 当前值，不改变 UI。
3. 只有设置 `LIVE_CURSOR_INTERACTIVE_TEST=1` 且用户明确允许时，InteractiveProbe 才能通过共享 target 锁打开菜单；不得选择模型或执行危险动作。
4. 验证 probe 在成功、超时和异常时都只关闭自己打开的菜单并恢复焦点。
5. 验证发现结果可以序列化为 capability schema，并具有 targetGeneration、revision 和 completeness。
6. 验证失败时不写入活动 binding、不生成可执行 action。

Live test 默认严格 passive；打开菜单属于交互测试，不能称为只读，也不应在 CI 或无明确授权时运行。

### 15.4 Relay 和前端测试

- 未认证请求不能访问 discovery/apply/rollback/action。
- cookie 写请求缺少合法 Origin/CSRF 时失败，合法 Bearer 或同源 CSRF 请求成功。
- 旧客户端连接时仍能收到现有 state 字段，且这些字段来自能力兼容投影。
- 新客户端能接收带 target generation/revision 的 `capabilities:full` 和 patch，并丢弃旧 revision。
- `unknown`、`stale`、`empty`、`partial`、`degraded` UI 文案和按钮状态正确。
- Socket 断线重连后恢复能力 full snapshot，并正确标记时间和 generation。
- 多窗口切换后能力不能串到旧窗口，旧 action 无法重放。
- 重复 operation id 不重复执行 apply、rollback、probe 或 action。

### 15.5 验收指标

建议验收标准：

- 非 Cursor endpoint 进入 `CommandExecutor` 的次数必须为 0；preferred target 在仍有效时不得被评分替换。
- 正确 Cursor renderer target 的首次自动选择率达到 95% 以上；无法确认时必须安全失败。
- 同一 target 的 InteractiveProbe 与命令并发执行次数为 0；异常后菜单/焦点清理合同测试全部通过。
- 已验证 fixture 中 Mode 发现覆盖率达到 100%，不依赖固定四项列表。
- Model 菜单“未打开”和“打开为空”误报率为 0；partial/unknown 产生 removed 的次数为 0。
- 未验证、过期、已消费或跨 generation 的 Tool action 不得执行。
- DOM extraction 不得覆盖 CapabilityStateManager；旧 revision 不得覆盖新 revision。
- 未认证或未通过 Origin/CSRF/Bearer 校验的敏感 API 成功次数为 0。
- 任意 adapter schema、selector 或 probe 失败都不能破坏其他 active binding；单窗口瞬时失败不得触发全局回滚。
- 旧的状态和命令协议测试全部通过。
- 连续失败后的熔断范围、诊断和 binding 回退结果可从认证接口获得。

---

## 16. 灰度发布和回归方案

### 阶段 0：安全基线与只读观测

- 上线 Cursor endpoint 身份硬门槛、preferred target 保持、PassiveProbe、CapabilityStateManager 和诊断日志。
- 未验证 endpoint 不向 `CommandExecutor` 注入 client。
- 只发送旁路 capability full/patch，不改变现有 Mode/Model 命令路径。
- 不运行 InteractiveProbe，不写 adapter binding，不改变 `selectors.json`。
- 对比固定列表和实时观察结果，收集不同 Cursor 版本的脱敏 fixture。

### 阶段 1：受协调的交互发现

- 引入 `TargetUiCoordinator`，先让现有 Mode/Model 命令和 InteractiveProbe 共用 per-target 队列。
- 完整菜单发现只由用户请求、命令执行前或 adapter 验证触发，不在启动时自动点击。
- 新 `CapabilityExtractor` 与旧提取器旁路运行；partial/unknown 菜单只报告新增候选，不报告 removed/empty。
- 新结果只通过认证 debug endpoint 或受控 Socket.IO 事件暴露。
- 统计 target 选择、Mode/Model 解析、菜单完整性、清理结果和 Tool 识别差异。
- 发现冲突时继续使用旧读取行为，但将写命令标记为 degraded 或 unavailable。

### 阶段 2：半自动 adapter binding

- 生成 `pending_confirmation` adapter，并按 Cursor build、DOM 指纹和 capability kind 形成候选 binding。
- 通过 Web 界面展示候选策略、证据、完整性、置信度、风险和验证时间；本批次只展示 pending，不提供激活控件。
- **ADAPTER_APPLY 本批次保持 503。** 用户确认后只激活对应 binding 是后续批次的目标，不能把 pending 写成已生效，也不能全局替换其他 capability 或当前 selector 路径。
- 先只替换读取路径；`set_mode`、`set_model` 和 Tool action 继续要求执行前重新发现和显式 guard。一般 Build 授权不能授予其他 SIDE_EFFECT 动作。
- 引入 capability circuit breaker，验证单窗口瞬时失败不会触发全局回滚。

### 阶段 3：ActionRegistry 与受控命令切换

- 上线服务端 ActionRegistry 和不透明 action id，禁用客户端 selectorPath 授权。
- 只对通过连续回归、运行时验证和 target generation 绑定的 Mode/Model 设置启用新 binding。
- Tool 危险动作逐类开启，验证 TTL、一次性消费、跨窗口重放和 operation 去重。
- 监控按 binding 聚合的失败率；达到最小样本和阈值后只熔断对应 capability，并执行受控回退。

### 阶段 4：稳定化

- 将已验证且跨版本稳定的策略人工合并到默认基线。
- 清理长期未使用的候选和脱敏诊断。
- 保留 adapter history，支持定位升级导致的回归。

### 回归重点

每次 CursorRemote 发布或 Cursor 升级后，至少回归：

1. Cursor endpoint 身份硬门槛、首次 target 发现、preferred target 重连和多窗口选择。
2. Composer 未打开、target generation 变化、隐藏窗口和临时 CDP 连接。
3. PassiveProbe 不修改 UI，InteractiveProbe 与命令串行且异常后完成清理。
4. Mode 当前值、完整列表和切换。
5. Composer Model 当前值、complete/partial 列表、虚拟化菜单和切换。
6. Plan Model 不污染 Composer Model。
7. shell/edit/fetch/plan/questionnaire Tool 的展示、ActionRegistry 和动作路由。
8. action 过期、一次性消费、跨窗口/跨 generation 重放和重复 operation。
9. Relay API 认证、Origin/CSRF/Bearer、状态 revision 和旧客户端兼容。
10. adapter apply 本批次必须稳定 `503 ADAPTER_ACTIVATION_UNAVAILABLE`；同时回归 capability 熔断、局部回退和损坏文件恢复。不得把 apply HTTP 200 或 pending→active 当作通过。

---

## 17. 推荐实施顺序和优先级

### P0：建立安全身份、状态和执行边界

1. Cursor endpoint 身份硬门槛、renderer PassiveProbe 和 preferred target 语义。
2. 独立 `CapabilityStateManager`，实现 per-target generation/revision 和旧字段兼容投影。
3. `TargetUiCoordinator`，让 InteractiveProbe 与现有命令按 target 串行。
4. 独立受保护 `/api` router，明确 auth、Origin/Host、CSRF/Bearer、body limit、速率和 operation 去重。
5. 建立统一诊断码和 `/api/discovery/status`。

**P0 检查点**：非 Cursor endpoint 无法进入命令链路；DOM extraction 不覆盖 capability；同一 target 不发生并发 UI mutation；未认证写 API 全部失败。

### P1：动态读取 Mode/Model 并证明菜单完整性

1. Mode 菜单语义化读取。
2. Model 菜单按 Composer/Plan 作用域读取。
3. 引入 `complete/partial/unknown`；partial/unknown 不产生 removed/empty。
4. 当前值、列表、来源、置信度、generation 和 revision 同步到前端。
5. 前端去除固定模式列表依赖。

**P1 检查点**：现场 Cursor 的 Mode/Model 差异可解释；旧 selector 失效显示 degraded，而不是空列表；交互 probe 能恢复菜单和焦点。

### P2：Adapter binding、持久化与局部回退

1. selector 安全校验。
2. AdapterStore 原子写入、备份和 activeBindings。
3. 按 Cursor build、DOM 指纹和 capability kind 选择 adapter。
4. 差异检测、待确认候选和 capability circuit breaker。
5. `/api/capabilities`、`/api/capabilities/diff` 和 Socket.IO revision 事件。

**P2 检查点**：一个窗口或一个 capability 的失败不会回滚其他 binding；损坏配置可恢复；旧 revision 不覆盖新状态。

### P3：ActionRegistry 和命令授权迁移

1. Tool type/action 统一模型和服务端 ActionRegistry。
2. action id 绑定 window/target/generation/Composer/tool call/adapter/TTL。
3. capability/action id 替代客户端 selectorPath 授权。
4. 危险动作执行前重新验证、一次性消费并逐类灰度。

**P3 检查点**：过期、已消费、跨窗口和跨 generation action 全部拒绝；重复 operation 不产生重复副作用。

---

## 18. 最终建议

当前问题的根因不是单个 CSS selector 失效，而是系统把三个不同问题混在了一起：

1. “是否连接到了正确的 Cursor renderer target”；
2. “当前 DOM 中是否存在某项能力”；
3. “能否安全地对这项能力执行命令”。

推荐按以下原则实施：

- 先验证 endpoint 属于 Cursor，再验证 Workbench target；target 评分只用于首次无 preferred target 的排序。
- 保留用户 preferred target，Composer 是否打开只影响能力 readiness，不影响窗口合法性。
- PassiveProbe 不修改 UI；需要打开菜单的 InteractiveProbe 与命令共享 per-target 协调队列。
- 用语义化 DOM 和可验证菜单读取能力，再使用版本化 selector fallback。
- 用 `unknown`、`stale`、`empty`、`partial`、`degraded` 区分失败原因，不能用空列表代替所有失败。
- 只有 complete、未过滤的菜单快照可以产生 removed 或 empty。
- `CapabilityStateManager` 是动态能力唯一状态源；现有 `mode`/`model` 只是兼容投影。
- 把工具实例、能力目录和可执行动作分开建模；客户端只获得绑定 generation/TTL 的不透明 action id。
- 将运行时发现结果保存为按 build/fingerprint/capability 绑定的待确认 adapter，而不是直接覆盖 `selectors.json`。
- 每次 binding 应用都经过 schema、唯一性、语义和运行时校验，并保留备份、局部熔断和按 capability 回退。
- Relay 使用独立受保护 API router；服务端是唯一执行授权边界。
- 先建立身份、状态与互斥边界，再旁路解析、半自动 binding，最后迁移危险命令。

在完成 P0 和 P1 之前，不开启自动写配置或自动切换生产命令路径。当前现场已经确认有效 workbench target 和 `[data-mode]` 信号存在，而旧 Model 触发器为 0 命中；因此第一条功能修复链路应是“安全身份门槛与状态边界 → Model/Mode PassiveProbe → 受协调的菜单发现”，不是继续假设 Composer 位于 webview。

---

## 19. 当前落地状态与下一步

截至当前代码复核，P0/P1 的核心安全边界已经接入生产组合根：Cursor endpoint 身份硬门槛、有效 page/workbench target 过滤、preferred target 保持、per-target generation/revision、`CapabilityStateManager`、`TargetUiCoordinator`、只读 `PassiveProbe`、显式用户触发的 `InteractiveProbe`、统一 `capabilities:full/patch` 协议、兼容 Mode/Model 投影和前端失效状态禁用均已实现。启动和定时任务只执行 PassiveProbe；InteractiveProbe 只能由用户点击“Refresh Cursor capabilities”后进入共享 target 队列，不会在启动时自动打开菜单。

P3 的主要执行授权边界也已落地：Web 与 Telegram 的审批、问卷、Tool/Plan action 使用服务端 `ActionRegistry`，绑定 target、generation、作用域、label、TTL 和一次性消费；Mode/Model 命令在 `CommandExecutor` 统一经过动态 capability allowlist，并且不再把客户端 id 拼接为 CSS selector。超时后的已派发一次性动作不会自动重试，跨 generation、已消费或未验证能力会安全拒绝。

P2 目前只完成安全的旁路与存储部分：`AdapterStore`、schema/selector 校验、pending confirmation、原子持久化、备份恢复、隔离 rollback 和基础 circuit breaker 已实现；自动发现只保存 pending adapter，根 `selectors.json` 不会被修改。Mode 候选保持 `pending_confirmation`，当前 selector 路径（builtin / 根 `selectors.json`）仍是活动命令路径。由于生产命令尚未接入按真实 Cursor build 和 DOM fingerprint 选择的 `AdapterRegistry`，`POST /api/adapters/:id/apply` 本批次稳定返回 `503 ADAPTER_ACTIVATION_UNAVAILABLE`（授权级别 `ADAPTER_APPLY`，见第 21 节），不得把 pending adapter 误报为已生效，也不得把“激活可用”写成当前产品行为。Web 只展示 pending 和诊断，不提供虚假的激活按钮。

HTTP 层已经具备认证、Host/Origin 检查、cookie CSRF/Bearer 分支、64 KB body limit、敏感路由独立速率限制和并发安全的强制 `X-Operation-Id` 去重；显式能力刷新会发送 CSRF/Bearer 与 operation id。cookie 写请求要求同源 Origin 和 timing-safe CSRF 比较，Bearer CLI 可以在不带 Origin 时调用，但显式外域 Origin 仍会被拒绝。

当前自动 live 状态仍可能是 `degraded/unknown`：PassiveProbe 只能证明当前值，不能证明虚拟化菜单完整性。只有未过滤菜单满足无溢出或 `aria-setsize` 与实际条目一致时，InteractiveProbe 才能标记 `complete`；unknown/partial 快照不会缩减已有 complete inventory，也不会产生 removed/empty。最近一次复核没有执行显式刷新、Mode/Model 切换、真实 Tool 副作用或 adapter 激活，因此不能据此宣称 P1–P3 已完成 SIDE_EFFECT live 验收，也不得宣称真实 Tool 副作用已通过。Telegram Mode/Model/Action/Tool E2E 标记为 deferred。

下一步按以下可独立验收项推进：

1. 在明确允许打开并关闭 Cursor 菜单后，执行显式 InteractiveProbe，验证真实 Mode/Model 完整性、菜单清理和焦点恢复。
2. 在明确允许状态变更后，验证真实 Mode/Model 切换、切换后回读、target replacement、generation 变化和断线取消。
3. 使用真实 Cursor build 与结构化 DOM fingerprint 接入 `AdapterRegistry`；完成 pending → validate → confirm → activate → backup → rollback 后再解除 apply 的 `503` 保护。
4. 完成 ActionRegistry TTL、重放、scope mismatch 和并发取消的 live 安全测试，并继续验证 HTTP operation replay 与速率限制的真实错误语义。
5. 区分 Tool 的 DOM 展示实例、能力目录和真实可执行动作；当前 `executable:false` 的观测不得被宣称为 Tool 执行能力。

---

## 20. 修订验收清单

当前实现与复核状态：

- [x] Cursor endpoint 身份失败时，CDP client 不会进入 `CommandExecutor`。
- [x] preferred target 在仍有效时不会被评分结果替换。
- [x] PassiveProbe 不产生点击、焦点或菜单状态变化。
- [x] InteractiveProbe 和所有命令通过同一个 per-target 协调队列，超时任务结束前不会释放 lane。
- [x] CapabilityStateManager 是动态能力的唯一状态源，DOM extraction 不会覆盖它。
- [x] Model snapshot 不能证明 complete 时，不产生 empty 或 removed，也不缩减既有 complete inventory。
- [x] HTTP 写 API 对敏感路由强制执行认证、Origin/Host、CSRF/Bearer、独立限流和 operation 去重。
- [x] 客户端 selectorPath 不构成动作授权，危险动作只接受有效 ActionRegistry id。（证据层：`code_implemented` + `isolated_test`；**不是** `side_effect_live`）
- [x] action 绑定 target generation 和作用域，并具有 TTL、一次性消费及容量上限。（同上；真实 Tool 点击 live 未宣称通过）
- [x] `POST /api/adapters/:id/apply` 本批次稳定 `503 ADAPTER_ACTIVATION_UNAVAILABLE`；pending Mode 候选不替换当前 selector 路径。
- [ ] adapter 使用真实 build、结构化 DOM fingerprint 和 capability kind 接入生产选择；ADAPTER_APPLY 在解除 503 之前保持 fail-closed。
- [ ] P0、P1、P2、P3 的 SIDE_EFFECT live 检查点全部通过；当前只完成代码、isolated tests 和 PASSIVE live 观测。Telegram Mode/Model/Action/Tool E2E 为 deferred。

任一项未满足时，只允许继续只读诊断或旁路观测，不启用对应的生产写路径。验收字段、授权级别和分层证据见第 21 节。

---

## 21. 本批次验收：授权级别、证据字段与分层判定

本节是本批次的验收合同。设计目标（半自动 apply、完整菜单 live、Tool 真点击）不等于已经通过。任何报告必须同时给出 **授权级别** 和 **证据层**；缺少任一层不得把结果写成 PASS。

### 21.1 授权级别

四个级别互相独立，上级不蕴含下级。客户端、CI、操作员或“本轮 Build 已批准”都不能隐式升级授权。

| 级别 | 允许做什么 | 明确禁止 | 本批次授权状态 |
| --- | --- | --- | --- |
| `PASSIVE` | 只读 `Runtime.evaluate`、HTTP GET、Socket 收 `state:*` / `capabilities:*`、双 target 身份与当前值报告 | 点击、改焦点、开菜单、发写命令、改 adapter binding | 默认允许；启动和周期探测只能走这一级 |
| `INTERACTIVE` | 在 `TargetUiCoordinator` 内打开并关闭自己打开的 Mode/Model 菜单，证明 completeness 后清理焦点 | 选择 Mode/Model、点击 Tool/Plan/审批、写 adapter | 仅显式 “Refresh Cursor capabilities”；不由 PASSIVE 或启动任务授予 |
| `SIDE_EFFECT` | 执行单个已注册动作：`set_mode` / `set_model` / `approve` / `reject` / `run` / `skip` / `allow` / `build` / `continue` / 问卷选项等 | 把一次授权复用到其他 `actionType`、其他 `actionId`、其他 window/target/generation | **按动作显式批准**。一般 Build、计划 Build 按钮、或“允许测试”不等于授予 Run/Approve/Allow/Skip/Mode/Model |
| `ADAPTER_APPLY` | 把 `pending_confirmation` adapter 写入 `activeBindings` 并切换生产 selector 路径 | 任何激活、热切换生产 Mode/Model/Tool 选择器、把 pending 报告为 active | **本批次禁用。** 稳定 `503 ADAPTER_ACTIVATION_UNAVAILABLE` |

约束：

1. `SIDE_EFFECT` 必须针对**这一次** `actionId` + `actionType` + `targetGeneration` 显式批准；成功后一次性消费。失败重试不得自动升级为其他动作。
2. Plan widget 的 `build` 只授权 Build 本身。它不授予 shell `run`/`allow`、全局审批、问卷 Continue、Mode/Model 切换或 adapter apply。
3. `ADAPTER_APPLY` 不被任何 SIDE_EFFECT、InteractiveProbe 或 `confirmed: true` 请求体授予。本批次 Mode 候选保持 `pending_confirmation`，当前 selector 路径保持活动。
4. 缺少有效 `actionId` 时，`selectorPath` 不是授权。未知 `actionType` 保持 `executable: false`。

### 21.2 证据层（不得混报）

| `evidenceLayer` | 含义 | 可以证明 | 不能证明 |
| --- | --- | --- | --- |
| `code_implemented` | 组合根已接线，生产路径存在 | 模块存在、路由/事件已注册、fail-closed 分支存在 | 行为正确、live Cursor 可用 |
| `isolated_test` | 无真实 Cursor 的单元/fixture/HTTP 测试 | 协议、鉴权、状态矩阵、ActionRegistry 负向/正向路径 | 现场 DOM、真实点击副作用 |
| `passive_live` | 已授权 CDP endpoint 上的只读探测 | 双 workbench 身份、当前 Mode/Model 文本、Composer 是否打开 | 菜单完整性、Mode/Model 切换、Tool 真点击 |
| `side_effect_live` | 对真实 Cursor 执行了会改变状态的点击/输入 | 该 `actionId` 的那一次副作用 | 未执行的其他动作；也**不得**用来宣称 Tool 套件已通过 |

判定规则：

- 代码已实现 ≠ 测试已通过 ≠ PASSIVE live ≠ SIDE_EFFECT live。
- 本批次 **不宣称** 真实 Tool `side_effect_live` 通过。
- Telegram Mode / Model / Action / Tool E2E = `deferred`（isolated tests 可以 PASS，live E2E 不可以）。
- `ADAPTER_APPLY` 的本批次通过标准是 **拒绝激活**（503），不是成功写入 binding。

### 21.3 机器可读验收证据

每条用例输出一条 JSON 对象（可写入报告文件或 CI artifact）。字段名固定，值为 JSON 标量或标量数组。

```ts
interface AcceptanceEvidenceRecord {
  schemaVersion: 1;
  caseId: string;                 // 例如 "web.state.matrix.stale-caps"
  authorizationLevel: 'PASSIVE' | 'INTERACTIVE' | 'SIDE_EFFECT' | 'ADAPTER_APPLY';
  evidenceLayer: 'code_implemented' | 'isolated_test' | 'passive_live' | 'side_effect_live';
  result: 'pass' | 'fail' | 'deferred' | 'blocked';
  observedAt: number;             // epoch ms
  cursorBuild?: string;           // 来自 /json/version User-Agent，可空
  targetCount?: number;
  targetIdHashes?: string[];      // 短 hash，不是原始 targetId / ws URL
  targetGeneration?: number;
  revision?: number;
  httpStatus?: number;
  errorCode?: string;             // 例如 ADAPTER_ACTIVATION_UNAVAILABLE
  operationIdPresent?: boolean;   // 只记录是否提供，不记录 id 原文
  commandIdPresent?: boolean;
  actionType?: string;
  actionConsumed?: boolean;
  capabilityState?: 'ok' | 'changed' | 'degraded' | 'unknown' | 'stale' | 'unavailable' | 'awaiting';
  completeness?: 'complete' | 'partial' | 'unknown';
  adapterStatus?: 'pending_confirmation' | 'active' | 'rejected' | 'rejected_runtime' | 'none';
  selectorPathActive?: 'builtin' | 'selectors_json' | 'pending_unused';
  notes?: string;                 // 已按 21.4 脱敏的短文本
}
```

`result` 语义：

- `pass`：该 `caseId` 在声明的 `authorizationLevel` + `evidenceLayer` 下满足断言。
- `fail`：同层断言失败。
- `deferred`：本批次明确不做（Telegram Mode/Model/Action/Tool E2E；真实 Tool SIDE_EFFECT live）。
- `blocked`：缺授权、缺 CDP、或 ADAPTER_APPLY 按设计不可用。

禁止字段（出现即报告无效）：原始密码、token、cookie、Authorization、session、`webSocketDebuggerUrl`、完整聊天正文、完整 DOM/HTML、未截断本地路径、可执行 `selectorPath`、未哈希的 action id。

### 21.4 脱敏规则

证据、诊断、日志和验收报告使用同一套规则：

| 类别 | 规则 |
| --- | --- |
| 密钥 | key 匹配 `password\|secret\|token\|bearer\|cookie\|authorization\|session\|credentials` → 掩码（仅保留首尾最多 4 字符） |
| 聊天/代码 | `content` / `text` / `code` / 消息正文 → `` `<N chars>` `` |
| URL | `ws(s)://` → `[ws]`；`http(s)://` → `[url]` |
| 路径 | `/Users|/home|/root` 与 Windows 盘符路径 → `[path]` |
| Target | 公开报告只用短 hash；不写可重连的 WebSocket URL |
| Selector | 公开状态不把 `selectorPath` 当授权字段；证据里最多保留 strategy id |
| Adapter | 只写 `adapterId`、`status`、`capabilityKinds`、指纹 hash；不写完整策略脚本（系统也不允许任意脚本） |

`/health` 未认证响应继续只返回最小字段。`/api/discovery/status` 必须已经过 `redactDiscoveryText`。debug 日志级别也不得打印认证秘密。

### 21.5 本批次用例与当前判定

下列 `caseId` 是本批次验收清单。`result` 列是文档基线，不是把未跑的 live 写成 pass。

#### A. Web 连接 / 能力状态矩阵（`isolated_test`，默认 `PASSIVE` 观察）

对应 `tests/web-client.test.ts` 的 `web: connection/capability state matrix`。Mode/Model 药丸可点属于 UI 使能，不等于已做 SIDE_EFFECT live。

| caseId | 断言 |
| --- | --- |
| `web.state.matrix.reconnect-await-full` | Socket 重连后药丸保持锁定，直到 `capabilities:full`；`capabilities:patch` 不能解除 `awaiting-full` |
| `web.state.matrix.cdp-vs-pills` | CDP 断开独立于能力药丸；不改写 capability mutation |
| `web.state.matrix.extractor-stale` | extractor `stale`/`waiting` 不与 capability 状态混层；连接点 `data-layer` 可区分 |
| `web.state.matrix.caps-stale-green` | 能力 stale 时连接圆点仍可绿；药丸 `pill-stale` 且 disabled，保留 last-known 标签 |
| `web.state.matrix.generation-lock` | targetGeneration 上升时关 sheet、锁药丸、保留标签 |
| `web.state.matrix.unavailable-vs-degraded` | `unavailable` 与 `degraded` CSS/属性可区分 |
| `web.state.matrix.ok-partial-model` | `ok` + Model `partial`：Mode 可写、Model 锁定，不伪造选项 |
| `web.state.matrix.full-recovery` | stale/unknown 之后完整 `capabilities:full` 解锁 Mode+Model |
| `web.state.matrix.css-tokens` | `unknown` / `stale` / `degraded` / `unavailable` / `partial` 有可区分样式 |
| `web.adapter.pending-no-apply` | 展示 pending adapter，DOM 无 `[data-adapter-apply]` |

#### B. HTTP / Socket 鉴权（`isolated_test`，写接口仍不是 ADAPTER_APPLY 成功）

| caseId | 断言 |
| --- | --- |
| `http.auth.unauthenticated` | 设密后未认证 GET `/api/capabilities`、`/api/discovery/status` 失败；`/health` 不泄露窗口/agent 细节 |
| `http.auth.foreign-origin` | 外域 Origin 拒绝 login 与 cookie 写；Socket.IO 外域握手失败，同源成功 |
| `http.auth.csrf-cookie` | cookie 写缺 CSRF → 失败；同源 + CSRF 可进入处理；cookie 写缺 Origin → 失败 |
| `http.auth.bearer-cli` | Bearer 可不带 Origin/CSRF；Bearer + 显式外域 Origin 仍拒绝 |
| `http.auth.operation-id` | 敏感 POST 缺 `X-Operation-Id` 或非法 id → 400，且不执行 runner；同 id 同 fingerprint 只跑一次；同 id 不同 body → 409 |
| `http.auth.rate-limit` | 敏感探测超过 `SENSITIVE_PROBE_RATE_MAX` → 429 + `Retry-After` |
| `http.auth.body` | 非法 JSON → 400 `Invalid JSON`；超过 `API_JSON_LIMIT_BYTES` → 413 `Payload too large` |
| `socket.auth.origin` | 外域 Origin 不能建立命令通道 |
| `socket.auth.operation-id` | 危险 socket 命令要求 bounded `operationId`；同 session/route 重放一次，fingerprint 冲突 409；超限 429 |
| `socket.auth.body` | 超过 Socket.IO `maxHttpBufferSize` 被拒绝 |
| `http.adapter.apply-503` | `confirmed: true` 且字段齐全时 `POST /api/adapters/:id/apply` **仍然** `503 ADAPTER_ACTIVATION_UNAVAILABLE`；pending 状态与 `activeBindings` 不变；builtin selector 仍活动。缺确认 → 400，不把 400 误当成“激活已开放” |

#### C. 双 target PASSIVE 报告（`passive_live` 或等价 isolated fixture）

| caseId | 断言 |
| --- | --- |
| `live.passive.two-targets.identity` | `/json/version` 证明 Cursor；`/json` 上两个 `page/workbench` 均通过身份 probe |
| `live.passive.two-targets.isolated` | 每 target 独立 `targetId` hash、`targetGeneration`、workspaceKey（已脱敏）、Composer readiness；快照不串窗 |
| `live.passive.two-targets.no-webview` | `webview` / `about:blank` 不进入窗口列表，也不注入 `CommandExecutor` |
| `live.passive.two-targets.preferred` | preferred target 仍有效时不被评分替换 |
| `live.passive.two-targets.no-mutation` | PassiveProbe 无点击、无焦点、无菜单；证据含 `authorizationLevel: PASSIVE` |
| `live.passive.two-targets.current-only` | 可报告 Mode/Model **当前值**；不得把未打开菜单写成 `complete` / `empty` / `removed` |

#### D. ActionRegistry 负向 / 正向（`isolated_test`；正向不是 live Tool 副作用）

| caseId | 路径 | 断言 |
| --- | --- | --- |
| `action.neg.missing-id` | 负向 | 无 `actionId` 或非法 `actionType` 的 `click_action` 不调用执行器 |
| `action.neg.selector-not-auth` | 负向 | 客户端 `selectorPath` 不能授权 |
| `action.neg.expired` | 负向 | TTL 过期 → `action_expired` |
| `action.neg.consumed` | 负向 | 一次性消费后再次 consume/reserve 失败 |
| `action.neg.scope` | 负向 | 错误 `actionType` / composer / generation / window → `action_scope_changed` 或 `action_not_found` |
| `action.neg.cross-target` | 负向 | invalidate target/generation/adapter 不影响无关 action |
| `action.neg.unknown-kind` | 负向 | 未知 kind `executable: false`，不折叠已知类型 |
| `action.happy.reserve-consume` | 正向 | 匹配 type+generation 可 reserve，consume 后 `consumed: true` |
| `action.happy.distinct-types` | 正向 | `approve` / `approve_all` / `allow` / `run` / `build` / `continue` / `questionnaire_option` 各有独立 id；Build 不能当 Run |
| `action.happy.bound-reserved` | 正向 | 达容量上限时不驱逐已 reserve 的 action |
| `action.happy.socket-forward` | 正向 | 合法 `actionId` + `actionType` + `operationId` 转发执行器一次 |

以上正向路径证明的是注册表与入站协议，**不是**真实 Cursor Tool 已点击成功。

#### E. 明确 deferred

| caseId | 说明 |
| --- | --- |
| `telegram.e2e.mode` | Telegram `/mode` 与内联 Mode 切换 live E2E |
| `telegram.e2e.model` | Telegram `/model` 与内联 Model 切换 live E2E |
| `telegram.e2e.action` | Telegram 审批/问卷/Build 内联按钮 live E2E |
| `telegram.e2e.tool` | Telegram Run/Skip/Allow 等 Tool 真副作用 live E2E |
| `web.live.tool.side-effect` | Web 对真实 Tool 卡片执行 Run/Approve/Allow 等 |

`tests/telegram-capability-guard.test.ts` 等 isolated tests 可以是 `isolated_test` PASS，但不能把这些 `caseId` 标为 `side_effect_live` pass。

### 21.6 本批次结论摘要

| 主题 | 结论 |
| --- | --- |
| Mode 候选 | 只允许 `pending_confirmation`；当前 selector 路径保持活动 |
| Adapter apply | 禁用；稳定 503 `ADAPTER_ACTIVATION_UNAVAILABLE` |
| Tool | 代码与 isolated tests 覆盖 ActionRegistry；**不宣称**真实 Tool 副作用通过 |
| Telegram Mode/Model/Action/Tool | E2E **deferred** |
| 可宣称通过的最高 live 层 | `passive_live`（双 target 只读报告）；INTERACTIVE/SIDE_EFFECT live 需另开显式批准批次 |

本轮实现核对（不是 SIDE_EFFECT live）：

- Isolated tests：`npm test` 475 pass / 0 fail；`npm run build` 通过。
- Isolated Relay（`127.0.0.1:3101`，故意指向无效 CDP `127.0.0.1:1`）：未认证 401 JSON、外域 Origin 403、缺 CSRF 403、畸形 JSON 400 `Invalid JSON`、超限 body 413 `Payload too large` JSON、Bearer 可读、非法 Bearer 401、缺/短 `X-Operation-Id` 400、login 429 + `Retry-After`、discovery/run 在无 Cursor 时 409 `No verified Cursor target`（无真实 CDP 写）。
- 同 operation-id 不同 body 的 409 由 `tests/relay-auth.test.ts` 覆盖；隔离 live 复测会与 login/probe 限流叠加，不能当成失败。
- 生产 `127.0.0.1:3000` 若仍是旧进程，超限 login 可能仍返回 HTML 413；以本仓库 `dist/` + isolated tests 为准。
- Passive live：Cursor/3.17.21 两个独立 workbench target 各一份脱敏报告；Model completeness 为 `unknown`；Tool `executable: false`。