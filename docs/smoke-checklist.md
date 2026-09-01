# 发布前冒烟检查清单

在自动化测试通过、准备发布之前，请手动完成以下检查。

授权级别、证据字段和分层判定见 `docs/cursor-capability-sync-plan.md` 第 21 节与 `docs/prd.md` §15。勾选时必须写下 `authorizationLevel` + `evidenceLayer`；不得把 isolated tests 或 PASSIVE live 勾成 SIDE_EFFECT live。

**本批次硬约束**

- `SIDE_EFFECT` 按动作显式批准。一般 Build / 计划 Build **不**授予 Run、Approve、Allow、Skip、Mode、Model。
- `ADAPTER_APPLY` 禁用。`POST /api/adapters/:id/apply` 必须稳定 `503 ADAPTER_ACTIVATION_UNAVAILABLE`。Mode 候选保持 pending，当前 selector 路径保持活动。
- **不要**宣称真实 Tool 副作用已通过。
- Telegram Mode / Model / Action / Tool E2E 为 **deferred**，不要勾 pass。

每条可写成一条 `AcceptanceEvidenceRecord`（`schemaVersion: 1`）。脱敏：不写密码、token、cookie、WebSocket URL、完整聊天/DOM、未截断路径、可执行 selector、未哈希 action id。

## 环境

- [ ] 在干净的机器或配置文件中安装打包后的 VSIX（不要用开发检出目录）
- [ ] 确认服务器启动并打印 `=== CursorRemote vX.Y.Z ===`，版本号正确

## Web 应用

- [ ] Web 应用能在浏览器中加载 — 控制台没有 `io`、`vendor-socket.io.min.js` 相关错误
- [ ] Favicon 能加载（无 404）
- [ ] 登录 / 会话持久化正常（刷新后会话仍在）
- [ ] Cursor 活跃时，连接圆点显示 “Connected”
- [ ] Agent 活动期间状态显示 shimmer 文本，结束后回到 “Idle”
- [ ] 消息按正确类型渲染（human、assistant、tool、thought）
- [ ] Run command 卡片显示命令文本，以及 Skip/Run 按钮（有 `actionId` 才可点；**不**在此勾 Tool live 通过）
- [ ] 审批按钮仅在有 `actionId` 时启用；不要用 `selectorPath` 作为授权回退
- [ ] Plan widget 显示标题、进度；“View Plan” 打开包含完整计划的模态框
- [ ] Plan “Build” 只发送 `actionType: 'build'`；不把它当成 Run/Approve 授权
- [ ] Plan 模型选择器打开 sheet 并列出模型选项
- [ ] 代码块保留换行，diff 显示红/绿着色
- [ ] 向上滚动会停止自动滚动；新消息不会把视图拽回底部
- [ ] 待确认 adapter 若出现，只显示 pending/诊断；DOM **没有** `[data-adapter-apply]` 激活按钮

## Web 连接 / 能力状态矩阵

证据层：`isolated_test` 或浏览器 `PASSIVE` 观察。药丸可点 ≠ SIDE_EFFECT live。

- [ ] Socket 断开：连接点 `data-layer=socket`，Mode/Model 锁定但保留 last-known 标签
- [ ] Socket 重连后药丸保持 `awaiting-full` / disabled，直到 `capabilities:full`；中途 `capabilities:patch` 不能解锁
- [ ] CDP 断开（`Waiting for Cursor`）独立于能力药丸；不改写 capability mutation
- [ ] extractor `stale` / `waiting` 使用 extractor 层，不与 capability stale 混层
- [ ] 能力 stale 时连接圆点仍可绿；药丸 `pill-stale` 且 disabled
- [ ] targetGeneration 上升：关闭 sheet、锁定药丸、保留标签
- [ ] `unavailable` 与 `degraded` 的 CSS/属性可区分
- [ ] `ok` + Model `partial`：Mode 可写、Model 锁定，不伪造模型选项
- [ ] 完整 `capabilities:full` 恢复后 Mode 与 Model 同时解锁
- [ ] `unknown` / `stale` / `degraded` / `unavailable` / `partial` 有可区分样式

## HTTP / Socket 鉴权

证据层：`isolated_test`（`tests/relay-auth.test.ts`、`tests/relay-adapter-security.test.ts`、`tests/relay-action-inbound.test.ts`）。apply 的通过标准是 **503**，不是 200。

- [ ] 设密后未认证 GET `/api/capabilities`、`/api/discovery/status` 失败
- [ ] `/health` 对未认证 LAN 只返回最小字段（无 windows / agentStatus / lastExtractionError）
- [ ] 外域 Origin：login 与 cookie 写失败；Socket.IO 握手失败；同源成功
- [ ] cookie 写缺 CSRF → 失败；同源 Origin + CSRF 可进入处理
- [ ] cookie 写缺 Origin → 失败
- [ ] Bearer CLI 可不带 Origin/CSRF；Bearer + 显式外域 Origin 仍拒绝
- [ ] 敏感 POST 缺 `X-Operation-Id` 或非法 id → 400，且不执行 runner
- [ ] 同一 operation id + 同一 fingerprint 只执行一次并回放结果
- [ ] 同一 operation id + 不同 body → 409
- [ ] 敏感探测超过速率上限 → 429 + `Retry-After`
- [ ] 非法 JSON → 400 `Invalid JSON`；超 `API_JSON_LIMIT_BYTES` → 413 `Payload too large`
- [ ] 危险 socket 命令要求 bounded `operationId`；重放一次；fingerprint 冲突 409；超限 429
- [ ] Socket.IO 超过 `maxHttpBufferSize` 被拒绝
- [ ] `POST /api/adapters/:id/apply` 在 `confirmed: true` 且 binding 齐全时仍为 **503 `ADAPTER_ACTIVATION_UNAVAILABLE`**；pending 不变；`activeBindings` 不增加；builtin / `selectors.json` 路径仍活动
- [ ] apply 缺 `confirmed: true` → 400；不要把 400 解释成“激活已开放”

## 双 target PASSIVE 报告

授权：`PASSIVE`。不要开菜单、不要点 Mode/Model/Tool。

- [ ] `/json/version` 证明 endpoint 属于 Cursor
- [ ] 两个 `page/workbench` target 都能只读探测，且报告互相隔离（各自 targetId hash、generation、脱敏 workspaceKey、Composer readiness）
- [ ] `webview` / `about:blank` 不进入窗口列表，也不进入 `CommandExecutor`
- [ ] preferred target 仍有效时不被评分替换
- [ ] PassiveProbe 无点击、无焦点变化、无菜单开关
- [ ] 只报告 Mode/Model **当前值**；未打开的菜单不得写成 `complete`、`empty` 或 `removed`
- [ ] 公开报告无 WebSocket URL、无完整路径、无聊天正文

## ActionRegistry（负向 / 正向）

证据层：`isolated_test`。正向路径 **不是** 真实 Tool live。

负向：

- [ ] 无 `actionId` 或非法 `actionType` 的 `click_action` 不调用执行器
- [ ] 客户端 `selectorPath` 不能授权
- [ ] 过期 → `action_expired`；已消费 → `action_consumed`
- [ ] 错误 type / composer / generation / window → `action_scope_changed` 或 `action_not_found`
- [ ] invalidate target/generation/adapter 不影响无关 action
- [ ] 未知 kind 保持 `executable: false`，不折叠已知类型

正向：

- [ ] 匹配 type+generation 可 reserve，consume 后不可再用
- [ ] `approve` / `approve_all` / `allow` / `run` / `build` / `continue` / `questionnaire_option` id 互不替代；Build ≠ Run
- [ ] 达容量上限时不驱逐已 reserve 的 action
- [ ] 合法 `actionId` + `actionType` + `operationId` 只转发执行器一次

## Telegram

监视类冒烟仍做。Mode / Model / Action / Tool **E2E deferred** — 下列控制项不要勾 pass。

- [ ] 实时活动显示 shimmer（spoiler 标签）— 例如带 spoiler 的 `● Thinking…`
- [ ] 活动结束后 shimmer 消失（消息被删除）
- [ ] Thought 的 step-summary 在进行中显示 spoiler，完成后去掉
- [ ] 活动行会与匹配的 step-summary 去重
- [ ] Run command **展示**命令文本和 Skip/Run 内联按钮（展示 ≠ Tool E2E pass）
- [ ] Plan block **渲染** todos 以及 View Plan / Build 按钮（展示 ≠ Action E2E pass）
- [ ] `telegram.e2e.mode` — **deferred**
- [ ] `telegram.e2e.model` — **deferred**
- [ ] `telegram.e2e.action` — **deferred**
- [ ] `telegram.e2e.tool` — **deferred**

isolated tests（如 `tests/telegram-capability-guard.test.ts`）可以通过，但不得把上列 `caseId` 标为 `side_effect_live` pass。

## 边界情况

- [ ] 在多个 Cursor 窗口之间切换时，每个窗口显示对应状态；能力快照不串窗
- [ ] 将 Cursor 置于后台（macOS）时优雅降级 — 不崩溃，状态显示 stale
- [ ] 快速切换 tab 不会产生重复消息