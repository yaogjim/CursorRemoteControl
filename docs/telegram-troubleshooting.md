# Telegram 连接故障排除

如果 Telegram bot 连接失败，或在启动时卡住，请按下面的顺序排查。

---

## 1. 查看日志

启动 CursorRemote 后，留意这些日志行：

| 日志行 | 含义 |
|---|---|
| `[telegram] API reachable — bot: @yourbot` | Telegram API 可达，且 token 有效 |
| `[telegram] Bot connected (sync: on/off)` | Bot 已完全运行 — 一切正常 |
| `[telegram] bot.init() failed: timed out after 15s` | Grammy 的 HTTP 层在调用 `getMe` 时超时 |
| `[telegram] 409 Conflict — another bot instance…` | 有两个进程在使用同一个 bot token |
| `[telegram] Invalid bot token (401 Unauthorized)` | 来自 BotFather 的 token 错误或已被撤销 |

如果日志停在 **“API reachable” 之后**、**“Bot connected” 之前**，问题出在 bot 框架启动阶段。见第 3 节。

---

## 2. 常见问题

### Bot token 无效

- 在 Telegram 中打开 [@BotFather](https://t.me/BotFather)。
- 发送 `/mybots` → 选择你的 bot → **API Token**，查看当前 token。
- 如果撤销并重新生成了 token，请通过 **设置面板**（扩展；token 存在 SecretStorage，而不是 `settings.json`）或 `.env` 中的 `TELEGRAM_BOT_TOKEN`（独立运行）更新。不要把 token 再写回 `cursorRemote.telegram.botToken` — 该设置已弃用，激活时会自动迁走。

### 另一个实例正在 polling

每个 bot token 只允许 **一个** long-polling 连接。如果看到 `409 Conflict`：

- 停掉所有使用同一 token 的其他 CursorRemote 服务器。
- 如果刚重启过，旧进程没有干净退出，等待 30–60 秒让 Telegram 释放会话，然后重试。
- macOS：在 Activity Monitor 中检查残留的 `node` 进程。
- Linux/WSL：`ps aux | grep cursor-remote` 或 `lsof -i :3000`。

### 网络 / 防火墙

如果 `getMe` 反复超时失败：

- 确认出站 HTTPS 可用：`curl https://api.telegram.org/bot<TOKEN>/getMe`
- 公司代理和 VPN 有时会屏蔽 Telegram 的 API 域名。换一个网络试试。
- WSL2 用户：WSL 虚拟网络使用 NAT。出站 HTTPS 通常可用，但部分公司防火墙对 WSL 流量的过滤方式不同。

### 限流

如果短时间内反复启动和停止 bot，Telegram 可能对该 token 限流。等待 1–2 分钟再试。

---

## 3. Grammy 启动时卡住

**症状：** 日志显示 `"Initializing bot (getMe via Grammy)…"`，然后要么 15 秒后超时，要么一直挂起。

**原因：** Grammy 内部 HTTP 客户端在部分系统上会卡住（在 macOS 上观察到过）。默认 CursorRemote 构建给 Grammy 的 `fetch` 包了 30 秒超时，所以最终应该超时而不是永远挂起。但如果一直超时：

### 切换到 Raw 传输层

**Raw** 传输层完全绕过 Grammy，用 Node.js 内置 `fetch` 直接调用 Telegram Bot API。功能相同，但避开 Grammy 的 HTTP 栈。

**选项 A — 设置面板：**

1. 打开 CursorRemote 设置面板（`Cmd/Ctrl+Shift+P` → “CursorRemote: Open Setup”）。
2. 进入 **Telegram** 标签。
3. 向下滚动到 **Transport Engine**。
4. 选择 **Raw (lightweight fallback)**，点击 **Save & Restart**。

**选项 B — VS Code Settings：**

1. 打开 Settings（`Cmd/Ctrl+,`）。
2. 搜索 `cursorRemote.telegram.impl`。
3. 把值改成 `raw`。
4. 重启服务器（CursorRemote: Restart Server）。

**选项 C — 环境变量：**

在 `.env` 中加入：

```
TELEGRAM_IMPL=raw
```

切换后，日志应显示：

```
[telegram] Using raw Bot API transport (no Grammy)
[telegram-raw] Bot: @yourbot (id 123456789)
[telegram-raw] Bot connected (sync: on)
```

---

## 4. Bot 已连接但不响应命令

- 确认你已经 **注册**。先在 Telegram 群里发送 `/register <token>`。
- Bot 会忽略未注册用户的消息（不报错、不回复 — 这是安全设计）。
- 确认 bot 是群 **管理员**，并拥有 **Manage Topics** 权限。
- 如果使用启用了 Topics 的超级群组，bot 需要管理员权限才能在话题中发帖。

---

## 5. `/sync` 之后没有创建话题

- 群必须 **启用 Topics**（Group Settings → Topics）。
- Bot 必须是拥有 **Manage Topics** 权限的 **管理员**。
- `/sync` 之后等几秒。创建话题有延迟，以避免触发限流。
- 如果话题仍不出现，先用 `/purge` 清掉陈旧状态，再重新 `/sync`。

---

## 6. 仍然卡住？

1. 设置 `TELEGRAM_IMPL=raw`，排除 Grammy 问题。
2. 检查完整服务器输出中的 `[ERROR]` 行。
3. 用 BotFather 发一个全新的 bot token 再试。
4. 在 [github.com/len5ky/CursorRemote](https://github.com/len5ky/CursorRemote/issues) 开 issue，并附上相关日志。