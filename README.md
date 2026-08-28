# CursorRemote

远程控制你本地的 Cursor AI 智能体——在 Cursor 运行在你的机器上时，通过手机、平板或其他电脑的浏览器，或通过 Telegram 监控会话、批准步骤、检查完整计划并发送任务。

<div align="center">

| 移动端 Web 应用 | Telegram |
|:-:|:-:|
| <img src="media/web-app.gif" alt="移动端 Web 应用" width="300"> | <img src="media/telegram.gif" alt="Telegram 集成" width="300"> |

<p><b>扩展 UI</b> — CursorRemote 侧边栏：服务器状态、CDP 连接、智能体状态和启动/停止控制</p>
<img src="media/extension_tab.png" alt="CursorRemote 扩展侧边栏，显示服务器控制和状态" width="380">

</div>

## 功能特性

- **移动端 Web 客户端** -- 实时聊天视图，采用 Cursor 暗色主题，批准/拒绝按钮，完整计划模态框，计划模型选择器，运行命令卡片，模式/模型切换
- **上下文栏 + 抽屉导航** -- 顶部面包屑显示「窗口 › 会话」，点击弹出抽屉面板统一列出所有窗口及其会话，点按即可切换窗口/会话（0.1.54 新增）
- **Telegram 集成** -- 自动同步对话到论坛主题，通过内联按钮批准，从任何设备发送提示
- **多窗口监控** -- 主窗口保持持久 CDP 连接；其他窗口每 10 秒并行轮询一次（无需切换 Cursor UI）
- **自动创建主题** -- 新的聊天标签页自动创建对应的 Telegram 主题
- **VS Code 扩展** -- 集成侧边栏，显示服务器状态、启动/停止控制、设置向导和配置
- **持久化状态** -- 消息、主题、同步和认证在服务器重启后全部保留

## 工作原理

```
┌─────────────────────────────────────────────────────────────────┐
│  Cursor 扩展（可选）                                              │
│  启动服务器，提供 UI，管理生命周期                                  │
│                                                                 │
│  Cursor IDE  ──CDP──>  中继服务器  ──socket.io──>  浏览器         │
│  (Windows/Mac)          (Node.js)     ──Bot API───>  Telegram   │
└─────────────────────────────────────────────────────────────────┘
```

1. **Cursor IDE** 启用 Chrome DevTools 协议运行 (`--remote-debugging-port=9222`)
2. **中继服务器** 通过 CDP 连接，从 DOM 提取智能体聊天状态
3. **窗口监控器** 在主窗口保持长连接的 CDP 连接，每 10 秒并行轮询其他窗口
4. **浏览器客户端** 在任何设备上实时显示对话
5. **Telegram 机器人**（可选）将数据镜像到自动创建的论坛主题

## 我应该使用哪种设置方式？

| | 扩展（推荐） | 独立服务器 |
|---|---|---|
| **适用于** | 开发机器的日常使用 | 无头服务器、CI 或手动配置 |
| **安装** | 单个 `.vsix` 文件 | 克隆仓库 + `npm install` |
| **配置** | VS Code 设置 + 设置面板 | `.env` 文件 |
| **服务器生命周期** | 自动启动，侧边栏启动/停止 | 手动 `npm run dev` 或 `npm start` |
| **状态 UI** | 侧边栏面板显示实时状态 | 终端日志 + `/health` 端点 |
| **密码** | 首次安装时自动生成 | 手动在 `.env` 中配置 |
| **多窗口** | 单例 — 所有窗口共用一个服务器 | 单进程 |

---

## 设置 A：扩展（推荐）

### 1. 安装扩展

从 [releases](https://github.com/yaogjim/CursorRemoteControl/releases) 下载最新的 `.vsix` 文件，然后安装：

```bash
# 从命令行安装
cursor --install-extension cursor-remote-0.1.54.vsix
```

或在 Cursor 中：打开命令面板（`Ctrl+Shift+P`），运行 **Extensions: Install from VSIX...**，然后选择文件。

### 2. 启用 CDP 并启动 Cursor

在 Cursor 快捷方式中添加 `--remote-debugging-port=9222`，或运行：

```powershell
# Windows
& "$env:LOCALAPPDATA\Programs\cursor\Cursor.exe" --remote-debugging-port=9222
```

```bash
# macOS
open -a Cursor --args --remote-debugging-port=9222
```

```bash
# Linux
cursor --remote-debugging-port=9222
```

**重要提示：** 添加标志后完全退出并重启 Cursor。在 macOS 上使用 Cmd+Q（不只是关闭窗口）。验证：`http://localhost:9222/json` 应返回 JSON。

### 3. 服务器自动启动

无需许可证密钥、购买或激活步骤。安装后，扩展会在 Cursor 启动时启动中继服务器（`cursorRemote.autoStart` 默认为 `true`）。查看 **CursorRemote** 侧边栏面板的实时状态：

- **服务器状态** -- 运行中 / 已停止 / 已断开
- **CDP 连接** -- 已连接 / 已断开，显示活动工作区名称
- **智能体状态** -- 空闲、运行工具等，显示当前模式和模型
- **已连接客户端** -- 浏览器会话数量
- **启动 / 停止按钮** -- 直接从侧边栏控制服务器

如果没有自动启动，点击侧边栏中的 **Start Server** 或从命令面板运行 **CursorRemote: Start Server**。

### 4. 配置网络并连接

运行 **CursorRemote: Open Setup Panel**（或点击侧边栏中的 **Open Setup Panel**）进行配置：

- **网络** -- 选择 Localhost（默认）、LAN（所有接口）或特定 IP（Tailscale）
- **Web 客户端密码** -- 首次安装时自动生成并存储在 VS Code 设置中（`cursorRemote.webappPassword`，不在 SecretStorage 中）；复制它或设置自己的密码
- **Telegram** -- 分步向导，包含机器人令牌输入、注册令牌显示和用户状态

在手机、平板或其他电脑的任何浏览器中打开 `http://<server-ip>:<port>` 并输入密码。

> **多窗口：** 所有 Cursor 窗口只运行一个服务器**进程**（所有者/观察者）。在中继内部，主窗口保持长连接的 CDP 连接；其他 IDE 窗口每 10 秒并行轮询一次。

### 扩展命令

| 命令 | 描述 |
|---------|-------------|
| `CursorRemote: Start Server` | 启动中继服务器 |
| `CursorRemote: Stop Server` | 停止中继服务器 |
| `CursorRemote: Restart Server` | 重启中继服务器 |
| `CursorRemote: Open Web Client` | 打开浏览器客户端 URL |
| `CursorRemote: Open Setup Panel` | 打开网络和 Telegram 设置向导 |
| `CursorRemote: Show Logs` | 在输出面板中显示服务器日志 |

### 扩展设置

所有设置都在 VS Code 设置的 `cursorRemote.*` 下。每个设置都包含内联文档和相关指南的链接。

| 设置 | 默认值 | 描述 |
|---------|---------|-------------|
| `autoStart` | `true` | 启动时自动启动服务器 |
| `cdpUrl` | `http://127.0.0.1:9222` | Cursor 的 CDP 端点 |
| `serverPort` | `3000` | Web 服务器端口 |
| `serverHost` | `127.0.0.1` | 绑定地址（默认仅本地主机） |
| `pollIntervalMs` | `500` | 主窗口 DOM 轮询频率（毫秒）。扩展设置默认值；作为 `POLL_INTERVAL_MS` 传递。 |
| `debounceMs` | `300` | 广播间隔（毫秒）。扩展设置默认值；作为 `DEBOUNCE_MS` 传递。 |
| `logLevel` | `info` | 服务器日志级别 |
| `webappPassword` | *（自动生成）* | Web 客户端密码（VS Code 设置，不在 SecretStorage 中） |
| `windowTitleQualifier` | `true` | 在标题中包含远程限定符 |
| `telegram.enabled` | `false` | 启用 Telegram 机器人 |
| `telegram.botToken` | -- | 已弃用的 settings.json 字段。机器人令牌通过设置面板存储在 VS Code SecretStorage 中。 |
| `telegram.allowedUsers` | -- | 逗号分隔的允许用户 ID |

---

## 设置 B：独立服务器（不使用扩展）

直接从命令行运行中继服务器——适用于无头机器、远程服务器，或者你更喜欢通过 `.env` 文件管理配置。

### 前置要求

- Node.js 20+
- 启用 `--remote-debugging-port=9222` 的 Cursor IDE
- 同一网络上的浏览器（用于 Web 客户端）

### 安装和运行

```bash
git clone https://github.com/yaogjim/CursorRemoteControl.git cursor-ide-remote
cd cursor-ide-remote
npm install
cp .env.example .env
npm run dev
```

服务器立即启动——没有许可证提示。`scripts/dev-wrapper.ts` 在 `src/server/index.ts` 上启动 `tsx watch`。

编辑 `.env` 配置服务器。对于 Telegram，设置 `TELEGRAM_ENABLED=true` 和 `TELEGRAM_BOT_TOKEN`。

### 独立配置

| 变量 | 默认值 | 描述 |
|----------|---------|-------------|
| `CDP_URL` | `http://127.0.0.1:9222` | Cursor 的 CDP 端点 |
| `SERVER_PORT` | `3000` | Web 服务器端口 |
| `SERVER_HOST` | `127.0.0.1` | 绑定地址 |
| `POLL_INTERVAL_MS` | `300` | 主窗口 DOM 轮询频率（毫秒）。来自 `config.ts`。扩展设置默认值为 `500`。 |
| `DEBOUNCE_MS` | `150` | 最小广播间隔（毫秒）。来自 `config.ts`。扩展设置默认值为 `300`。 |
| `LOG_LEVEL` | `info` | 日志级别 |
| `WEBAPP_PASSWORD` | -- | Web UI 密码 |
| `TELEGRAM_ENABLED` | `false` | 启用 Telegram 机器人 |
| `TELEGRAM_BOT_TOKEN` | -- | 来自 @BotFather 的机器人令牌 |
| `TELEGRAM_ALLOWED_USERS` | -- | 逗号分隔的允许用户 ID |
| `DATA_DIR` | `./data` | 持久化状态的数据目录 |
| `LOG_FORMAT` | `text` | 设置为 `json` 以获得结构化日志行 |

### 生产环境

```bash
npm run build
npm start
```

> **WSL2 用户**：有关端口转发详细信息，请参阅[设置指南](docs/setup-guide.md)。

---

## 安全性

CursorRemote 开箱即用提供安全默认设置：

- **仅本地主机** -- 服务器默认绑定到 `127.0.0.1`，因此在你明确选择之前永远不会暴露到网络。
- **自动生成密码**（扩展）-- 首次安装时创建加密随机密码（`crypto.randomBytes(16)` 作为 base64url），并存储在 VS Code 设置中作为 `cursorRemote.webappPassword`。它**不**存储在 SecretStorage 中。
- **Telegram 机器人令牌**（扩展）-- 通过设置面板存储在 VS Code 的加密 SecretStorage 中。旧版 `cursorRemote.telegram.botToken` 设置会在激活时自动迁移然后清除。

### 从其他设备访问

**选项 A：Tailscale（推荐）** -- 在你的电脑和手机上安装 [Tailscale](https://tailscale.com/)。你的服务器可以通过私有 WireGuard 网格访问，无需端口转发。参阅 [Tailscale 设置指南](docs/tailscale-setup.md)。

**选项 B：LAN 访问** -- 打开 **Setup Panel**（扩展）或设置 `SERVER_HOST=0.0.0.0`（独立）。服务器绑定到所有接口并需要密码。

两个选项可以结合使用以实现深度防御。

## 隐私

CursorRemote 是 **100% 自托管**的。没有回传、没有遥测、没有分析、没有使用跟踪。软件永远不会连接到供应商服务器进行许可或激活——启动时不会，使用期间也不会。你的代码、对话和智能体活动都保留在你的机器和网络上。

## Telegram 设置

设置 Telegram 最简单的方法是通过 **Setup Panel** —— 运行 **CursorRemote: Open Setup Panel** 并切换到 Telegram 选项卡，获取分步向导，显示你的注册令牌和已注册用户。

### 手动设置

1. **创建机器人**：给 `@BotFather` 发消息 > `/newbot` > 复制令牌
2. **配置**：打开设置面板并粘贴令牌（扩展；存储在 SecretStorage 中）或在 `.env` 中设置 `TELEGRAM_BOT_TOKEN`（独立），并启用 Telegram
3. **创建群组**：创建一个启用主题的 Telegram 超级群组，将机器人添加为管理员并授予管理主题权限
4. **注册**：启动服务器，检查输出面板（扩展）或终端（独立）以获取注册令牌，在群组中发送 `/register <token>`
5. **同步**：发送 `/sync` 启用自动同步。每个窗口 + 聊天标签页都会自动创建主题。

### 机器人命令

| 命令 | 描述 |
|---------|-------------|
| `/register <token>` | 注册自己（令牌显示在服务器输出中） |
| `/sync` | 启用自动同步（活动标签页获得主题 + 最近 5 条消息） |
| `/sync_all` | 为所有窗口中的所有标签页创建主题 |
| `/unsync` | 禁用同步，删除跟踪的主题 |
| `/cleanup` | 删除过期/未跟踪的主题 |
| `/purge` | 删除所有主题（核武器级，后台运行） |
| `/status` | 连接、同步、群组 ID、智能体信息 |
| `/history [N]` | 最近 N 条消息（默认 5），滚动聊天以加载更多 |
| `/mode` | 显示/切换智能体模式（切换到主题的窗口） |
| `/model` | 显示当前模型 |
| `/plan <text>` | 在 Plan 模式下提示 |
| `/agent <text>` | 在 Agent 模式下提示 |

任何主题中的纯文本都会作为提示发送到映射的 Cursor 智能体。

## 脚本命令

| 命令 | 描述 |
|---------|-------------|
| `npm run dev` | 带热重载的开发模式（立即启动；没有许可证提示） |
| `npm run build` | 编译 TS + 复制客户端 |
| `npm run build:ext` | 打包 VS Code 扩展 |
| `npm run watch:ext` | 扩展开发的监视模式 |
| `npm run package` | 碰撞补丁版本号并将 .vsix 打包到 `releases/` |
| `npm run release -- patch\|minor\|major` | 碰撞版本号，更新变更日志，创建 git 标签 |
| `npm start` | 运行编译后的服务器 |
| `npm run discover` | DOM 发现工具 |

## 文档

- [设置指南](docs/setup-guide.md) -- 安装、网络、Telegram、故障排除
- [Tailscale 设置](docs/tailscale-setup.md) -- 安全远程访问，无需暴露到互联网
- [产品需求](docs/prd.md) -- 功能、状态模型、协议
- [架构](docs/architecture.md) -- 组件、数据流、决策
- [Telegram PRD](docs/telegram_prd.md) -- 消息格式、命令
- [Telegram 架构](docs/telegram_architecture.md) -- 多窗口、队列、生命周期
- [扩展 PRD](docs/extension_prd.md) -- VS Code 扩展功能、设置、构建