# DeepSeek Harness（VS Code 扩展）

把 **DeepSeek Harness（DSH）** 接进 VS Code 右侧辅助侧边栏，走 DSH 官方 **ACP（Agent Client Protocol）** 自动化接口，做两件事：

1. **聊天**：流式回复、工具卡片、权限批准（侧边栏卡片）、会话历史、模型 / 推理强度切换；**自动附带当前焦点编辑器**的文件或选中代码，不需要手动 `@` 选文件。
2. **代码审查**：审查当前文件 / 选中代码 / 工作区改动 / 暂存区 / 某个提交，发现以 **VS Code 诊断（波浪线）** 呈现，可点击跳转；DSH 改完文件后还能看**本轮改动的原生 diff**。

> 官方目前没有 VS Code 插件；本扩展是**非官方社区扩展**，只是套在官方 ACP 接口外面的客户端，不改 DSH 本体、不依赖非官方 bridge。

## 0.2.0 新特性

- **改名**：扩展 / 侧边栏 / 命令 / 设置全部统一为 **DeepSeek Harness**（旧版 `xliang.dsh-review` 会被本版本替代）。
- **自动上下文（默认开启）**：发消息/审查时自动附带**当前焦点编辑器**的文件内容；有选区就只带选区（前后各 20 行）；你同时打开很多文件也只认当前焦点那个。
- **文件级审查**：单文件/选区审查只分析内嵌内容，提示词明确禁止遍历项目其余文件，也不再下发 `resource_link` 去诱导 agent 读别的文件。
- **模型列表修正**：隐藏已下线的旧模型 `deepseek-v4-flash`（旧名，实际由 `deepseek-flash` = DeepSeek-V4.1-Flash 提供）；默认模型跟随你 DSH 设置里的 `agent-default-model`（当前为 DeepSeek-V4.1-Flash），不再落到旧名。
- **思考链重做**：折叠成一行「已思考 N 秒」，流式中「思考中…」，展开是低饱和小字（Claude Code / DSH 风格）。
- **权限卡片**：严格模式下直接在侧边栏批准/拒绝；侧边栏隐藏时自动回退到 VS Code 模态弹窗。
- **打开即用**：首次打开侧边栏自动启动运行时；运行时未就绪时点发送也会自动 bootstrap。

## 安装与升级

```powershell
# 在项目目录
npm install
npm run build
npm run package

# 从旧版升级：先卸载旧扩展、禁用 ID 冲突的社区扩展
code --uninstall-extension xliang.dsh-review
code --disable-extension lixxx1.dsh-sidebar   # 它占用了 deepseekHarness.* 容器/命令/配置 ID

code --install-extension deepseek-harness.vsix --force
```

重载窗口后：

1. 右侧 **辅助侧边栏（Secondary Side Bar）** → `Other Views` 里找到 **DeepSeek Harness**（或命令面板执行 `DeepSeek Harness: 打开侧边栏`）。
2. 打开一个**受信任的工作区文件夹**；第一次打开侧边栏会自动拉起 DSH（需要本机已安装 DSH：桌面端的 `dsh` 或 `npm i -g @deepseek-ai/dsh`）。
3. 把光标放在要分析的代码文件里（有选区就选中），直接发消息或执行审查命令即可；输入框上方会显示「自动上下文：…」chip。
4. 审查命令：
   - `DeepSeek Harness: 审查当前文件`
   - `DeepSeek Harness: 审查选中代码` / `解释选中代码`
   - `DeepSeek Harness: 审查工作区改动` / `审查暂存区改动` / `审查某个提交`
   - `DeepSeek Harness: 修复最近审查发现的问题`
   - `DeepSeek Harness: 查看本轮改动` / `清除审查结果`
5. 关闭自动上下文：点 chip 右侧小开关（本会话生效）；或用设置 `deepseekHarness.autoContext` 设为 `off`。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `deepseekHarness.executable` | `""` | `dsh` 路径；留空自动探测（PATH → DSH 桌面端 → npx） |
| `deepseekHarness.profile` | `"acp"` | 启动的 profile；留空自动发现 ACP-capable profile |
| `deepseekHarness.permissionMode` | `"workspace-write"` | 写入 `DSH_PERMISSION_MODE`。`read-only` = 严格模式：每次写文件/执行命令都要批准（此时在侧边栏弹卡片） |
| `deepseekHarness.autoApprove` | `"ask"` | `all` 自动批准所有权限请求（危险） |
| `deepseekHarness.autoContext` | `"selection-first"` | `selection-first` 有选区带选区、否则带整个焦点文件；`file` 只带文件；`off` 关闭 |
| `deepseekHarness.autoContextMaxChars` | `40000` | 自动上下文最大字符数（超出按行截断） |
| `deepseekHarness.preferredModel` | `""` | 首选模型 `provider/model`，留空则读 DSH 用户设置 → 上次选择 |
| `deepseekHarness.hideLegacyModels` | `true` | 隐藏已下线旧模型名（如 `deepseek-v4-flash`） |
| `deepseekHarness.workspaceRootIndex` | `0` | 多根工作区选哪个根 |
| `deepseekHarness.maxReviewChars` | `60000` | 一次审查发送的最大字符数 |
| `deepseekHarness.saveTranscriptLimit` | `50` | 本地保留的会话记录数 |
| `deepseekHarness.showChangesNotice` | `true` | 一轮结束后提示本轮改动的文件 |
| `deepseekHarness.checkCompatOnVersionChange` | `true` | DSH 版本变化时后台自检并提示 |
| `deepseekHarness.compat.autoRepair` | `true` | ACP profile 启动失败时允许用官方模板重建（先备份） |

**严格模式**（Claude Code 式“改前批准”）：把 `deepseekHarness.permissionMode` 改成 `read-only` 并执行 `DeepSeek Harness: 重启运行时`。DSH 的写文件/命令会被沙箱拦下，在侧边栏弹出权限卡片；拒绝则文件不变。

## 关于模型（`deepseek-v4-flash` 是什么）

- `deepseek-v4-flash` 是 DeepSeek 的**旧模型名**，请求实际由 `deepseek-flash`（显示名 **DeepSeek-V4.1-Flash**）提供。DSH 自己的计费组件注释也写明「旧名已下线，请求由 V4.1-Flash 提供」。
- 本插件之前之所以显示它，是因为 DSH 的 ACP 出厂 profile 把默认模型写死成了这个旧名；0.2 起：
  - 模型下拉默认隐藏旧名；
  - 会话创建/恢复后自动按你的 DSH 用户设置（`~/.dsh/profiles/web/cordis.patch.yml` 的 `agent-default-model`）选择模型，其次才用插件上次选择；
  - 也可用 `deepseekHarness.preferredModel` 显式指定，例如 `deepseek-official/deepseek-flash`。

## DSH 更新后怎么办

1. **协议解耦**：不依赖 `@agentclientprotocol/sdk`，自带容错的轻量 JSON-RPC/ACP 客户端；未知通知、未知字段、stdout 里混入的日志行都不会中断连接。
2. **启动自检**：每次启动检查 `dsh --version`、`--profile acp --help`、`initialize` 的 `protocolVersion` 与能力位；DSH 版本变化时后台重检并提示。
3. **能力驱动降级**：没有 `session/list/resume/close` 就隐藏历史/恢复；没有 `model`/`reasoning_effort` 就隐藏选择器；`-32601` 时永久降级而不是崩溃。
4. **profile 自愈**：ACP profile 丢失/损坏时，确认后备份原目录并用官方模板重建。
5. **契约测试**：升级 DSH 后先跑：

```powershell
npm run compat
npm run smoke
npm run smoke:ext
$env:SMOKE_STRICT="1"; npm run smoke:ext   # 严格模式 + 侧边栏权限卡片端到端
```

6. **诊断**：命令面板 `DeepSeek Harness: 兼容性诊断`，生成报告（版本、可执行文件候选、profile、能力位、日志尾部）可复制反馈。

**已知边界**：如果上游把 ACP 升到不兼容的 v2、移除 `dsh-acp-app` 或彻底更换自动化接口，扩展必须发版适配；`npm run compat` 与诊断页会立即报错而不是静默失效。

## 交互说明 / 已知限制

- **自动上下文**只认焦点编辑器；终端/输出面板聚焦时不附带。未保存文件会以「未保存文件」note 提示，工作区外文件照常附带并标注。
- **文件级审查**通过提示词 + 不下发 `resource_link` 限制范围；ACP 没有“禁用工具”的能力，模型理论上仍可能自行读取其它文件（属模型行为），但 UI 不会主动把整个项目塞给它。
- **权限批准**：侧边栏可见时用卡片；隐藏时回退 VS Code 模态弹窗；弹窗关闭 = 拒绝。
- **思考链时长**按 webview 收到结束信号的时间计算；窗口重载后历史条目显示「思考过程」。
- 侧边栏「历史」按钮同时支持下拉选择与命令面板的 QuickPick。
- 审查 findings 的 JSON 契约由提示词固定；模型未按契约输出时，聊天里仍有完整 markdown，但不会生成波浪线。
- `审查工作区改动` 是标准 `git diff`，不包含未跟踪的新文件；`查看本轮改动` 的左侧是 `HEAD` 版本（不是“本轮开始前”）。
- 非 git 工作区可用文件/选区审查；改动类功能会提示需要 git。
- **0.3.0 计划**（本次未实现）：诊断 Quick Fix（灯泡一键修复）、撤销本轮修改（`git stash create` 快照 + 哈希校验）。
- 仓库目录名保持 `dsh-review-vscode` 不变。

## 开发

```powershell
npm run build      # esbuild：dist/extension.js + dist/webview/main.js + dist/compat.cjs
npm run typecheck
npm run test       # vitest（纯逻辑，不需要安装 DSH）
npm run compat     # 真实 DSH 契约检查
npm run smoke      # 真实 ACP 握手
npm run smoke:ext  # 扩展宿主冒烟（mock vscode + 真实 DSH：自动上下文、模型、消息、审查）
npm run package    # deepseek-harness.vsix
```

目录：

```
src/acp/       协议类型、JSON-RPC、stdio transport、运行时、兼容探测
src/context/   自动上下文（焦点编辑器收集 + 纯构建函数）
src/model/     旧模型别名过滤、模型偏好（DSH 设置解析）
src/session/   会话管理、transcript 持久化
src/review/    提示词、findings 解析、git、诊断、改动 diff
src/ui/        侧边栏 provider、权限卡片/弹窗、权限 broker、状态栏、诊断报告
src/webview/   侧边栏前端（原生 TS + marked + DOMPurify）、思考链纯逻辑
```

## License

MIT
