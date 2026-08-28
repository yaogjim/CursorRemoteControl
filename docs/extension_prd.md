# CursorRemote — 扩展 PRD

## 1. 概述

把 CursorRemote 中继服务器打包为 VS Code / Cursor 扩展。扩展把服务器作为受管子进程包装起来，并提供原生编辑器集成：设置 UI、安装向导、状态栏、输出通道、侧栏树视图，以及多窗口协调。服务器代码、Web 客户端和 Telegram 传输层打进扩展，作为单个子进程运行。捆绑的 **Web 客户端** 把助手 **`codeBlocks`** 和工具 **`diffBlock`** 渲染为原生代码/diff UI（约 7 行可滚动视口、全屏阅读器、移动触摸目标；见 `docs/prd.md` §6.11 和 `docs/architecture.md` §2.6）。

### 1.1 问题陈述

独立服务器需要手动安装：克隆仓库、安装依赖、创建 `.env`、运行 `npm run dev`。用户必须自己管理进程生命周期。编辑器内看不到服务器状态、CDP 连接健康或 agent 活动。多窗口场景会造成端口冲突和重复的 bot 实例。

### 1.2 目标

交付一个 VS Code / Cursor 扩展，能够：

- 从 `.vsix` 文件安装（计划上架 marketplace）
- 自动管理中继服务器生命周期（start/stop/restart）
- 通过 VS Code Settings 提供全部配置（不需要 `.env` 文件）
- 提供交互式设置面板，用于网络、密码和 Telegram 配置
- 在状态栏和侧栏显示服务器与 CDP 连接状态
- 把服务器日志管道到带内置级别过滤的 LogOutputChannel
- 在带 Start/Stop 控件的侧栏树视图中显示 agent 状态、窗口和快捷操作
- 激活后直接启动中继（无 license key、购买或激活步骤）
- 首次安装时自动生成密码学安全的随机 Web 客户端密码
- 跨多个 Cursor 窗口只运行一个服务器实例（单例模式）
- 把所有服务器依赖打进单个文件（不需要 `node_modules`）
- 与独立的 `npm run dev` 用法保持 100% 向后兼容

### 1.3 非目标

- 把服务器改写为在 Extension Host 内联运行
- 用 VS Code 扩展 API 替换基于 CDP 的 DOM 提取
- 自动发现或配置 CDP 调试端口

---

## 2. 用户故事

### US-1：安装即可用

**作为** Cursor 用户，**我希望** 从 `.vsix` 文件安装扩展后服务器就开始运行，**这样** 我不需要克隆仓库、安装依赖或编辑配置文件。

### US-2：自动启动

**作为** 开发者，**我希望** Cursor 启动时中继服务器自动启动，**这样** 我的手机客户端和 Telegram bot 始终可用，无需手动干预。

### US-3：设置 UI

**作为** 开发者，**我希望** 在带内联文档链接的 VS Code Settings 中配置 CDP URL、服务器端口、Telegram 设置和其他选项，**这样** 我不需要编辑 `.env` 文件。

### US-4：安装向导

**作为** 新用户，**我希望** 有一个交互式设置面板引导我完成网络、密码和 Telegram 配置，**这样** 我不用读文档也能上手。

### US-5：状态可见

**作为** 开发者，**我希望** 在侧栏和状态栏看到服务器状态、CDP 连接、agent 活动和已连接客户端，**这样** 一眼就知道系统在工作。

### US-6：服务器控制

**作为** 开发者，**我希望** 侧栏里有 Start 和 Stop 按钮，**这样** 我不用打开命令面板就能控制服务器。

### US-7：直接启动

**作为** 用户，**我希望** 中继启动时不需要 license key 或购买步骤，**这样** 安装后就能立刻使用 CursorRemote。

### US-8：自动生成密码

**作为** 新用户，**我希望** 首次安装时为我生成强随机密码，**这样** Web 客户端默认就是安全的，无需手动配置。

### US-9：多窗口安全

**作为** 打开了多个 Cursor 窗口的开发者，**我希望** 同一时间只运行一个服务器并自动恢复，**这样** 不会出现端口冲突或重复的 Telegram bot。

### US-10：服务器日志

**作为** 开发者，**我希望** 在 Output 面板中查看带级别过滤的服务器日志，**这样** 调试时不必切到终端。

---

## 3. 架构

扩展运行在 VS Code Extension Host（一个 Node.js 进程）中。它把服务器作为子进程拉起，并通过以下方式通信：

1. **环境变量** — 在 spawn 时传入配置（无 license key）
2. **HTTP 轮询** — 每 5 秒 `GET /health` 获取状态数据
3. **stdout/stderr 解析** — 日志行管道到 LogOutputChannel

服务器及其全部 Node.js 依赖通过 esbuild 打成单个 ESM 文件（`dist/server/bundle.mjs`）。扩展自身打成 `dist/extension.cjs`（CJS 格式，external: `vscode`）。

### 3.1 单例服务器模式

所有 Cursor 窗口只运行一个服务器进程：

1. 启动时，`ServerManager` 在配置的端口上探测 `GET /health`
2. 若服务器已在运行，该窗口以 **观察者（observer）** 身份附着（轮询 health、显示状态，但不拥有进程）
3. 若未运行，该窗口拉起服务器并成为 **所有者（owner）**
4. 若所有者窗口关闭，观察者检测到 3 次失败的 health 轮询，然后其中一个观察者在随机抖动（0–3s）后接管，以避免竞态
5. 同时 spawn 的竞态通过捕获 stderr 中的 `EADDRINUSE` 并回退到观察者模式来处理

---

## 4. 扩展命令

| 命令 ID | 标题 | 说明 |
|---|---|---|
| `cursorRemote.start` | CursorRemote: Start Server | 启动中继服务器 |
| `cursorRemote.stop` | CursorRemote: Stop Server | 停止中继服务器 |
| `cursorRemote.restart` | CursorRemote: Restart Server | 重启中继服务器 |
| `cursorRemote.openWebClient` | CursorRemote: Open Web Client | 打开浏览器客户端 URL |
| `cursorRemote.openSetup` | CursorRemote: Open Setup Panel | 打开网络和 Telegram 安装向导 |
| `cursorRemote.showLogs` | CursorRemote: Show Logs | 显示 Output Channel |

---

## 5. 扩展设置

所有设置位于 `cursorRemote` 命名空间。每项与服务器环境变量 1:1 映射。设置使用带 GitHub 文档链接的 `markdownDescription`。

| 设置 | 类型 | 默认值 | 环境变量 | 说明 |
|---|---|---|---|---|
| `cursorRemote.autoStart` | boolean | `true` | — | 启动时自动启动服务器 |
| `cursorRemote.cdpUrl` | string | `http://127.0.0.1:9222` | `CDP_URL` | Cursor 的 CDP 端点 |
| `cursorRemote.serverPort` | number | `3000` | `SERVER_PORT` | Web 服务器端口 |
| `cursorRemote.serverHost` | string | `127.0.0.1` | `SERVER_HOST` | 绑定地址（默认仅 localhost） |
| `cursorRemote.pollIntervalMs` | number | `500` | `POLL_INTERVAL_MS` | 主窗口 DOM 轮询频率（扩展设置默认；`config.ts` 独立默认是 `300`） |
| `cursorRemote.debounceMs` | number | `300` | `DEBOUNCE_MS` | 广播防抖（扩展设置默认；`config.ts` 独立默认是 `150`） |
| `cursorRemote.logLevel` | enum | `info` | `LOG_LEVEL` | 日志级别 |
| `cursorRemote.webappPassword` | string | *（自动生成）* | `WEBAPP_PASSWORD` | Web 客户端密码 |
| `cursorRemote.windowTitleQualifier` | boolean | `true` | `WINDOW_TITLE_QUALIFIER` | 在标题中显示远程限定符 |
| `cursorRemote.telegram.enabled` | boolean | `false` | `TELEGRAM_ENABLED` | 启用 Telegram |
| `cursorRemote.telegram.botToken` | string | `""` | `TELEGRAM_BOT_TOKEN` | 已弃用的 settings.json 字段。token 通过设置面板存入 SecretStorage。 |
| `cursorRemote.telegram.allowedUsers` | string | `""` | `TELEGRAM_ALLOWED_USERS` | 逗号分隔的 ID |
| `cursorRemote.telegram.impl` | enum | `grammy` | `TELEGRAM_IMPL` | Telegram 传输实现：`grammy`（默认）或 `raw`（Grammy 启动卡住时的 fetch 回退） |

### 5.1 安全默认值

- `serverHost` 默认为 `127.0.0.1`（不是 `0.0.0.0`），因此在用户通过设置面板显式选择之前，服务器不会暴露到网络
- `webappPassword` 在首次激活时用 `crypto.randomBytes(16).toString('base64url')` 自动生成，并写入 VS Code Settings（`cursorRemote.webappPassword`）。**不会** 存入 SecretStorage。会向用户显示一条非阻塞通知，带 “Copy to Clipboard” 操作。
- Telegram bot token 存在 VS Code SecretStorage（`cursorRemote.telegram.botToken` 键）。残留的 settings.json 值会在激活时迁走并清空。

---

## 6. 状态栏

左对齐状态栏项，显示服务器状态：

| 状态 | 文本 | 颜色 | 条件 |
|---|---|---|---|
| Running | `$(radio-tower) Remote: Running` | 绿色 | 服务器健康 + CDP 已连接 |
| Disconnected | `$(radio-tower) Remote: Disconnected` | 黄色 | 服务器在运行，CDP 未连接 |
| Stopped | `$(radio-tower) Remote: Stopped` | 默认 | 服务器未运行 |
| Error | `$(radio-tower) Remote: Error` | 红色 | 服务器崩溃或不可达 |

点击打开 CursorRemote 侧栏面板（不是命令面板）。命令为 `cursorRemote.status.focus`。

---

## 7. 侧栏树视图

活动栏视图容器 `cursorRemote`，由 `TreeDataProvider` 显示：

### 服务器运行时：

- **Server: Running** — 绿色勾选图标，描述中显示 uptime，非所有者窗口带 “observer” 标签
- **Stop Server** — 停止图标按钮
- **CDP: Connected** — 插头图标，当前工作区名称
- **Agent** — 状态（idle/running_tool 等）、mode/model
- **Clients** — 已连接浏览器会话数
- **Pending Approvals** — 徽章计数（为 0 时隐藏）
- **Windows** — 已发现的 Cursor 窗口数量及名称
- *（分隔符）*
- **Open Setup Panel** — 齿轮图标
- **Open Web Client** — 外部链接图标
- **Show Logs** — 输出图标

### 服务器停止时：

- **Server: Stopped** — “click to start”
- **Start Server** — 播放图标按钮
- *（分隔符）*
- **Open Setup Panel**、**Open Web Client**、**Show Logs**

在 health 轮询事件和服务器状态变化时刷新。

---

## 8. 设置面板（WebviewPanel）

通过 `cursorRemote.openSetup` 打开的交互式配置向导。在 `ViewColumn.One` 中创建，并设置 `retainContextWhenHidden: true`。

### Networking 标签

- **单选组**：Localhost / LAN / Specific address（Tailscale/自定义）
- 自定义地址文本输入（选择 “Specific address” 时显示）
- **Save & Restart** 按钮 — 更新设置并重启服务器
- Tailscale 文档链接

### Password 区

- 带当前密码的可编辑文本输入
- **Copy** 和 **Save** 按钮
- 显示服务器 URL 供参考

### Telegram 标签

- **Step 1: Create Bot** — 指向 @BotFather 的链接、token 输入（若已设置则显示掩码）
- **Step 2: Create Supergroup** — Topics 和管理员设置说明
- **Step 3: Register** — 显示来自 `telegram-auth.json` 的实际 `/register <token>` 命令，可复制。显示已注册用户和用户名。
- **Step 4: Sync** — 发送 `/sync` 的说明
- **Transport Engine** — 选择 `grammy`（默认）或 `raw`（轻量回退），对应 `cursorRemote.telegram.impl`

### 页脚

- **Open All Settings** 按钮 — 先销毁 webview 面板，再在延迟 tick 上打开过滤为 `@ext:cursor-remote.cursor-remote` 的 VS Code Settings（避免保留的 webview 与设置编辑器冲突导致 Cursor 渲染器冻结）

---

## 9. 启动流程

1. 激活时，扩展注册命令、状态栏、侧栏和设置面板
2. 若 `cursorRemote.webappPassword` 为空，用 `crypto.randomBytes(16)`（base64url）生成一个并写入 VS Code Settings（Global）。密码 **不要** 使用 SecretStorage。
3. 若存在遗留的 `cursorRemote.telegram.botToken` 设置，迁入 SecretStorage 并清空该设置
4. 若 `cursorRemote.autoStart` 为 true，立即启动中继 — 无 license 检查
5. `ServerManager` 探测 `/health`；作为所有者 spawn，或作为观察者附着

---

## 10. 入门 Walkthrough

`contributes.walkthroughs` 条目提供逐步引导流程：

1. **Verify CDP Connection** — `--remote-debugging-port=9222` 说明、启动服务器命令
2. **Configure Networking** — 打开设置面板命令
3. **Set Up Telegram** — 可选，打开设置面板命令
4. **Done** — 摘要及文档链接

---

## 11. 服务端增强

为支持扩展而做的向后兼容改动：

### 11.1 更丰富的 `/health` 端点

返回 `windows`、`activeWindowId`、`mode`、`model`、`chatTabCount`、`pendingApprovalCount`、`generation`、`uptime`、`authRequired`、`sessionValid`、`extractorStatus`、`lastExtractionAt`、`consecutiveExtractionFailures`、`lastExtractionError`。现有客户端会忽略未知字段。

未认证的局域网客户端只收到公开精简体（`ok`、`authRequired`、`sessionValid`）。完整详情需要：未启用密码、有效会话，或来自 `127.0.0.1` 的回环观察者（扩展的 health 轮询）。

### 11.2 密码与密钥

Web 客户端密码是 VS Code Settings 中的 `cursorRemote.webappPassword`。Telegram bot token 仅在 SecretStorage。没有 `LICENSE_KEY` 环境变量，也没有 `data/license.key` 文件。

### 11.3 `DATA_DIR` 环境变量

可配置的数据目录（默认：`./data`）。扩展将其设为 `context.globalStorageUri.fsPath`。

### 11.4 `LOG_FORMAT` 环境变量

设为 `json` 时，向 stdout 发出结构化 JSON 行。

### 11.5 静态资源缓存破坏

`GET /` 动态读取 `index.html`，并在 `app.js` 和 `styles.css` 标签上注入 `?v=<random>` 查询参数。静态文件以 `Cache-Control: no-cache, must-revalidate` 提供。

### 11.6 认证中间件顺序

`/health` 和静态文件在认证中间件之前提供，避免 Web 客户端检查认证状态时出现重定向循环。

### 11.7 grammY 使用原生 fetch

Telegram bot 以 `{ client: { fetch } }` 构造，以使用 Node.js 原生 `fetch` API。grammY 默认 HTTP 客户端（基于 `node:https` / `node-fetch`）在 esbuild 打包的 ESM 环境中会损坏。

### 11.8 优雅关闭 Telegram

服务器关闭时以 3 秒超时等待 `bot.stop()`，确保 long-polling 会话干净关闭，下一个服务器实例可以立即连接。

### 11.9 Telegram 连通性诊断

启动时，服务器用原始 `fetch` 测试到 `api.telegram.org/bot<token>/getMe` 和 `deleteWebhook` 的出站 HTTPS。若不可达，再测试 `google.com`，以区分 Telegram 特定屏蔽和一般网络问题。

---

## 12. 构建与分发

### 12.1 扩展构建

- esbuild 把 `extension/src/extension.ts` 打包为 `dist/extension.cjs`
- 格式：CommonJS，平台：Node，external：`['vscode']`

### 12.2 服务器构建

- esbuild 把 `src/server/index.ts` + 全部 Node.js 依赖打包为 `dist/server/bundle.mjs`
- 格式：ESM，平台：Node
- banner 注入 CJS 兼容 shim（`__dirname`、`__filename`、`createRequire`），供依赖这些全局量的打包包（Express 等）使用
- 扩展包中不需要 `node_modules`

### 12.3 客户端构建

- `tsc` 编译 TypeScript
- `src/client/` 复制到 `dist/client/`
- `socket.io.min.js` 从 `node_modules` 复制到 `dist/client/`

### 12.4 打包

- `npm run package` 先 bump patch 版本，再运行 `vsce package --no-dependencies`
- 输出：`releases/cursor-remote-X.Y.Z.vsix`
- `.vscodeignore` 排除源码与开发文件；包中包含：`dist/extension.cjs`、`dist/server/bundle.mjs`、`dist/client/`、`extension/media/walkthrough/`、`selectors.json`、`package.json`、`README.md`、`CHANGELOG.md`、`LICENSE`

### 12.5 版本 bump

- `npm run package` 通过 `scripts/bump-build.ts` 自动递增 patch 版本（并更新 README / `docs/setup-guide.md` 中的 VSIX 安装命令）
- `npm run release -- patch|minor|major` bump 语义化版本、更新 changelog、创建 git tag

---

## 13. 向后兼容

每项增强都由环境变量门控，默认保持现有行为：

| 环境变量 | 默认（独立运行） | 扩展设置 |
|---|---|---|
| `DATA_DIR` | 未设置 → `./data` | `context.globalStorageUri.fsPath` |
| `LOG_FORMAT` | 未设置 → 纯文本 | `json` |
| `WEBAPP_PASSWORD` | 空 | `cursorRemote.webappPassword`（Settings） |
| `TELEGRAM_BOT_TOKEN` | `.env` | SecretStorage |
| `TELEGRAM_IMPL` | `grammy` | `cursorRemote.telegram.impl` |
| `POLL_INTERVAL_MS` | `300`（`config.ts`） | 设置默认 `500` |
| `DEBOUNCE_MS` | `150`（`config.ts`） | 设置默认 `300` |

独立的 `npm run dev` 和 `npm start` 立即启动（无 license 提示）。`.env` 文件、`data/` 目录和全部 CLI 行为不变，只是去掉了 license 门禁。