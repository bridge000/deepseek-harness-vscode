# Changelog

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
