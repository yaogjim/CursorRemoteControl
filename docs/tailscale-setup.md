# 使用 Tailscale 安全访问

> **扩展用户：** 打开设置面板（`CursorRemote: Open Setup Panel`），在 Networking 下选择 **Specific address (Tailscale / custom)**。填入 Tailscale IP，点击 **Save & Restart** 即可。下文覆盖完整的手动配置步骤。

Tailscale 在你的设备之间建立私有 mesh VPN。不必把 3000 端口暴露到局域网（或公网），而是通过只有你自己设备能到达的 Tailscale IP 访问 Web 应用。无需端口转发、防火墙规则或 DNS 配置。

## 为什么用 Tailscale

- **零暴露** — 中继服务器从公网完全不可达
- **跨网络可用** — 手机用蜂窝网络、笔记本在咖啡店都能访问
- **无需端口转发** — 对 WSL2 尤其有用，因为把服务暴露到局域网比较麻烦
- **端到端加密** — 底层是 WireGuard
- **免费档** — 个人计划最多 100 台设备

## 1. 在服务器上安装 Tailscale

安装到运行中继服务器的机器（或 WSL2 实例）上。

### Linux / WSL2

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

按终端打印的授权 URL 登录。

### macOS

```bash
brew install tailscale
sudo tailscale up
```

### Windows 11

```bash
winget install tailscale
tailscale up
```

或者

从 [tailscale.com/download](https://tailscale.com/download) 下载并登录。

也可安装 App Store 版本。

### 验证

```bash
tailscale ip -4
# 会打印类似 100.64.1.23 的地址
```

## 2. 在手机上安装 Tailscale

- **iOS**：[App Store](https://apps.apple.com/app/tailscale/id1470499037)
- **Android**：[Play Store](https://play.google.com/store/apps/details?id=com.tailscale.ipn)

使用同一账号登录。两台设备都应出现在 Tailscale 管理控制台中。

## 3. 访问 Web 应用

在手机上打开 `http://<tailscale-ip>:3000`，其中 `<tailscale-ip>` 是第 1 步得到的服务器 Tailscale IP（例如 `http://100.64.1.23:3000`）。

如果启用了 Tailscale MagicDNS，也可以用机器名：

```
http://my-desktop:3000
```

## 4. 仅监听 Tailscale

默认服务器绑定 `127.0.0.1`（localhost）。要限制为只走 Tailscale：

- **扩展：** 打开设置面板 > Networking > 选择 “Specific address (Tailscale / custom)” > 填入 Tailscale IP > Save & Restart。也可直接在 Settings 中设置 `cursorRemote.serverHost`。
- **独立运行：** 在 `.env` 中设置 `SERVER_HOST`：

```bash
# .env
SERVER_HOST=100.64.1.23   # 你的 Tailscale IP
```

此时服务器只监听 Tailscale 网卡。局域网和公网连接会在操作系统层面被拒绝。

## 5. Tailscale + 密码（纵深防御）

为了额外安全，可以把 Tailscale 和 webapp 密码一起用：

- **扩展：** 首次安装会自动生成密码。可在设置面板或 Settings（`cursorRemote.webappPassword`）中查看或修改。
- **独立运行：** 在 `.env` 中同时设置：

```bash
# .env
SERVER_HOST=100.64.1.23
WEBAPP_PASSWORD=my-secret-password
```

这样即使有人加入了你的 Tailscale 网络，仍然需要密码。

## 6. Tailscale Funnel（临时公开访问）

如果需要临时分享访问，且对方设备没有安装 Tailscale：

```bash
tailscale funnel 3000
```

这会创建一个公开 HTTPS URL（例如 `https://my-desktop.tail1234.ts.net:443`）。用完后按 Ctrl+C 停止。请同时设置 `WEBAPP_PASSWORD`，避免有人通过 funnel 未授权访问。

## 故障排除

### 手机上 “Connection refused”

- 两台设备是否登录了同一个 Tailscale 账号？
- `tailscale status` 是否显示两台设备都已连接？
- 服务器是否用正确的 `SERVER_HOST` 在运行？

### WSL2 相关

- 把 Tailscale 装在 WSL2 内，而不是 Windows 主机上（除非使用 mirrored networking）
- 如果使用 mirrored networking，也可以把 Tailscale 装在 Windows 上，对 WSL2 同样生效

### MagicDNS 无法解析

- 在 Tailscale 管理控制台（DNS 设置）中启用 MagicDNS
- 部分手机在启用后需要重启 Tailscale 应用