# Changelog

## 0.3.0

- **UI 重做**：紧凑单行头部 + 溢出菜单、用户消息右对齐、助手消息去重复标签、工具卡片压缩为一行、findings 面板严重级别筛选与逐条修复、输入区重排、空状态快捷动作、回到底部按钮、设计 token / 焦点可见 / 窄宽度与暗亮主题适配。
- **诊断 Quick Fix**：审查 findings 在编辑器里出现灯泡，「用 DeepSeek Harness 修复」单条问题；侧边栏 findings 每行也可直接修复。
- **撤销本轮修改**：每轮开始前记录 git stash 快照 + 预存在未跟踪文件内容，结束后记录改动文件哈希；「撤销本轮修改」命令/通知可恢复或删除本轮改动，用户中途手改则整体拒绝。仅 git、仅最近一轮。
- **本地会话标题**：从首条用户消息生成标题，用于头部与历史展示（ACP 无标题接口）。
- **发送修正**：运行时就绪前也能发送（自动 bootstrap）。
- **新增 URI 打开**：`vscode://xliang.deepseek-harness/open` 直接打开侧边栏。
- **开源化**：中英双语文档、架构/UI/贡献/安全/发布文档、GitHub Actions CI 与 Release workflow、issue/PR 模板、`.editorconfig`/`.gitattributes`；移除 `private`，版本 0.3.0。
- 测试：新增 Quick Fix、撤销、UI 纯逻辑单测；`smoke:ext` 继续覆盖自动上下文 / 模型 / 严格模式权限卡片。

## 0.2.0

- **改名**：扩展 / 侧边栏 / 命令 / 设置 / 诊断统一为 DeepSeek Harness（ID `xliang.deepseek-harness`）。
- **自动上下文**（默认开）：自动附带当前焦点编辑器的文件或选中代码；有选区按选区 + 前后 20 行；不再需要手动 `@` 选择文件。
- **文件级审查**：单文件/选区提示词强制只分析内嵌内容；删除对审查内容的 `resource_link`，避免 agent 扫描整个项目。
- **模型修正**：隐藏已下线旧名 `deepseek-v4-flash`；默认模型对齐 DSH 用户设置（`agent-default-model`，当前 DeepSeek-V4.1-Flash = `deepseek-flash`）；新增 `preferredModel` / `hideLegacyModels` 配置。
- **思考链重做**：折叠行「已思考 N 秒」/「思考中…」/「思考过程」，流式结束后自动收起；展开为低饱和小字。
- **侧边栏权限卡片**：严格模式下在侧边栏批准/拒绝；侧边栏隐藏时回退 VS Code 模态弹窗。
- **自动启动**：首次打开侧边栏即启动运行时；未就绪时发送会自动 bootstrap。
- 测试：新增自动上下文、模型、权限 broker、思考链等单测；`smoke:ext` 增加自动上下文 / 模型 / 严格模式权限卡片端到端检查。

## 0.1.0

- 首个版本：ACP 驱动的侧边栏聊天、代码审查（findings → 诊断）、改动 diff 查看、DSH 更新兼容层（探测 / 自愈 / 能力降级 / compat 测试）。
