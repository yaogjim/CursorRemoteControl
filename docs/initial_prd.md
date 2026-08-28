# 原型范围文档：Cursor Web Controller（MVP）

> **说明：** 本文是项目最初的原型范围文档，仅作历史记录保留。当前产品规格以 [`prd.md`](prd.md) 和 [`architecture.md`](architecture.md) 为准。下文中的 Puppeteer、`chat_input`、整段 HTML 广播等方案，已被自定义 CDP 客户端、结构化 `ChatElement` 和 socket.io 协议取代。

## 1. 目标

构建一个 Node.js 中继服务器，通过 Chromium DevTools Protocol（CDP）连接到本机运行的 Cursor IDE。服务器提取 AI Chat 面板的 DOM，通过 WebSockets 广播给轻量 Web 客户端，并把远程用户操作代理回 IDE。

## 2. 系统架构

**宿主进程：** 以 `--remote-debugging-port=9222` 启动的标准 Cursor IDE。

**中继服务器（Node.js）：**

- 与 Cursor 运行在同一台机器上。
- 使用 puppeteer-core 维持到 Cursor 的 CDP 连接。
- 为前端 UI 提供静态 HTML/JS。
- 托管 WebSocket 服务器（例如 socket.io 或 ws），与 Web 客户端保持实时双向连接。

**Web 客户端（浏览器）：**

- 通过 WebSockets 接收原始 HTML 或状态更新，并渲染聊天界面。
- 捕获用户按键和按钮点击，以结构化 JSON 载荷经 WebSocket 发回中继服务器。

## 3. 核心需求（MVP）

**需求 1：服务器初始化**

Node 服务器必须成功绑定 `http://localhost:9222/json`，找到 Cursor 工作区，并附着 Puppeteer。

同时必须启动 Express 服务器（例如端口 3000）以提供客户端界面。

**需求 2：状态广播**

后端必须监视 Cursor DOM。

一旦检测到 Secondary Side Bar 发生变化，就必须序列化相关 HTML 内容，并广播给所有已连接的 WebSocket 客户端。

**需求 3：命令路由**

后端必须监听来自客户端的特定 WebSocket 事件：

- `chat_input`：包含一个字符串。后端在 Cursor 目标内执行 `page.keyboard.type()`。
- `trigger_click`：包含目标标识（如 `"submit"` 或 `"approve"`）。后端将其映射到对应 DOM 选择器并执行 `page.click()`。

**需求 4：客户端渲染**

Web 客户端必须用广播来的 HTML 字符串替换其容器的 innerHTML。

必须注入基础 CSS，确保未样式化的 Cursor HTML 在手机或远程浏览器上可读。

## 4. 实施阶段

**阶段 1：中继枢纽**

初始化 Node.js 项目。用 Express 提供基础 `index.html`，并建立 WebSocket 服务器。

**阶段 2：CDP 桥接**

把 puppeteer-core 集成进 Node 服务器。编写轮询逻辑，每秒（或通过 MutationObserver）抓取聊天容器 HTML，并通过 WebSocket 发出。

**阶段 3：Web 客户端**

编写前端 JavaScript，监听 WebSocket 消息并渲染注入的 HTML。

在 Web UI 中加入输入框和发送按钮，向服务器发出 `chat_input` 事件。

**阶段 4：执行循环**

编写后端处理程序，接收 WebSocket 事件并将其转译为 Cursor 内的 Puppeteer 交互。

## 5. 工程风险与缓解

**风险：高频 DOM 更新。** Cursor 按 token 流式输出文本。每个 token 都广播整段聊天容器 HTML，会造成严重的网络开销和客户端渲染闪烁。

**缓解：** 在后端 DOM observer 上实现 debounce。每 300–500ms 才广播一次状态变化，或者解析 DOM，只发送最新文本 diff，而不是整段 HTML。

**风险：事件监听器丢失。** 用 innerHTML 提取 HTML 时，绑定到 Cursor React 状态的 JavaScript 事件监听器会被销毁。

**缓解：** Web 客户端不能依赖直接点击提取出的 HTML 按钮。Web UI 必须渲染自己的静态控制按钮（例如屏幕底部固定的 “Approve” 按钮），通过 WebSocket 事件触发，而不是试图让克隆 DOM 可交互。