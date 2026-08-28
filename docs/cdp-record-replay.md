# CDP 录制 / 回放工具

独立工具，用于随时间捕获 Cursor IDE 状态，并回放到 Telegram 测试话题。设计目的是在不运行完整中继的情况下调试 Telegram 传输管道。

## 为什么需要

Cursor 的 agent UI 是动态的 — 元素出现、shimmer、在状态之间过渡、再被替换。中继必须把这些过渡翻译成正确的 Telegram API 调用（send、edit、delete）。这类翻译 bug 很难复现，因为它们依赖于现场 agent 会话中特定的 DOM 状态序列。

这些工具通过以下方式解决该问题：

1. **录制** 现场会话，保存为一系列 CursorState 快照
2. **回放** 该录制到测试 Telegram 话题，精确看到中继会发出什么
3. **迭代** formatter/transport 代码，并对同一份录制回放以验证修复

## 架构

```
Record:  CDP -> extractionFunction -> CursorState -> JSONL file
Replay:  JSONL file -> formatter -> Telegram test topic + stdout log
```

两个脚本都是独立进程。它们把 `src/` 中的共享代码当库导入，但不会修改任何中继源文件。中继可以同时运行，互不干扰。

## 前置条件

- Cursor IDE 以 `--remote-debugging-port=9222` 运行
- `.env` 中有 `TELEGRAM_BOT_TOKEN`（回放需要；`--dry-run` 除外）
- 一个启用了论坛话题的 Telegram 超级群组（真实发送时需要）

## 录制

### 命令

```bash
npm run record                            # 录制第一个 Cursor 窗口
npm run record -- --window cursor-ide     # 按标题子串匹配窗口
```

### 它做什么

1. 连接到 `http://127.0.0.1:9222` 的 CDP（可用 `CDP_URL` 环境变量覆盖）
2. 发现所有 Cursor 窗口，连接到匹配的那个
3. 运行中继使用的同一套 `extractionFunction`，每 300ms 一次
4. 把状态快照写入 `data/recording-<timestamp>.jsonl`
5. 去重：状态真正变化时才写入（保持文件较小）
6. 在 stdout 上显示实时进度

### 输出格式

文件第一行是 schema 头（当前 `schemaVersion` 为 `2`）：

```json
{"header":{"schemaVersion":2,"appVersion":"0.1.52","selectorsHash":"...","startedAt":"..."}}
```

随后每一行是一个 JSON 对象：

```json
{"ts":1711234567890,"state":{"connected":true,"agentStatus":"generating","agentActivityText":"Planning next moves","messages":[...],...},"raw":{...}}
```

- `ts` — 捕获快照时的 epoch 毫秒
- `state` — 完整的 `CursorState`（提取失败则为 `null`）。这是经过 `applyDerivedActivityToState` 处理后的派生状态
- `raw` — 提取器返回的原始状态（schema v2）；回放默认使用 `state`

旧的 v1 录制没有 header 行，也没有 `raw` 字段；`npm run replay` 仍可读取。

### 提示

- 在 agent 正在工作时录制，才能抓到有意义的状态过渡
- 几分钟活动的录制通常为 10–200 KB
- 按 Ctrl+C 可干净地停止录制

## 回放

### 命令

```bash
npm run replay -- <recording.jsonl> --thread <topic_id> [--chat <group_id>] [--speed N] [--dry-run]
```

### 参数

| 参数 | 必填 | 说明 |
|----------|----------|-------------|
| `<file>` | 是 | `.jsonl` 录制文件路径 |
| `--thread` | 真实发送时是 | 要发送到的 Telegram 论坛话题 `message_thread_id`；`--dry-run` 时可省略 |
| `--chat` | 否 | Telegram 群 chat ID（默认：`TELEGRAM_CHAT_ID` 环境变量） |
| `--speed` | 否 | 回放速度倍率（默认：5） |
| `--dry-run` / `--dry` | 否 | 只把 API 调用打到 stdout，不真正发送；此时不需要 `TELEGRAM_BOT_TOKEN` |

### 它做什么

1. 读取录制中的全部快照（若有 header 则跳过第一行）
2. 对每个状态过渡，按录制节奏（由 `--speed` 缩放）：
   - **活动指示器**：发送、编辑或删除短暂活动消息（若存在 `_rawSignals` 则经 `deriveActivityFromSignals` 派生，否则用 `agentActivityText`）。现场中继的 `TelegramTransport` 还会把活动与进行中的 `📎` step-summary thought **去重**（`activityRedundantWithInProgressStepSummary`）；回放脚本目前尚未镜像该去重 — 若快照顺序命中这一边界情况，录制中仍可能同时出现两行。
   - **内容消息**：发送新的聊天元素，内容变化时编辑已有消息（`formatElement`；若录制中存在，工具消息可能包含演化中的 `diffBlock` / `codeBlocks` 等字段）
3. 把每一次 Telegram API 调用记录到 stdout

### 示例输出

```
[replay] Loaded 47 snapshots from data/recording-2026-03-24T00-24-00.jsonl
[replay] Speed: 10x, thread: 12345, chat: -1001234567890

[replay] Bot: @cursor_controller_bot

[+0.1s] SEND  activity "Planning next moves" -> msgId=100
[+0.4s] SEND  human "fix the bug in config.ts" -> msgId=101
[+0.8s] EDIT  activity msgId=100 "Generating"
[+1.2s] DELETE activity msgId=100
[+1.3s] SEND  tool "Edit config.ts  +14 -7" -> msgId=102
[+1.5s] SEND  assistant "I've fixed the configuration issue..." -> msgId=103
[+2.0s] EDIT  tool msgId=102 "Edit config.ts  +14 -7"

[replay] Done -- 4 content messages, 47 snapshots replayed
```

### 查找 thread ID

获取论坛话题的 `message_thread_id`：

1. 从该话题转发任意消息到 [@RawDataBot](https://t.me/RawDataBot)
2. 在响应中查找 `message_thread_id`
3. 或查看话题 URL — 在 `https://t.me/c/1234567890/42` 中，thread ID 是 `42`

### 查找 chat ID

群 chat ID（形如 `-1001234567890` 的负数）：

1. 从该群转发任意消息到 [@RawDataBot](https://t.me/RawDataBot)
2. 在响应中查找 `chat.id`
3. 或在 `.env` 中设置 `TELEGRAM_CHAT_ID`

## 工作流

### 调试特定问题

```bash
# 1. 复现问题时开始录制
npm run record -- --window cursor-ide

# 2. 在 Cursor 中做出触发 bug 的操作
#    （例如启动一个 agent 任务，等待活动指示器）

# 3. 停止录制（Ctrl+C）

# 4. 在 Telegram 群中创建一个测试话题

# 5. 回放，查看中继会发送什么
npm run replay -- data/recording-2026-03-24T00-24-00.jsonl --thread 99999 --speed 5

# 6. 在 Telegram 中检查测试话题 — 看起来对吗？

# 7. 修代码，回放同一份录制，对比
npm run replay -- data/recording-2026-03-24T00-24-00.jsonl --thread 99999 --speed 5
```

### 回归测试

把已知场景的录制保存在仓库（或共享文件夹）中。修改 formatter 或 transport 逻辑后，回放它们并确认输出没有回退。仓库里 `fixtures/recordings/` 下有若干规范化过的 JSONL 样例。

## 环境变量

| 变量 | 使用者 | 默认值 | 说明 |
|----------|---------|---------|-------------|
| `CDP_URL` | record | `http://127.0.0.1:9222` | Chrome DevTools Protocol 端点 |
| `TELEGRAM_BOT_TOKEN` | replay | -- | Bot token（真实发送时必填） |
| `TELEGRAM_CHAT_ID` | replay | -- | 默认群 chat ID |
| `SELECTORS_PATH` | record | `./selectors.json` | 自定义选择器文件 |