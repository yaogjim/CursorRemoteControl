# CursorRemote：Cursor 能力自动发现、差异检测与适配方案

## 1. 文档目的

本文记录 CursorRemote 当前与 Cursor IDE 的连接和能力同步现状，并提出一套可实施的“发现 → 校验 → 差异检测 → 半自动适配 → 回滚”的方案。

本文解决的问题是：

- Cursor 实际可用的 Mode（工作模式）、Model（模型）和 Tool（工具及其可操作动作）与 `http://127.0.0.1:3000/` 展示的不一致。
- Cursor 升级后 DOM（文档对象模型）结构、选择器、ARIA 语义属性或 CDP target（Chrome DevTools Protocol 调试目标）发生变化时，系统无法自动判断是“没有能力”还是“提取失败”。
- 现场发现的可用信息无法安全地沉淀到 `selectors.json`，也没有版本化、校验和回滚流程。

本文是设计和实施方案，不代表功能已经实现。当前结论以本次现场检查和仓库当前代码为准；Cursor DOM 属于易变的内部界面，任何新增解析规则都必须先通过 live probe（实时探测）确认。

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
| CDP target | 从 `/json` 选择页面，主要过滤 URL 中包含 `workbench` 的 target | 发现结果主要出现 `webview about:blank`，未得到有效 Composer 页面 | 需要提高 target 识别和运行时验证，不能只依赖 URL/title |
| Mode | `src/server/dom-extractor.ts` 返回固定的 4 个模式 | Cursor 现场显示 5 个模式，至少包括 Agent、Plan、Debug | 网页模式列表不会自动跟随 Cursor |
| Model | 依赖 `selectors.json` 的固定触发器，并通过打开菜单读取选项 | 当前 DOM 与旧选择器结构不完全一致，模型菜单可能读取失败 | 需要先确定当前 renderer target，再增加语义化菜单发现 |
| Tool | 已能针对部分消息和工具调用读取 `data-*` 属性及动作按钮 | 没有统一的 Tool 能力目录和发现状态 | 需要将工具类型、动作、可执行性、来源纳入能力快照 |
| 配置更新 | `selectors.json` 可被加载 | 未发现探测结果自动写回、校验或回滚流程 | 不能直接将现场 DOM 结果覆盖配置 |
| 前端同步 | `src/client/app.js` 渲染服务端的 `mode.available` 和模型数据 | 前端仍有固定模式标签映射 | 服务端动态能力与前端固定展示逻辑可能再次产生差异 |

### 2.3 推荐的产品决策

推荐将“自动适配”设计为**半自动确认**，而不是无条件覆盖配置：

- 自动发现和生成候选适配方案可以无人值守运行。
- 自动校验只能使用安全、只读的实时探测和受限的动作验证。
- 只有候选方案通过结构校验、语义校验、目标唯一性校验和回归检查后，才进入“待确认”。
- 生产配置由用户明确确认后激活；紧急情况下允许管理员执行显式 `apply`。
- 每次激活保留备份、版本号、来源和验证结果，可一键回滚。

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

### 3.5 当前 CDP target 发现的问题

`CDPBridge` 会从 CDP `/json` 获取 targets，并把 URL 中含有 `workbench` 的 page target 转换为 Cursor 窗口。独立的 `src/discovery/discover-dom.ts` 也会优先选择 URL 中含 `workbench` 的 page，再退回任意 page。

现场执行 `npx tsx src/discovery/discover-dom.ts` 可以连接 `http://127.0.0.1:9222`，但发现的目标主要是 `webview about:blank`，未得到有效 Composer DOM。这说明问题可能出在以下任一层：

1. Cursor 当前暴露的页面 target URL/title 结构发生变化。
2. 选择的是 webview 子页面，而不是包含 Workbench/Composer 的顶层 renderer。
3. CDP 端口对应的不是预期 Cursor 实例，或有多个 Electron 页面竞争。
4. Composer 页面是延迟加载、隐藏或嵌入在另一层 DOM 中。
5. 当前模式和模型入口的 class 名称发生变化。

解决方式不能是继续堆叠 CSS 选择器，而应先为每个 target 建立运行时身份和可用性评分。

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
                     ┌─────────────────────────┐
                     │ Capability Discovery     │
                     │ target / semantic probe  │
                     │ fingerprint / diff      │
                     └────────────┬────────────┘
                                  │ candidates + evidence
                                  ▼
┌────────────┐    ┌─────────────────────────┐    ┌──────────────────┐
│ CDPBridge  │───►│ Adapter Registry        │───►│ Runtime Validator │
│ target     │    │ selectors + strategies  │    │ read-only/actions │
│ discovery  │    └────────────┬────────────┘    └────────┬─────────┘
└────────────┘                 │                          │
                               ▼                          ▼
                     ┌─────────────────┐        ┌────────────────────┐
                     │ Adapter Store   │        │ Difference Engine   │
                     │ active/pending  │        │ expected/observed  │
                     │ backup/rollback │        │ confidence/status   │
                     └────────┬────────┘        └──────────┬─────────┘
                              └──────────────┬─────────────┘
                                             ▼
                                  StateManager / Relay
                                             ▼
                                  Web client / Telegram
```

### 5.1 组件职责

#### `TargetDiscovery`

负责请求 CDP targets、运行轻量身份探测、计算候选分数并返回目标候选。它不负责解析聊天内容，也不负责执行用户命令。

#### `SemanticProbe`

在指定 target 的页面上下文中执行只读探测，收集 DOM 语义摘要、可见性、ARIA 属性、稳定 `data-*` 属性、按钮/菜单/输入框特征和页面指纹。它不返回完整 DOM，也不执行页面提供的脚本字符串。

#### `CapabilityExtractor`

将探测摘要转换为 Mode、Model、Tool 的候选能力。每个候选带有 `source`、`confidence`、`evidence` 和 `scope`。

#### `AdapterRegistry`

管理不同 Cursor 版本族或页面结构族的适配策略。策略包含受限 selector、语义提取器名称、验证规则和优先级，不包含任意 JavaScript。

#### `RuntimeValidator`

在激活候选前进行验证。读取类能力优先只读验证；可执行动作只允许在明确的测试上下文、用户确认或安全的现有命令流程中验证。

#### `AdapterStore`

管理活动配置、待确认候选、历史备份、版本和回滚。它可以将已批准的有限 selector 写入独立适配文件，避免直接修改源代码或无条件覆盖根目录 `selectors.json`。

#### `DifferenceEngine`

比较期望能力、当前活动适配器的结果和实时观察结果，生成结构化差异，并决定是否属于能力变化、页面暂不可见、适配器失效或探测不完整。

---

## 6. Cursor CDP target 自动发现

### 6.1 两阶段发现

#### 阶段 A：HTTP target 枚举

按以下顺序请求并记录诊断：

1. `${CDP_URL}/json/version`：记录 Browser、Protocol-Version 和 WebSocket 调试地址，作为 CDP 环境信息。
2. `${CDP_URL}/json/list` 或兼容的 `/json`：取得 target id、type、title、url、webSocketDebuggerUrl。
3. 对每个存在 `webSocketDebuggerUrl` 的 page target 建立短连接，设置严格超时。

如果 endpoint 不支持 `/json/version`，不应直接失败；记录 `version_endpoint_unavailable`，继续使用 `/json`，但降低环境置信度。

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

- 最高分 target 作为主候选，但必须达到最低阈值，例如 60。
- 多个高分 target 保留为窗口候选，不自动把它们合并成一个页面。
- 若无 target 达到阈值，状态为 `target_unverified`，而不是连接到第一个 page。
- 用户可以在诊断页面显式选择 target id；选择后仍需重新运行身份 probe。

分值只是实现建议，所有分数和命中信号必须出现在诊断结果中，便于解释“为什么选中这个 target”。

### 6.3 多窗口和 target 生命周期

现有 `CDPBridge` 已支持多个 Cursor 窗口和主连接/临时连接的概念。能力发现应沿用该模型：

- target id 是连接路由标识，不是持久能力标识。
- Cursor 重启或窗口重建后 target id 可能变化，应重新发现并通过页面指纹、workspace URI 和窗口标题关联。
- 每个窗口单独保存 target probe 和 capability snapshot。
- 主窗口持续轮询；非主窗口按照现有 `WindowMonitor` 的周期进行短连接探测。
- 目标从 `/json` 消失后，标记为 `disconnected`，保留最近快照供诊断，但不继续执行命令。
- 不应把 `webview about:blank` 当成独立 Cursor 窗口展示给前端。

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
3. 在只读探测或用户请求时打开模式菜单。
4. 从当前打开且可见的菜单读取顶层选项：
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
4. 打开菜单后，只在关联菜单中读取可见顶层模型行。
5. 排除 Edit、Configure、Remove、Delete、Star 等动作按钮和嵌套按钮。
6. 记录模型行的显示标签、稳定 id、选中状态、是否有副标题/套餐标记。
7. 生成稳定的展示 id：
   - 首选经验证的稳定业务 id。
   - React `useId` 形式的 id 不持久化。
   - 没有稳定 id 时使用规范化标签，并记录 `idStability: 'label'`。
8. 关闭菜单并确认选择前后的作用域保持一致。

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
```

模型菜单失败时需要明确返回：

- `trigger_not_found`：没有找到可验证的触发器。
- `menu_not_opened`：触发器存在，但菜单没有打开。
- `menu_scope_ambiguous`：发现多个可能菜单，无法安全判断。
- `menu_open_empty`：菜单已打开且可见，但确实没有模型行。
- `model_parse_partial`：菜单可读，但部分行缺少稳定字段。

只有 `menu_open_empty` 才可以在当前作用域报告“模型列表为空”；其他情况应是 `unknown` 或 `stale`。

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
  type: 'approve' | 'reject' | 'run' | 'skip' | 'allow' | 'view' | 'build' | 'continue';
  label: string;
  executable: boolean;
  requiresConfirmation: boolean;
  targetEvidence: {
    scopeSignature: string;
    selectorStrategyId: string;
    uniqueMatch: boolean;
  };
}
```

Tool 发现只报告“当前页面存在且可验证的动作”。它不应扫描任意按钮后将按钮文本直接上报为可执行动作。动作候选必须满足：

- 位于已识别的工具实例作用域内。
- 是 button 或已验证的 button-like 元素。
- label 与已登记动作语义匹配。
- 目标唯一且可见。
- 不在 disabled、hidden、aria-disabled 状态。
- 可以在执行前再次解析和确认。

未知工具可以展示为 `generic_tool`，但默认 `executable: false`，直到增加专门解析器并完成验证。

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
  "activeAdapterId": "builtin-default",
  "adapters": [
    {
      "id": "candidate-2025-01-01-abc123",
      "status": "pending_confirmation",
      "cursorVersionRange": "unknown",
      "domSignature": "allowed-hash",
      "strategies": {
        "modeTrigger": [
          {
            "id": "mode-trigger-aria-menu",
            "kind": "aria_role",
            "selector": "button[aria-haspopup='menu']",
            "scope": "composer",
            "readOnly": true,
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

这里的 `selector` 只能是受限 CSS selector，`kind` 由服务端枚举校验。禁止配置任意脚本、函数体、事件处理器或 `javascript:` URL。

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
| `removed` | 旧能力本轮明确在有效菜单中不存在 | `changed` | 标记旧能力过期，不删除历史 |
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
- Mode/Model 轻量当前值：每次状态提取读取，不必每次打开菜单。
- 完整 Mode/Model 菜单发现：启动时、菜单操作前、指纹变化时或用户手动刷新时执行。
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

候选适配器从 `pending_confirmation` 到 `active` 至少要经过：

- JSON/schema 校验。
- CSS selector 语法和安全白名单校验。
- 目标页面身份校验。
- selector 唯一性和可见性校验。
- Mode/Model 读取结果与语义期望一致。
- Tool 动作只读定位校验。
- 如需验证点击，必须是低风险、可取消、用户确认的验证步骤；默认不自动点击 Approve、Run、Allow、Build 等会改变 Cursor 状态的动作。
- 回归测试和现有命令测试通过。

### 10.4 回滚规则

自动回滚触发条件建议包括：

- 激活后连续若干轮提取失败。
- `set_mode` 或 `set_model` 在同一 adapter 版本下连续失败。
- 出现多个可执行动作候选且无法唯一定位。
- 运行时发现目标由 Cursor renderer 变成 webview 或未知页面。
- 前端收到能力快照的 schema 校验错误。

回滚后：

- 恢复最近一个验证通过的 adapter。
- 将失败 adapter 标记为 `rejected_runtime`，保留诊断证据摘要。
- 向 `/health`、`/debug/state` 和能力事件报告回滚原因。
- 不自动重复激活同一失败候选，除非 DOM 指纹发生变化或用户手动重试。

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
| `POST` | `/api/adapters/:id/validate` | 对待确认候选执行非破坏性验证 |
| `POST` | `/api/adapters/:id/apply` | 用户确认后激活候选 |
| `POST` | `/api/adapters/rollback` | 回滚到指定的上一版本 |
| `GET` | `/api/adapters/history` | 返回脱敏的版本、状态、时间和摘要 |

请求必须执行：

- 当前 Web session 或现有 Socket.IO 鉴权。
- CSRF（跨站请求伪造）边界和同源校验，沿用 Relay 现有策略。
- 请求体大小和频率限制。
- window/target id 必须来自服务端已发现列表，不能只接受任意字符串。
- `apply` 和 `rollback` 必须是显式动作，并返回 command-like operation id。

### 11.2 Socket.IO 事件

建议新增：

- `capabilities:full`：连接初始化或手动刷新后的完整能力快照。
- `capabilities:patch`：能力变化、状态转移或适配器状态变化。
- `discovery:status`：探测进度、target 选择、候选数量和失败原因。
- `adapter:pending`：生成待确认适配器时通知客户端。
- `adapter:changed`：激活或回滚后通知客户端。

能力快照不应包含完整 HTML、任意 selector 路径详情或敏感证据。诊断页面可以在认证后请求经过截断和脱敏的证据。

### 11.3 `CursorState` 的建议扩展

可以在 `src/server/types.ts` 增加可选字段，避免立即破坏旧客户端：

```ts
interface DiscoverySummary {
  status: 'idle' | 'running' | 'ok' | 'degraded' | 'failed' | 'stale';
  targetId?: string;
  fingerprint?: string;
  lastRunAt: number | null;
  diagnosticIds: string[];
}

interface CapabilitySummary {
  modes: ModeCapability[];
  models: ModelCapability[];
  tools: ToolCapability[];
  status: CapabilityStatus;
  adapterId: string;
}
```

建议 `mode.available` 和模型相关字段继续保留，以兼容现有前端；新的 `capabilities` 字段提供来源、置信度、作用域和过期状态。

### 11.4 前端渲染策略

`src/client/app.js` 应调整为服务端驱动：

- Mode 标签、图标和列表来自能力快照；未知 mode 使用通用图标和服务端 label。
- 不再使用固定的“只有几个模式”的映射决定可选项。
- Model 列表在 `unknown`、`stale`、`empty` 时显示不同状态。
- Tool 操作按钮只有 `executable === true` 且目标证据仍有效时才启用。
- 对待确认 adapter 展示候选数量、风险级别、验证时间和“查看/应用/拒绝”按钮。
- 应用和回滚必须显示确认对话框，明确会影响后续 Cursor DOM 适配，而不是立即执行 Cursor 工具。
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
- Relay 继续使用现有密码、session cookie、Bearer token、Socket.IO 鉴权和同源校验。
- 所有 API 复用现有认证中间件；`/health` 的未认证响应只返回最小状态。
- 页面探测脚本必须是代码中固定的、经过审查的 probe；客户端只能选择枚举参数，不能提交脚本字符串。
- selector 只允许安全白名单，并且服务端执行前再次验证。
- 动作执行必须绑定服务端生成的 capability/action id，不能让客户端直接提交任意 selectorPath 作为唯一依据。
- 可执行动作在执行前重新定位元素，检查作用域、label、唯一性、可见性和 enabled 状态。
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
                 └─ runtime validator 验证唯一目标
                      └─ 用户确认后才进入 active adapter
                           └─ 命令执行器使用 capability/action id
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
    | 'target_list_failed'
    | 'target_unverified'
    | 'webview_target'
    | 'runtime_evaluate_failed'
    | 'composer_not_found'
    | 'mode_trigger_not_found'
    | 'mode_menu_not_opened'
    | 'model_trigger_not_found'
    | 'model_menu_not_opened'
    | 'model_menu_empty'
    | 'tool_scope_ambiguous'
    | 'selector_invalid'
    | 'selector_non_unique'
    | 'adapter_validation_failed'
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
  - `DiscoverySummary`、`CapabilitySummary`、`CapabilityStatus`、`DiscoveryDiagnostic`。
  - 扩展 `ModeInfo`/`ModelInfo`，保留旧字段，新增可选来源和状态。
  - 增加 `ToolCapability` 和 `ToolActionCapability`。
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
  - `/json/version`、`/json`、候选排序、生命周期诊断。
- `src/server/semantic-probe.ts`
  - 固定、只读、结构化的 Runtime.evaluate probe。
- `src/server/capability-extractor.ts`
  - Mode/Model/Tool 的语义化提取。

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
  - active/pending/history、原子写入、备份、回滚。
- `src/server/adapter-registry.ts`
  - 内置策略和本机已批准策略合并。
- `src/server/runtime-validator.ts`
  - selector 和语义候选验证，默认不执行破坏性点击。

修改：

- `src/server/config.ts`
  - 增加适配器存储路径、TTL、备份数量、自动发现开关等配置。
- `selectors.json`
  - 继续作为默认基线；只增加经过人工审查的稳定策略，不作为运行时数据库。

### 14.4 第四批：Relay 和前端

修改：

- `src/server/relay.ts`
  - 增加能力、发现、适配器 API。
  - 复用现有认证和速率限制。
  - 广播 Socket.IO 能力和诊断事件。
- `src/server/state-manager.ts`
  - 转发能力摘要和状态变化；内部诊断继续与公开聊天状态分离。
- `src/client/app.js`
  - 动态渲染 Mode、Model、Tool；未知和 stale 状态分开显示。
  - 增加探测、候选确认、应用和回滚界面。
- `src/client/index.html`、`src/client/styles.css`
  - 增加能力状态和诊断区域，保持移动端布局。

### 14.5 第五批：命令安全改造

修改：

- `src/server/command-executor.ts`
  - `setMode`、`setModel` 和通用 action 点击使用 capability/action id。
  - 执行前重新发现并校验目标，禁止客户端 selectorPath 单独授权。
  - 返回区分目标不存在、目标歧义、菜单未打开和验证失败。
- `src/server/relay.ts`
  - 校验 command payload 的 capability/action id 和 window scope。
- `src/client/app.js`
  - 不再把从 DOM 快照得到的任意路径作为长期命令目标。

---

## 15. 测试方案

### 15.1 单元测试

新增测试文件建议：

- `tests/target-discovery.test.ts`
  - target 排序、webview 排除、about:blank 降权、超时、多个 renderer。
- `tests/semantic-capabilities.test.ts`
  - Mode/Model/Tool 的 ARIA、data 属性、菜单和文本 fallback。
- `tests/capability-diff.test.ts`
  - added/removed/stale/unknown/ambiguous/degraded 分类。
- `tests/selector-validation.test.ts`
  - 合法 selector、危险语法、过长 selector、深层组合、非法能力 key。
- `tests/adapter-store.test.ts`
  - schema、原子写入、备份、损坏文件恢复、回滚。
- `tests/command-capability-guard.test.ts`
  - 未验证 action 不可执行、歧义目标拒绝、执行前重新校验。

现有 `tests/model-picker-fallback.test.ts` 和 `tests/state-manager.test.ts` 应保留，并增加新能力字段的向后兼容断言。

### 15.2 Fixture 测试

由于不能依赖每次测试都运行真实 Cursor，建立脱敏 DOM fixture：

- 旧版 Composer 选择器结构。
- 新版语义菜单结构。
- 多个 webview 和一个 renderer target 的 probe 响应。
- 五个或更多 Mode 的菜单。
- 模型标签相同但 scope 不同的全局/计划菜单。
- Tool action 的嵌套 Edit/Configure 按钮。
- 隐藏、disabled、重复 label 和菜单未打开情况。

Fixture 只保留必要标签、属性和短文本，不放真实项目路径、消息、token 或账号信息。

### 15.3 Live probe 合同测试

在明确设置 `LIVE_CURSOR_TEST=1` 且检测到授权 CDP endpoint 时运行：

1. 列出 targets 并确认至少有一个 target 通过身份 probe。
2. 读取当前 Composer、Mode 当前值和 Model 当前值。
3. 如用户明确允许，打开菜单但不选择、不执行危险动作。
4. 验证发现结果可以序列化为 capability schema。
5. 验证失败时不写入活动 adapter。

Live test 默认只读，不应在 CI 或无明确授权时点击 Cursor 控件。

### 15.4 Relay 和前端测试

- 未认证请求不能访问 discovery/apply/rollback。
- 旧客户端连接时仍能收到现有 state 字段。
- 新客户端能接收 `capabilities:full` 和 patch。
- `unknown`、`stale`、`empty`、`degraded` UI 文案和按钮状态正确。
- Socket 断线重连后恢复能力缓存，并正确标记时间。
- 多窗口切换后能力不能串到旧窗口。

### 15.5 验收指标

建议验收标准：

- 正确 Cursor renderer target 的自动选择率达到 95% 以上；无法确认时必须安全失败。
- 已验证 fixture 中 Mode 发现覆盖率达到 100%，不依赖固定四项列表。
- Model 菜单“未打开”和“打开为空”误报率为 0。
- 未验证 Tool action 不得被前端显示为可执行。
- 任意 adapter schema、selector 或 probe 失败都不能破坏当前活动 adapter。
- 旧的状态和命令协议测试全部通过。
- 连续失败后健康状态、诊断和回滚结果可从认证后的接口获得。

---

## 16. 灰度发布和回归方案

### 阶段 0：只读观测

- 只上线 target probe、能力摘要和诊断日志。
- 不改变现有 Mode/Model 命令路径。
- 不写 adapter，不改变 `selectors.json`。
- 对比固定列表和实时发现结果，收集不同 Cursor 版本的 fixture。

### 阶段 1：旁路解析

- 新 `CapabilityExtractor` 与旧提取器同时运行。
- 新结果只通过 debug endpoint 或受控 Socket.IO 事件暴露。
- 统计 target 选择、Mode/Model 解析、菜单打开和 Tool 识别差异。
- 发现冲突时继续使用旧行为，但将问题标记为 degraded。

### 阶段 2：半自动适配

- 生成 `pending_confirmation` adapter。
- 通过 Web 界面展示候选策略、证据、置信度、风险和验证时间。
- 用户确认后才激活。
- 先只替换读取路径；`set_mode`、`set_model` 和审批动作继续走更严格的旧路径或显式 capability guard。

### 阶段 3：受控命令切换

- 只对通过连续回归和运行时验证的 Mode/Model 设置启用新 adapter。
- Tool 的危险动作逐类开启，先支持只读或低风险动作。
- 监控失败率，超过阈值自动回滚。

### 阶段 4：稳定化

- 将已验证且跨版本稳定的策略人工合并到默认基线。
- 清理长期未使用的候选和脱敏诊断。
- 保留 adapter history，支持定位升级导致的回归。

### 回归重点

每次 CursorRemote 发布或 Cursor 升级后，至少回归：

1. CDP target 发现和多窗口选择。
2. Composer 和文本输入可用性。
3. Mode 当前值、列表和切换。
4. Composer Model 当前值、菜单列表和切换。
5. Plan Model 不污染 Composer Model。
6. shell/edit/fetch/plan/questionnaire Tool 的展示和动作路由。
7. 连接断开、target 重建、菜单未打开和 DOM 延迟加载。
8. Relay 认证、状态广播和旧客户端兼容。
9. adapter 应用、异常回滚和损坏文件恢复。

---

## 17. 推荐实施顺序和优先级

### P0：先解决正确连接和安全失败

1. `TargetDiscovery` 和 renderer 身份 probe。
2. 排除 webview/about:blank 误选。
3. 将“提取失败”和“能力为空”区分开。
4. 建立统一诊断码和 `/api/discovery/status`。

### P1：动态读取 Mode/Model

1. Mode 菜单语义化读取。
2. Model 菜单按作用域读取。
3. 当前值和可用列表都带来源、置信度、状态。
4. 前端去除固定模式列表依赖。

### P2：适配器生命周期

1. selector 安全校验。
2. AdapterStore 原子写入、备份和回滚。
3. 差异检测和待确认候选。
4. `/api/capabilities`、`/api/capabilities/diff` 和 Socket.IO 事件。

### P3：Tool 能力目录和命令保护

1. Tool type/action 统一模型。
2. capability/action id 替代客户端直接提交 selectorPath。
3. 危险动作的执行前重新验证。
4. 逐类开启和灰度回归。

---

## 18. 最终建议

当前问题的根因不是单个 CSS selector 失效，而是系统把三个不同问题混在了一起：

1. “是否连接到了正确的 Cursor renderer target”；
2. “当前 DOM 中是否存在某项能力”；
3. “能否安全地对这项能力执行命令”。

推荐按以下原则实施：

- 先确认 target，再进行任何 Mode/Model/Tool 解析。
- 先用语义化 DOM 和可验证菜单读取能力，再使用版本化 selector fallback。
- 用 `unknown`、`stale`、`empty`、`degraded` 区分失败原因，不能用空列表代替所有失败。
- 把工具实例、能力目录和可执行动作分开建模。
- 将运行时发现结果保存为带证据的待确认 adapter，而不是直接覆盖 `selectors.json`。
- 每次 adapter 应用都经过 schema、唯一性、语义和运行时校验，并保留备份和回滚。
- 让服务端成为唯一的执行授权边界；前端只能请求已验证的 capability/action id。
- 先只读观测，再旁路解析，再半自动适配，最后逐类切换命令执行。

在完成 P0 和 P1 之前，不建议开启无条件自动写配置或自动切换生产命令路径。对当前现场而言，最先要做的具体动作是：让 `discover-dom` 和生产 `CDPBridge` 使用同一套 target 评分与语义 probe，并确认哪个 target 真正包含 Composer；只有这一步可靠后，Mode/Model 的新 fallback 才有意义。

---

## 19. 当前落地状态与下一步

本方案文档已经完成，但方案中的 `TargetDiscovery`、`CapabilityExtractor`、`AdapterStore` 和新增 Relay API 尚未在本次变更中实现。当前生产行为仍以现有 `CDPBridge`、`dom-extractor.ts`、`command-executor.ts`、`selectors.json` 和前端状态模型为准。

建议下一次实施从以下三个可独立验收的改动开始：

1. 新增只读 target identity probe，并让生产连接和 `discover-dom` 共用它。
2. 将 Mode/Model 的提取结果增加状态和来源，明确区分“未发现”和“发现为空”。
3. 增加认证保护的 discovery status 接口，在确认 target 和解析结果可靠前不写入适配配置。

完成这三项后，再进入 adapter 候选、用户确认、激活和回滚阶段。