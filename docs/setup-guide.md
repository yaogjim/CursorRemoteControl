# 安装指南 — CursorRemote

## 1. 在 Cursor IDE 上启用 CDP

无论使用扩展还是独立运行，都必须以启用 Chrome DevTools Protocol 远程调试端口的方式启动 Cursor。

### Windows：快捷方式（推荐）

1. 右键桌面上的 Cursor 快捷方式 > 属性
2. 在「目标」末尾追加 ` --remote-debugging-port=9222`
3. 点击确定

### macOS

```bash
open -a Cursor --args --remote-debugging-port=9222
```

或在 shell 配置中创建别名：

```bash
alias cursor='open -a Cursor --args --remote-debugging-port=9222'
```

### Linux

```bash
cursor --remote-debugging-port=9222
```

### 重要

添加该参数后必须 **完全退出并重启 Cursor**。在 macOS 上使用 Cmd+Q（不要只关窗口）— 否则 Cursor 会继续在后台运行。

### 验证

在浏览器中打开 `http://localhost:9222/json`。应看到一个 JSON 数组。如果不行，确认 Cursor 已经完全重启。

---

## 2A. 扩展安装（推荐）

CursorRemote 扩展提供最简单的安装体验：内置状态 UI、自动启动和配置向导。

### 安装

从 [releases](https://github.com/len5ky/CursorRemote/releases) 下载最新 `.vsix` 并安装：

```bash
cursor --install-extension cursor-remote-0.1.59.vsix
```

或在 Cursor 中：命令面板（`Ctrl+Shift+P`）> **Extensions: Install from VSIX...** > 选择该文件。

### 服务器生命周期

无需 license key 或激活步骤。若 `cursorRemote.autoStart` 为 `true`，Cursor 启动时服务器会自动启动。侧栏面板显示实时状态：

- **Server: Running / Stopped** — 带 Start 和 Stop 按钮
- **CDP: Connected** — 带当前工作区名称
- **Agent status** — 当前 mode 和 model
- **Clients** — 已连接的浏览器会话数

也可以使用命令面板命令：**CursorRemote: Start Server**、**CursorRemote: Stop Server**。

### 网络与密码

运行 **CursorRemote: Open Setup Panel** 进行配置：

1. **Server Bind Address** — 选择 Localhost（127.0.0.1）、LAN（0.0.0.0），或用于 Tailscale 的特定 IP
2. **Web Client Password** — 首次安装时自动生成，并保存在 VS Code Settings（`cursorRemote.webappPassword`），不是 SecretStorage。可从设置面板复制，或在 Settings 中查找。可以直接编辑。
3. 点击 **Save & Restart** 使更改生效。

在手机、平板或另一台电脑的任意浏览器中打开 `http://<server-ip>:<port>`。

### Web 客户端 — 代码与 diff

助手 **代码** 和文件编辑 **diff** 不会复制 Cursor 的 Monaco HTML。中继发送结构化的 **`codeBlocks`** / **`diffBlock`**；UI 显示紧凑卡片（卡片内约 **七行** 可滚动，iOS 上有惯性滚动）。点 **expand** 控件打开 **全屏** 阅读器（大号关闭控件，点外部或按 Escape 关闭）。这样长补丁在小屏幕上可读，又不会占满整个聊天。

### Web 客户端 — plan widget 与连接状态

Web 应用中的 plan widget 更接近远程控制流程：

- **View Plan** 打开 Web 模态框，并在可用时加载完整的已保存计划文件，而不只是紧凑 widget 摘要。
- **Plan model** 打开 Web 选择器，选项来自 Cursor 实际刮取的模型列表，再把所选选项应用回 Cursor。
- **Build** 仍直接触发底层 Cursor 操作。

连接标签也更具体。如果手机仍连着中继，但 Cursor/CDP 提取停滞，UI 会显示 waiting/extractor 状态，而不是笼统的浏览器断开。这在 macOS 上尤其有用：后台 Cursor 窗口会节流 CDP evaluation。

### Telegram（扩展）

在设置面板切换到 **Telegram** 标签，按向导逐步操作：

1. **Create a bot** — 粘贴来自 @BotFather 的 token。扩展把它存入 SecretStorage（不是 settings.json）。
2. **Create a supergroup** — 启用 Topics，把 bot 加为管理员
3. **Register** — 面板会显示可复制的实际 `/register <token>` 命令
4. **Sync** — 在群里发送 `/sync`

面板还会显示已注册用户及其用户名。

若 Grammy 在启动时卡住，可在同一标签的 **Transport Engine** 中把 `cursorRemote.telegram.impl` 设为 `raw`。详见 [Telegram 故障排除](telegram-troubleshooting.md)。

### 多窗口行为

两个独立层次：

**扩展进程（单例）：** 所有 Cursor 窗口只运行一个中继进程。

- 第一个启动的窗口成为 **所有者（owner）** 并拉起服务器进程。
- 其他窗口通过 health 轮询发现正在运行的服务器，并以 **观察者（observer）** 身份附着。
- 若所有者窗口关闭，观察者会自动接管并拉起新服务器。
- 当窗口不是所有者时，侧栏会在服务器状态旁显示 “observer”。

**CDP 监视（中继内部）：** **主窗口（home）** 保持长连接 CDP，并持续轮询。其他 Cursor 窗口每 10s 通过临时 CDP 连接并行轮询（不会切换 Cursor 的焦点窗口）。

---

## 2B. 独立安装（不使用扩展）

直接从命令行运行中继服务器。适用于无头机器、远程服务器，或通过 `.env` 手动配置。

### 安装

```bash
git clone https://github.com/len5ky/CursorRemote.git cursor-ide-remote
cd cursor-ide-remote
npm install
cp .env.example .env
```

编辑 `.env` — 默认值即可用于 Web 客户端。若要使用 Telegram，设置 `TELEGRAM_ENABLED=true` 和 `TELEGRAM_BOT_TOKEN`（见第 4 节）。

`.env.example` 中的 `POLL_INTERVAL_MS=500` 与 `DEBOUNCE_MS=300` 与扩展设置默认值一致。若不设置这两项，`config.ts` 的回退默认值分别是 `300` 和 `150`。

### 启动服务器

```bash
npm run dev
```

服务器立即启动 — 没有 license 提示。`scripts/dev-wrapper.ts` 会对 `src/server/index.ts` 启动 `tsx watch`。

```
[main] CDP URL: http://127.0.0.1:9222
[main] Server: http://127.0.0.1:3000
[telegram] Bot connected (sync: off, users: 0)
[telegram] To register, send: /register A1B2C3D4
```

---

## 3. 网络访问

> **扩展用户：** 设置面板几下点击即可完成网络配置。下面的手动说明主要面向独立运行或 WSL2 特定配置。

### 默认：仅 localhost

默认服务器绑定 `127.0.0.1`，只有本机浏览器能访问。

### 局域网访问

把绑定地址设为 `0.0.0.0`：

- **扩展：** 打开设置面板 > Networking > 选择 “LAN access (all interfaces)” > Save & Restart
- **独立运行：** 在 `.env` 中设置 `SERVER_HOST=0.0.0.0`

然后在手机上打开 `http://<your-ip>:<port>`。需要密码。

### WSL2 特定说明

如果在 WSL2 上运行，服务器与局域网隔离。需要以下之一：

#### 选项 A：Mirrored Networking（推荐）

在 Windows 的 `%UserProfile%\.wslconfig` 中加入：

```ini
[wsl2]
networkingMode=mirrored
```

重启 WSL2：`wsl --shutdown`

#### 选项 B：端口转发

```powershell
# 查找 WSL2 IP
wsl hostname -I
# 转发端口（以管理员身份运行 PowerShell）
netsh interface portproxy add v4tov4 listenport=3000 listenaddress=0.0.0.0 connectport=3000 connectaddress=<WSL2-IP>
```

#### Windows 防火墙

```powershell
New-NetFirewallRule -DisplayName "CursorRemote" -Direction Inbound -LocalPort 3000 -Protocol TCP -Action Allow
```

### 安全远程访问

**Tailscale（推荐）** — 通过私有 VPN 访问，无需端口转发。见 [Tailscale 安装](tailscale-setup.md)。

**密码保护** — 在设置面板中设置密码（扩展；存为 Settings 中的 `cursorRemote.webappPassword`，不是 SecretStorage），或在 `.env` 中设置 `WEBAPP_PASSWORD`（独立运行）。登录按 IP 限流为每分钟 10 次。

两者可以组合。详见 [Tailscale 安装](tailscale-setup.md)。

---

## 4. Telegram 集成（可选）

> **扩展用户：** 设置面板的 Telegram 标签提供逐步向导。下面覆盖手动流程。

### 4.1 创建 Bot

1. 在 Telegram 给 `@BotFather` 发消息 > `/newbot` > 按提示操作
2. 复制 **bot token**
3. **关闭隐私模式**：`@BotFather` > `/mybots` > Bot Settings > Group Privacy > **Turn OFF**

### 4.2 配置

**扩展：** 打开设置面板 > Telegram 标签 > 粘贴 bot token > Save Token。token 存在 SecretStorage（不是 `settings.json`）。扩展会自动启用 Telegram。

**独立运行：** 编辑 `.env`：

```bash
TELEGRAM_ENABLED=true
TELEGRAM_BOT_TOKEN=7123456789:AAHxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

若 Grammy 启动卡住，再加 `TELEGRAM_IMPL=raw`。见 [Telegram 故障排除](telegram-troubleshooting.md)。

### 4.3 启动服务器

服务器启动时会打印注册 token：

- **扩展：** 查看 Output 面板（CursorRemote 通道）或设置面板的 Telegram 标签
- **独立运行：** 查看终端输出

```
[telegram] To register, send in your Telegram group: /register A1B2C3D4
```

注册 token 由 `randomBytes(16).toString('hex')` 生成（32 位十六进制），上面的 `A1B2C3D4` 只是示例。

### 4.4 设置群组

1. 创建一个 Telegram 群
2. 把 bot 加进群
3. **启用 Topics**：Group Settings > Topics > Enable
4. **把 bot 设为管理员**：Group Settings > Administrators > 添加 bot 并授予全部权限（尤其是 Manage Topics、Delete Messages）

### 4.5 注册与同步

在 Telegram 群中：

1. `/register A1B2C3D4` — 用服务器输出中的 token 注册自己
2. `/sync` — 为该群启用自动同步

Bot 会检查权限，并为当前所有窗口创建话题。此后新聊天 tab 会自动获得话题。

### 4.6 Bot 命令

| 命令 | 说明 |
|---------|-------------|
| `/register <token>` | 用服务器输出中显示的 token 注册 |
| `/sync` | 启用自动同步（活动 tab + 最近 5 条消息） |
| `/sync_all` | 为所有窗口中的 **全部** tab 创建话题 |
| `/unsync` | 关闭同步，删除已跟踪话题，清空状态 |
| `/cleanup` | 删除陈旧/未跟踪话题，保留活动的 |
| `/dedupe` | 合并重复话题（同一项目、WSL/非 WSL 变体、同一 `composerId`） |
| `/resync [窗口名]` | 把当前话题重新绑定到 Cursor 当前活动窗口/tab（可选按窗口名匹配） |
| `/purge` | 删除 **全部** 话题（后台运行） |
| `/status` | 同步状态、连接、agent 信息、群 ID |
| `/history [N]` | 最近 N 条消息（默认 5）。`/history 100` 可取更多 |
| `/mode` | 显示/切换 mode（Agent/Plan/Ask/Debug） |
| `/model` | 显示当前模型，并用内联键盘切换（选项来自 Cursor 现场菜单） |
| `/plan <text>` | 在 Plan mode 下发提示 |
| `/agent <text>` | 在 Agent mode 下发提示 |

任意话题中的 **纯文本** 会转发到映射的 Cursor agent。

### 4.7 工作原理

- **Window Monitor** 在 **主窗口（home）** 上保持长连接 CDP，并用 **并行 CDP 连接** 每 10s 轮询其他 Cursor 窗口（不会 visibly 切换窗口）
- 新消息/变更消息格式化为 Telegram HTML，并发送到匹配的话题
- 若 HTML 失败（不支持的标签），消息会以纯文本重试
- **限流发送队列** 防止 429 错误（Telegram 发送间隔约 300ms，编辑间隔 100ms；见 `send-queue.ts` / 传输层配置）
- **`data/` 中的数据文件**（均已 gitignore）：
  - `telegram-auth.json` — 注册 token + 带用户名的已注册用户
  - `telegram-sync.json` — 同步状态和群 ID
  - `telegram-topics.json` — 话题映射及 high water mark
  - `telegram-messages.json` — 已跟踪的 message ID
  - `telegram-activity.json` — 短暂活动消息 ID，供重启后清理

### 4.8 身份验证

**选项 A：基于 token（默认）**

把注册 token（显示在服务器输出中）分享给协作者。每人运行一次 `/register <token>`。用户名和 ID 会保存到 `data/telegram-auth.json`。

**选项 B：硬编码（覆盖）**

在 `.env` 中设置 `TELEGRAM_ALLOWED_USERS=123456789,987654321`（独立运行），或在 Settings 中设置 `cursorRemote.telegram.allowedUsers`（扩展）。一旦设置，将 **覆盖** token 认证 — 只有这些用户 ID 能使用 bot。删除该设置即可回到基于 token 的认证。

---

## 5. 生产环境（独立运行）

### 选项 A：tmux

```bash
tmux new -s cursor-remote
npm run dev
# Ctrl+B D 以分离
```

### 选项 B：编译后运行

```bash
npm run build
npm start
```

不需要 license 文件。进程启动方式与 `npm run dev` 相同，只是没有交互式 watcher。`npm start` 会创建 `temp/` 和 `data/` 目录。

---

## 6. 故障排除

### 通用

#### 服务器立即退出

- 查看 Output 面板（扩展）或终端（独立运行）中的真实错误
- 确认 Node.js 20+，且端口 3000（或你的 `SERVER_PORT`）空闲
- 没有 license 门禁；缺少 license key 不是有效的失败原因

#### Web UI 显示 “Disconnected”

- 先从手机或平板检查 `http://<server>:<port>/health`
- `connected: false` 表示中继尚未附着到 Cursor/CDP
- `connected: true` 且 `extractorStatus: "waiting"` 表示中继已附着到 Cursor，但仍在等待第一次 DOM 快照
- `connected: true` 且 `extractorStatus: "stale"` 表示 Cursor/CDP 仍连接，但 DOM 提取失败或被后台节流
- `lastExtractionError` 显示最近一次提取失败原因

未认证的局域网客户端只会看到精简的 `/health`（`ok`、`authRequired`、`sessionValid`）。完整字段需要本机回环、有效会话，或未启用密码。

#### macOS：Cursor 进入后台后手机停止更新

- 在 macOS 上，Electron/Chromium 可能把后台 Cursor 窗口节流到 `Runtime.evaluate` 超时
- 若 `/health` 显示 `connected: true` 且 `extractorStatus: "stale"`，把 Cursor 拉回前台，等待下一次成功快照
- 中继会对重复的提取超时退避，而不是持续猛打 CDP

#### 手机/平板连不上

- 从另一台设备执行 `curl http://<ip>:<port>/health`
- 检查防火墙、端口转发、WSL2 网络
- 确认服务器绑定到 `0.0.0.0` 或你的特定 IP（不是 `127.0.0.1`）

#### 较旧的移动浏览器显示空白或损坏的 UI

- 近期构建不再要求浏览器支持 `crypto.randomUUID()`
- 若页面仍无法加载，打开浏览器控制台，检查其他不支持的 Web API
- 在测试较旧的 iOS/Android 浏览器前，先升级到最新 CursorRemote 构建

### 扩展特定

#### 侧栏显示服务器 “Disconnected”

- 打开 Output 面板（**CursorRemote: Show Logs**）并检查错误
- 尝试侧栏按钮 Stop > Start
- 验证 CDP 已启用：`http://localhost:9222/json` 应返回 JSON

#### 多个 Cursor 窗口

- 只运行一个 **服务器进程**。第一个窗口是所有者；其他是观察者。
- 非所有者窗口的侧栏会在服务器状态旁显示 “observer”。
- 若所有者窗口关闭，观察者会在约 15 秒内自动恢复。
- 在中继内部，**主窗口（home）** 使用长连接 CDP；其他 IDE 窗口每 10s 并行轮询。

#### Telegram bot 不响应

- 查看 Output 面板中的连通性消息
- 服务器启动时会测试出站 HTTPS，并报告 Telegram API 或全部 HTTPS 是否不可达
- 确保没有其他 bot 实例在使用同一 token
- 注册 token 显示在 Output 面板和设置面板的 Telegram 标签中

更多内容见 [Telegram 故障排除](telegram-troubleshooting.md)。

### 独立运行特定

#### Bot 不响应

- `.env` 中是否有 `TELEGRAM_ENABLED=true`？
- Bot 是否是拥有 Manage Topics 权限的管理员？
- 隐私模式是否关闭？（`@BotFather` > Bot Settings > Group Privacy）
- 是否用正确的 token 执行了 `/register`？
- 查看 `temp/server.log` 中的错误

#### /sync 提示 “not a supergroup” 或 “not a forum”

- 先在 Group Settings 中启用 Topics（会自动转换为超级群组）
- Bot 会从 `/sync` 自动检测正确的群 ID

#### /sync 提示 “missing permissions”

- 到 Group Settings > Administrators > Bot > 启用列出的全部权限
- 必需：Manage Topics、Delete Messages

#### 在 macOS 上构建不工作

- `npm run build` 编译 TS，并把 `src/client/` 复制到 `dist/client/`
- `npm start` 会自动创建 `temp/` 目录

#### 服务器日志

所有带时间戳的输出：`temp/server.log`