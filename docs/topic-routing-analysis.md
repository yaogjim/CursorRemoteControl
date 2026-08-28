# 话题路由 — 深度分析与方案

## 问题摘要

话题被创建成了错误的（窗口, tab）配对：

- `cursor-ide-remote — Campaign results improvement plan`（应属于 adwords）
- `adwords-optimization-agent — VNC setup on Ubuntu machine`（应属于 .openclaw）

## 来自 telegram-topics.json 的证据

```
adwords (C25284...) — "Campaign results improvement plan" ✓ 正确
adwords (C25284...) — "VNC setup on Ubuntu machine"       ✗ 错误（属于 .openclaw）
cursor-ide-remote (EAF88...) — "Campaign results improvement plan" ✗ 错误（属于 adwords）
```

相同的 tab 标题出现在了错误的窗口下。

## 根因分析

### 1. Cursor「Agent Unification」架构

当 `body.agent-unification-enabled` 时，侧栏在同一视图中显示 **所有项目**：

- 每个项目一个 `.agent-sidebar-project-cell`（adwords、cursor-ide-remote、.openclaw 等）
- `.agent-sidebar-cell`（聊天 tab）嵌套在各项目之下

通过 CDP 连接到窗口 X 时，我们拿到的是该窗口的 DOM。但 DOM 可能展示 **统一侧栏**，其中包含所有项目，因此能看到其他项目的 tab。

### 2. 当时的作用域逻辑（脆弱）

当时按 `containerComposerId` 限定范围：

1. 从聊天容器（消息）读取 composer-id
2. 找到 composer-id 匹配的 tab
3. 取该 tab 的祖先 `.agent-sidebar-project-cell`
4. 只返回该项目单元格内的 tab

**失败模式：**

- `containerComposerId` 为空 → `scopeRoot = null` → 使用 `document` → 拿到所有项目的全部 tab
- 没有单元格匹配（tab 上的 composer-id 与容器不一致）→ 同样回退
- 找不到 `.agent-sidebar-project-cell`（DOM 结构变化）→ 使用 `document.body` → 作用域错误

### 3. 窗口标题 vs DOM

CDP 窗口标题（例如 `"cursor-ide-remote [WSL: ubuntu-24.04]"`）是判断当前项目的 **权威来源**。DOM 可能显示多个项目。必须把 **窗口标题** 与 DOM 中的项目单元格标签对齐，才能正确限定 tab。

## 方案

### 选项 A：把窗口标题传入提取函数（推荐）

1. **给 `extractionFunction` 增加 `windowTitle` 参数**
2. **调用方**：WindowMonitor 轮询时传入 `win.title`；主 DOM 提取器从 `cdpBridge.windows` + `activeTargetId` 取得
3. **作用域逻辑**：找到标签/文本包含或匹配 `windowTitle`（规范化后）的 `.agent-sidebar-project-cell`。只返回该单元格内的 tab。
4. **回退**：如果没有匹配的项目单元格，返回 **空的 `chatTabs`** — 绝不使用未限定范围的 tab。

### 选项 B：拒绝未限定范围的 tab

1. 当 `scopeRoot` 为 null（无法按 composer-id 限定）时，返回 `chatTabs: []`
2. 防止作用域失败时创建错误话题
3. 在作用域修好之前，部分窗口可能出现「不同步」

### 选项 C：使用 DOM 中的工作区名称

1. 读取 `.agent-sidebar-workspace-name` 或 `.auxiliary-bar-workspace-name` — 显示当前工作区
2. 用它找到匹配的项目单元格
3. 无需从外部传入窗口标题

## 推荐实现

**组合 A + B：**

1. 把 `windowTitle` 传入提取（轮询时来自 snapshot/window）
2. 主作用域：按窗口标题匹配项目单元格
3. 回退：尝试 composer-id 作用域
4. 两者都失败：返回空 `chatTabs`（安全失败）

## 需要修改的文件

- `dom-extractor.ts`：增加 windowTitle 参数，按标题匹配项目单元格，失败时返回空 chatTabs
- `window-monitor.ts`：把 `win.title` 传给 `extractFromClient`
- `dom-extractor.ts`（DOMExtractor 类）：轮询时从 bridge 状态传入窗口标题
- `index.ts` 或提取器装配：把窗口标题接到主轮询

## 当前实现状态

源码已落实选项 A 的核心路径，并补充了更新的 Cursor 侧栏形态：

- `extractionFunction` 接受可选的 `windowTitle`；`WindowMonitor` 与主提取器都会传入窗口标题。
- 先按 `containerComposerId` 找 `.agent-sidebar-project-cell`，失败时再用规范化后的窗口标题匹配项目单元格。
- 较新的 Cursor 构建会走 glass sidebar 路径（`.glass-sidebar-agent-list-container li.ui-sidebar-menu-item`），标题可能带上分组前缀。
- `TopicManager` 以 `windowId::tabTitle` 为运行时主键，并以规范化窗口标题（去掉 `[WSL: …]` / `[SSH: …]` 等后缀）作为持久化回退；映射还包含可选的 `composerId`，用于区分同名 agent。
- Telegram 侧另有 `/resync`（把当前话题重新绑定到 Cursor 当前活动窗口/tab）和 `/dedupe`（合并重复话题）。

仍需注意：若 `scopeRoot` 仍为空，提取器会回退到 `document` 再扫 `.agent-sidebar-cell`，**尚未**严格做到选项 B 的「失败即返回空 `chatTabs`」。若再次出现跨项目错配，应优先收紧这一回退，而不是扩大未限定扫描。