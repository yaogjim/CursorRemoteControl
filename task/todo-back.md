# CursorRemote 后续开发 Todo

> 本文件记录 Review 修复完成后的后续开发计划。所有工作应保持现有边界：Cursor CDP → 状态核心 → Web/Telegram Transport；不引入 Puppeteer，也不把服务端迁入 Extension Host。
>
> 当前基线：Review 相关回归已修复；服务端与扩展类型检查、构建和测试均通过。后续变更应按独立批次交付，并在每批结束后执行 `npm test`、`npm run build`、`npm run build:ext`。

## 交付原则

- 先做可观测性和测试基础，再做协议与存储迁移。
- DOM 解析或注入策略调整前，先通过 discovery/probe 获取 Cursor 当前真实页面数据，并使用 `fixtures/recordings` 回放回归。
- 协议升级采用兼容优先：保留旧客户端可用路径，逐步启用新能力，每个阶段具备明确回滚开关。
- 敏感信息不写入日志、对话状态、VSIX 或普通配置文件。
- 每批只解决一个主要风险，避免协议、密码和发布脚本在同一批次同时变化。

## 批次 A：结构化 Logger 与敏感信息脱敏

### 目标

将服务端和扩展的散落日志统一为可过滤、可检索、可脱敏的日志事件，修复当前 `LOG_LEVEL` 只读取但没有真正过滤的问题。

### 任务

- 新增服务端 logger 模块，支持 `debug < info < warn < error` 级别和 text/JSON 两种输出格式。
- 统一事件字段：`ts`、`level`、`event`、`msg`，按需增加 `requestId`、`commandId`、`windowId`、`generation`。
- 替换 `index.ts` 中对 `console.*` 的全局补丁，以及 CDP、Relay、Extractor、Command Executor、Telegram 关键路径的直接日志。
- 扩展 OutputChannel 解析 JSON 日志的 `event` 和 `level`，状态判断不再依赖英文日志片段。
- 对 Web 密码、Telegram Bot Token、Session Token、Bearer、Cookie、注册 Token 做统一脱敏；日志只记录消息 ID、长度和摘要，不记录消息正文或代码。
- 对异常对象统一记录安全的错误类型和 message，避免无意序列化配置对象。

### 验收

- `LOG_LEVEL=warn` 时不输出 info/debug。
- JSON 日志每行可独立解析，并能驱动扩展的 running/disconnected/error 状态。
- 自动化测试确认密码、Token、Cookie 和对话正文不会出现在 stdout。
- 兼容现有文本日志查看方式。

### 回滚

保留 `LOG_FORMAT=text` 和旧事件映射；必要时通过配置关闭 JSON 输出。

## 批次 B：扩展单元测试 Harness

### 目标

在不启动真实 Cursor、真实子进程或真实系统密钥链的情况下，覆盖 Extension Host 的生命周期和配置逻辑。

### 任务

- 将测试匹配扩展为 `tests/**/*.test.ts`。
- 新增 `tests/helpers/vscode-stub.ts`，提供 workspace、window、commands、Uri、SecretStorage 和事件订阅的最小实现。
- 为 `ServerManager` 抽出可注入边界：`spawn`、`fetch`、fs watcher、sleep/clock 和输出通道。
- 覆盖 owner/observer 竞争、LifecycleLock generation、restart、manual-stop、takeover、端口占用和异常退出。
- 覆盖配置桥接、SecretStorage 迁移、密码变化后的重启，以及 `openExternal` 调用。
- 测试无死循环、无重复 Telegram polling、旧 owner 不误杀新 owner。

### 验收

- CI 可以在无 VS Code GUI、无 Cursor 和无网络环境执行扩展测试。
- 测试不调用真实 `spawn`、系统 Keychain 或 CDP。
- 关键异常路径有明确状态和资源清理断言。

### 回滚

测试 Harness 独立于生产运行时，失败时可暂时恢复原测试 glob，不影响服务端功能。

## 批次 C：Extractor 函数一次注入

### 目标

避免每次轮询都把大段 extraction function 重新序列化到 `Runtime.evaluate`，降低空闲 CPU、网络和 CDP 开销。

### 任务

- 为 extractor 增加版本戳和安装函数，例如页面内 `window.__cursorRemoteExtract`。
- CDP 连接成功后启用 Runtime，并在目标页面默认主 execution context 安装一次。
- 轮询只调用短表达式和参数；保留完整函数注入作为兼容回退路径。
- 监听 execution context 创建/销毁；页面 reload、context 销毁或版本不匹配时重新安装。
- 遇到 `ReferenceError` 或函数未定义时最多自动重注入并重试一次，防止轮询失败风暴。
- 为并行窗口使用独立 CdpClient 和独立注入状态，禁止跨窗口共享 context。
- 先用 discovery/probe 验证 Electron 页面 context 行为，再决定是否加入 `Page.addScriptToEvaluateOnNewDocument`。
- 增加 `EXTRACTOR_INJECT=0/1` 回滚开关。

### 验收

- 稳态轮询的 CDP 表达式显著短于完整 extractor 源码。
- 页面 reload 后最多一次失败即可恢复。
- 切换窗口、临时并行窗口和多 tab 场景不会串用 extractor 状态。
- 录制 fixture 的抽取结果与旧实现一致。

### 回滚

关闭 `EXTRACTOR_INJECT`，恢复每轮完整函数调用。

## 批次 D：Web 密码迁移到 VS Code SecretStorage

### 目标

停止将 Web 密码长期保存在普通 VS Code 配置或环境文件中，同时兼容已有安装和多窗口运行。

### 任务

- 增加 `WEBAPP_PASSWORD_SECRET_KEY`，读取优先级为 SecretStorage → 旧配置 → 空值/生成值。
- 激活时迁移旧 `cursorRemote.webappPassword`，校验写入 SecretStorage 成功后清理旧明文配置。
- Setup Panel 的密码输入改为 password 类型，不在通知、日志或错误中输出完整密码。
- 配置桥接从 SecretStorage 获取密码，再传给 owner 子进程；独立 `.env` 启动模式保持兼容。
- 监听 `context.secrets.onDidChange`：owner 重启服务，observer 刷新界面但不重复启动。
- 使用 LifecycleLock 防止多个窗口同时生成不同密码；处理 SecretStorage 失败时的安全回退和用户提示。
- 增加迁移、重新设置、清空密码、双窗口同步和服务重启测试。

### 验收

- 新安装的密码只进入 SecretStorage，`settings.json` 不保留明文。
- 旧安装升级后密码不变，迁移只执行一次。
- 第二个窗口读取同一密码，不覆盖 owner 的密码。
- 修改密码后旧 Session 失效，服务使用新密码。

### 回滚

保留一个版本周期的旧配置只读回退；出现 SecretStorage 不可用时明确提示并禁止无密码暴露到 LAN。

## 批次 E：完整 messagesDelta 协议

### 目标

让长会话的消息更新不再随历史消息总长度线性增长，同时保证重连、切窗、乱序和重复消息的正确性。

### 协议草案

```ts
interface MessagesDelta {
  protocolVersion: 1;
  generation: number;
  cursor: number;
  prevCursor: number;
  ops: MessageOp[];
}

type MessageOp =
  | { op: 'append'; afterId: string | null; revision: number; message: ChatElement }
  | { op: 'update'; id: string; revision: number; message: ChatElement }
  | { op: 'remove'; id: string; revision: number };
```

- `protocolVersion` 是线协议版本，破坏性变更时递增。
- `generation` 表示窗口/会话世代；切窗、CDP 重连、active composer 变化或 extractor reset 时递增。
- `cursor` 在同一 generation 内单调递增；`prevCursor` 必须等于客户端已应用的 cursor。
- `revision` 是单条消息内容版本，用于幂等和乱序防护。
- `state:full` 携带完整 messages、generation 和 cursor，作为重连及缺口恢复基准。

### 任务

- 在共享 types 中定义 protocol envelope、消息操作和客户端能力协商。
- StateManager 根据消息 ID/hash 计算 append/update；第一版保留服务端全量快照供 Telegram 和重同步使用。
- Relay 按 Socket 能力发送新事件；旧客户端继续接收现有全量 `state:patch`。
- Web 客户端实现 generation、cursor、revision 校验：旧 generation 丢弃；重复 cursor 幂等丢弃；cursor 缺口请求 resync；`prevCursor` 不匹配时获取 `state:full`。
- 第一版只实现 append/update；不要把虚拟化渲染或 DOM 卸载当成 remove。待历史缓存策略明确后再启用 remove。
- 保持窗口切换使用 generation + full state，禁止旧窗口消息残留。
- 增加服务端、Relay、Web 客户端和重连回放测试。

### 推荐分步

1. 定义类型和服务端 delta 派生，同时双发全量格式。
2. 客户端实现 delta 应用和 resync，但默认保留全量兼容路径。
3. 通过 handshake/feature flag 给新客户端启用 delta。
4. 一个兼容周期后评估是否省略全量消息。

### 验收

- Assistant 流式更新只产生尾部消息 update。
- 重复/乱序不会产生重复消息或回退到旧内容。
- cursor 缺口能触发 full state 恢复。
- 窗口切换后旧 transcript 不会混入新窗口。
- v0 客户端行为不变。

### 回滚

关闭 `MESSAGES_DELTA`，客户端恢复消费全量 messages。

## 批次 F：发布流程彻底统一

### 目标

消除版本号双重递增、重复打包、固定本机路径和发布凭据处理不一致的问题。

### 任务

- 让 `release.ts` 成为唯一版本号修改入口。
- 将当前 `package` 改为 `package:vsix`，只构建 VSIX，不自动 patch bump；重复执行版本号不变。
- `publish.ts` 优先复用 `releases/cursor-remote-${version}.vsix`，缺失时显式调用 `package:vsix`，禁止静默二次 bump。
- 发布 Token 优先读取 `OVSX_PAT`/`VSCE_PAT` 环境变量，本地文件只作为开发回退，禁止进入 VSIX。
- CI 增加 VSIX 构建、`verify-vsix` allowlist、产物上传和 tag 发布任务；Open VSX 发布使用手动审批和环境 Secret。
- Git tag、GitHub Release、VSIX 和扩展 package.json 使用同一个版本号。
- 去掉固定公共仓库路径依赖，使用 `CURSORREMOTE_PUBLIC_ROOT` 或明确参数。
- 增加发布前后检查：工作树状态、CHANGELOG、依赖锁文件、VSIX 内容、版本匹配和 token 存在性。
- 编写回滚流程：已发布版本不复用；通过修复版本、撤下错误 Release 资产和文档钉住稳定版本处理。

### 验收

- 一次 release 只递增一次版本。
- 连续两次 `package:vsix` 版本不变。
- CI 可以生成并验证 macOS/跨平台可安装 VSIX。
- 无 token 时发布命令在同步或提交前失败。
- 同一 VSIX 同时用于 GitHub Release 和 Open VSX。

### 回滚

发布脚本修改独立于运行时代码；可恢复旧脚本，但不得复用已经发布的版本号。

## 推荐顺序与依赖

```text
A 结构化 Logger
  ├── B 扩展单测 Harness
  └── D SecretStorage 密码迁移
C Extractor 一次注入（可与 A/B 并行）
E messagesDelta（待消息 ID/hash 与重同步测试稳定后）
F 发布流程统一（独立批次，不与 E/D 合并）
```

推荐交付批次：

1. A：日志、脱敏和扩展状态事件。
2. B：扩展测试边界和生命周期回归。
3. C：Extractor 一次注入及回退。
4. D：SecretStorage 迁移及多窗口同步。
5. E：messagesDelta 双发兼容、客户端重同步。
6. F：版本、VSIX、CI、凭据和回滚流程。

每批完成后记录：构建耗时、测试数量、VSIX 体积、空闲 60 秒 patch 数和多窗口轮询情况。