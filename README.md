# DSH Review

把 **DeepSeek Harness（DSH）** 接进 VS Code 的侧边栏，用官方 **ACP（Agent Client Protocol）** 驱动，做两件事：

1. **聊天**：右侧辅助侧边栏里和 DSH 对话，流式输出、工具调用、权限批准、会话历史、模型/推理强度切换。
2. **随时审查代码**：审查当前文件 / 选中代码 / 工作区改动 / 暂存区 / 某个提交，审查发现以 **VS Code 诊断（波浪线）** 的形式落到编辑器里，可点击跳转；DSH 改完文件后还能看**本轮改动的原生 diff**。

> 官方目前没有 VS Code 插件；本扩展是第三方实现，走的是 DSH 官方提供的 ACP 自动化接口（`dsh --profile acp`），不改 DSH 本体、不依赖非官方 bridge。

## 安装与使用

```powershell
# 在项目目录
npm install
npm run build
npm run package
code --install-extension dsh-review.vsix --force
```

重载窗口后：

1. VS Code 右侧 **辅助侧边栏（Secondary Side Bar）** 出现 `DSH Review` 图标（或命令面板执行 `DSH: 打开侧边栏`）。
2. 打开一个**受信任的工作区文件夹**。
3. 第一次发消息会自动拉起 DSH 运行时（需要本机已安装 DSH：桌面端的 `dsh` 或 `npm i -g @deepseek-ai/dsh`）。
4. 审查代码：编辑器右上角鲸鱼图标、右键菜单，或命令面板执行：
   - `DSH: 审查当前文件`
   - `DSH: 审查选中代码` / `DSH: 解释选中代码`
   - `DSH: 审查工作区改动` / `DSH: 审查暂存区改动` / `DSH: 审查某个提交`
   - `DSH: 修复最近审查发现的问题`
   - `DSH: 查看本轮改动` / `DSH: 清除审查结果`

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `dshReview.executable` | `""` | `dsh` 路径；留空自动探测（PATH → DSH 桌面端 → npx） |
| `dshReview.profile` | `"acp"` | 启动的 profile；留空自动发现 ACP-capable profile |
| `dshReview.permissionMode` | `"workspace-write"` | 写入 `DSH_PERMISSION_MODE`。`read-only` = 严格模式：每次写文件/执行命令都要批准 |
| `dshReview.autoApprove` | `"ask"` | `all` 自动批准所有权限请求（危险） |
| `dshReview.workspaceRootIndex` | `0` | 多根工作区选哪个根 |
| `dshReview.maxReviewChars` | `60000` | 一次审查发送的最大字符数（超出按文件/行截断） |
| `dshReview.saveTranscriptLimit` | `50` | 本地保留的会话记录数 |
| `dshReview.showChangesNotice` | `true` | 一轮结束后提示本轮改动的文件 |
| `dshReview.checkCompatOnVersionChange` | `true` | DSH 版本变化时后台自检并提示 |
| `dshReview.compat.autoRepair` | `true` | ACP profile 启动失败时允许用官方模板重建（先备份） |

**严格模式**（Claude Code 式"改前批准"）：把 `dshReview.permissionMode` 改成 `read-only` 并重启运行时。DSH 的写文件/命令会被沙箱拦下并弹出批准框，拒绝则文件不变。

## DSH 更新后怎么办

本扩展按"上游可能变"来设计：

1. **协议解耦**：不依赖 `@agentclientprotocol/sdk`，自带容错的轻量 JSON-RPC/ACP 客户端；未知通知、未知字段、stdout 里混入的日志行都不会中断连接。
2. **启动自检**：每次启动检查 `dsh --version`、`--profile acp --help`、`initialize` 的 `protocolVersion` 与能力位；DSH 版本变化时后台重检并在状态栏/通知里给出结论。
3. **能力驱动降级**：没有 `session/list/resume/close` 就隐藏历史/恢复；没有 `model`/`reasoning_effort` 就隐藏选择器；某个方法返回 `-32601` 就永久降级而不是崩溃。
4. **profile 自愈**：ACP profile 丢失/损坏时，弹窗确认后备份原目录并用官方模板重建，再重试一次。
5. **契约测试**：升级 DSH 后先跑：

```powershell
npm run compat
```

检查 `--version`、ACP profile、`initialize`、`session/new` 的 `model` 配置项；不通过会直接告诉你哪一项变了。可选的真实回归：

```powershell
npm run smoke                     # initialize → session/new → session/close
$env:DSH_REVIEW_SMOKE_PROMPT="1"; npm run smoke   # 额外发一条消息（消耗 token）
```

6. **诊断**：命令面板 `DSH: 兼容性诊断`，生成报告（版本、可执行文件候选、profile、能力位、日志尾部）可复制反馈。

**已知边界**：如果上游把 ACP 升到不兼容的 v2、移除 `dsh-acp-app` 或彻底更换自动化接口，扩展必须发版适配。此时 `npm run compat` 与诊断页会立即报错，而不是静默失效；适配工作集中在 `src/acp/protocol.ts` 与 `src/acp/compat.ts`。

## 排错

- **找不到 DSH**：设置 `dshReview.executable` 指向 `dsh.cmd`；桌面端默认在
  `%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd`。
- **服务起不来 / 一直转圈**：打开命令面板 `DSH: 兼容性诊断`，或看输出面板 `DSH Review`；`DSH: 重启运行时` 可重来一次。
- **权限框太频繁**：把 `permissionMode` 改回 `workspace-write`。
- **审查没有波浪线**：模型回复里没有按约定给出 JSON findings；聊天里仍有完整的 markdown 审查结果。可以重试或换更强的模型。
- **工作区不是 git 仓库**：审查当前文件/选区仍可用；`审查工作区改动`、`查看本轮改动` 需要 git。

## 开发

```powershell
npm run build      # esbuild：dist/extension.js + dist/webview/main.js + dist/compat.cjs
npm run typecheck
npm run test       # vitest（纯逻辑，不需要安装 DSH）
npm run compat     # 真实 DSH 契约检查
npm run smoke      # 真实 ACP 握手
npm run package    # dsh-review.vsix
```

目录：

```
src/acp/       协议类型、JSON-RPC、stdio transport、运行时、兼容探测
src/session/   会话管理、transcript 持久化
src/review/    提示词、findings 解析、git、诊断、改动 diff
src/context/   上下文收集（当前文件/选区/@file）
src/ui/        侧边栏 provider、权限弹窗、状态栏、诊断报告
src/webview/   侧边栏前端（原生 TS + marked + DOMPurify）
```

## License

MIT
