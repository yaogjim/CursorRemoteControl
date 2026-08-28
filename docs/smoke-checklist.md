# 发布前冒烟检查清单

在自动化测试通过、准备发布之前，请手动完成以下检查。

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
- [ ] Run command 卡片显示命令文本，以及 Skip/Run 按钮
- [ ] 审批完成后，审批按钮消失并出现工具结果
- [ ] Plan widget 显示标题、进度；“View Plan” 打开包含完整计划的模态框
- [ ] Plan 模型选择器打开 sheet 并列出模型选项
- [ ] 代码块保留换行，diff 显示红/绿着色
- [ ] 向上滚动会停止自动滚动；新消息不会把视图拽回底部

## Telegram

- [ ] 实时活动显示 shimmer（spoiler 标签）— 例如带 spoiler 的 `● Thinking…`
- [ ] 活动结束后 shimmer 消失（消息被删除）
- [ ] Thought 的 step-summary 在进行中显示 spoiler，完成后去掉
- [ ] 活动行会与匹配的 step-summary 去重
- [ ] Run command 显示命令文本，以及 Skip/Run 内联按钮
- [ ] Plan block 渲染 todos，以及 View Plan / Build 按钮

## 边界情况

- [ ] 在多个 Cursor 窗口之间切换时，每个窗口显示对应状态
- [ ] 将 Cursor 置于后台（macOS）时优雅降级 — 不崩溃，状态显示 stale
- [ ] 快速切换 tab 不会产生重复消息