# DeepSeek Harness for VS Code

把 **DeepSeek Harness（DSH）** 接进 VS Code 右侧辅助侧边栏，走 DSH 官方 **ACP（Agent Client Protocol）** 自动化接口：聊天、自动上下文、文件级代码审查、诊断 Quick Fix、撤销本轮修改。

> **非官方社区扩展**：本项目与 DeepSeek 官方无隶属关系，只是套在官方 ACP 接口外面的 VS Code 客户端；不改 DSH 本体、不依赖非官方 bridge。
>
> 中文文档：本页 · English: [README.en.md](README.en.md)

> 截图待补：本仓库暂不包含界面截图（避免提交个人桌面画面），欢迎贡献者补充到 `docs/images/`。

## 功能

- **侧边栏聊天**：流式回复、工具调用卡片、思考链、会话历史、模型 + 推理合并入口、上下文窗口用量环。
- **自动上下文**：自动附带**当前焦点编辑器**的文件内容；有选区只带选区（前后各 20 行）。同时打开多个文件也只认当前焦点那个，不需要手动 `@` 选文件。
- **文件级代码审查**：审查当前文件 / 选中代码 / 工作区改动 / 暂存区 / 某个提交；提示词限制只分析内嵌内容，不主动遍历项目。
- **诊断 Quick Fix**：审查发现以 VS Code 诊断呈现，编辑器灯泡可直接「用 DeepSeek Harness 修复」，也可在侧边栏逐条修复。
- **撤销本轮修改**：DSH 改完文件后可一键恢复到本轮开始前（`git stash create` 快照 + 未跟踪文件快照 + 哈希校验），仅 git 仓库、仅最近一轮。
- **输入区菜单**：`＋`（添加上下文 / 模式 / 审查 / 会话 / 更多）、权限（工作区内 / 只读 / 完全权限 + 自动审查）、合并的模型/推理入口、顶部 `⋯`（含显示 / 字号）共用一套自绘二级菜单，原生的下拉与独立「审查」按钮已全部移除。
- **图片附件**：`+` 菜单可选工作区图片或「从磁盘选择图片…」，也支持从资源管理器拖入；图片以 ACP image 内容块嵌入（PNG/JPEG/WebP/GIF，单张 ≤5MB），音频/视频会明确提示暂不支持。
- **斜杠指令**：在输入框敲 `/` 弹出指令面板，`/plan`、`/goal`、`/review`、`/permission`、`/help` 等 14 条指令本地执行、不发给模型。
- **提示词不进对话流**：审查、修复、自动审查发给模型的提示词正文只留在日志里，侧边栏只显示一行标签；聊天气泡也只显示你打的字。
- **自动审查**：开启后每轮结束自动审查本轮改动（含新建文件），问题直接进「审查结果」面板与编辑器诊断；开关并入权限菜单。
- **权限预设**：工作区内 / 只读 / 完全权限三档，写入 `deepseekHarness.permissionMode`；切换会重启 DSH 运行时并自动续接当前会话（正在生成时拒绝切换）。
- **计划 / 目标模式**：计划模式注入只读规划指导并自动拒绝写操作；目标模式引导模型使用目标工具链。ACP 不提供 DSH 原生模式接口，因此这是客户端模式（见「已知限制」）。
- **启动页**：无对话时显示官方白鲸 logo + 官方 `deepseek HARNESS` 词标（矢量取自 DSH 自带 UI 包），渐入渐出。
- **排队插话**：正在回复时提交消息不会打断当前回复，而是进入输入框上方的「排队」条，本轮回合结束后按顺序自动发送；每条可转「引导」（插队优先发送，仍不打断）或取消。
- **后台自启**：打开 VS Code 后即使不点侧边栏，也会在后台拉起 `dsh --profile acp` 并预建会话（模型列表立即可用；`deepseekHarness.autoStartRuntime` 可关闭）。
- **权限控制**：严格模式（`read-only`）下每次写文件/执行命令都在侧边栏卡片里批准；侧边栏隐藏时回退 VS Code 模态弹窗。
- **模型目录修正**：隐藏已下线旧名 `deepseek-v4-flash`，默认模型跟随 DSH 设置里的 `agent-default-model`（DeepSeek-V4.1-Flash）。
- **抗 DSH 更新**：不依赖 ACP SDK，自带容错 JSON-RPC/stdio 客户端、启动探测、profile 自愈、能力降级与 `compat` 契约测试。

## 安装

### 前置条件

- VS Code **1.100+**
- Node.js **22+**
- 本机已安装 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（桌面端，或 `npm i -g @deepseek-ai/dsh`）

### 从 GitHub Releases 安装（推荐给朋友）

下载最新 `deepseek-harness-vX.Y.Z.vsix`，然后：

```powershell
code --install-extension deepseek-harness-v0.9.0.vsix
```

重载窗口。若之前装过旧版 `xliang.dsh-review`，先卸载：

```powershell
code --uninstall-extension xliang.dsh-review
```

> 社区扩展 `lixxx1.dsh-sidebar` 占用了 `deepseekHarness` 的容器/命令/配置 ID，安装本扩展前请禁用它：
> `code --disable-extension lixxx1.dsh-sidebar`

### 从源码构建

```powershell
npm ci
npm run build
npm run package
code --install-extension deepseek-harness.vsix --force
```

## 快速开始

1. 打开一个**受信任的工作区文件夹**（新工作区 = 项目根目录）。
2. 右侧辅助侧边栏 → `Other Views` → **DeepSeek Harness**（或命令面板 `DeepSeek Harness: 打开侧边栏`）。首次打开会自动启动 DSH。
3. 把光标放在要分析的代码文件里（可选中一段代码），直接发消息或执行审查命令。
4. 审查：编辑器右上角图标 / 右键菜单 / 命令面板：

| 命令 | 说明 |
|---|---|
| `DeepSeek Harness: 审查当前文件` | 只审查焦点文件 |
| `DeepSeek Harness: 审查选中代码` / `解释选中代码` | 审查/解释选区 |
| `DeepSeek Harness: 审查工作区改动` / `审查暂存区改动` / `审查某个提交` | 基于 git diff |
| `DeepSeek Harness: 修复最近审查发现的问题` | 修复全部 findings |
| `DeepSeek Harness: 修复这个问题` | 单条 finding（诊断灯泡/侧边栏） |
| `DeepSeek Harness: 撤销本轮修改` | 撤销最近一轮 DSH 的文件改动 |
| `DeepSeek Harness: 查看本轮改动` / `清除审查结果` | diff / 清理 |
| `DeepSeek Harness: 兼容性诊断` | 生成 DSH 兼容性报告 |

### 输入区控件

输入区是一个圆角卡片：上下文 chips → 输入框 → 一行工具栏（窄侧边栏自动折行）。所有下拉都走同一套**二级菜单**（分区标题、图标 + 中文名 + 英文小字 + 右侧说明、当前项勾选、键盘可达），不再使用原生 `<select>`。

| 控件 | 说明 |
|---|---|
| `＋` 菜单 | 分区：添加上下文 / 模式（自动 · 计划 · 目标）/ 审查（当前文件 · 改动 · 解释选区）/ 会话（新建 · 历史 · 本轮改动 · 清除审查结果）/ 更多（诊断 · 设置 · 重启） |
| 模式徽标 | 仅在计划 / 目标模式激活时出现在工具栏；点击打开 `＋` 菜单切换模式。计划模式只读，写入请求会被自动拒绝（卡片 warning 描边） |
| 权限菜单 | 三档预设 `工作区内` / `只读` / `完全权限` + 一行「自动审查本轮改动」。完全权限标 danger 色；计划模式下自动审查行禁用。切换预设会写入设置、重启运行时并续接当前会话 |
| 模型 / 推理 chip | 合并成一个入口：`模型名 [用量] 推理等级 ⌄`。点开是「模型 … ›」「推理等级 … ›」两行摘要面板，分别进入分组模型列表与推理滑块（子面板带「← 返回」）；列表已隐藏下线的 `deepseek-v4-flash` |
| 上下文用量 | 合并 chip 内的环形进度 + 百分比（`usage_update.used/size`），>90% 转 warning 色；`size` 未知时退回 token 数字徽标 |
| 字号 | 顶部 `⋯` →「显示 / 字号」滑块（80%–180%），松手即时生效，等同 `deepseekHarness.fontScale` |
| 排队 / 引导 | 处理中提交 = 排队（输入框上方显示排队条，可转「引导」插队优先发送或取消）；`Enter` 排队、`Ctrl+Enter` 引导，都不会打断当前回复 |
| 发送 / 停止 | 圆形 `↑` 发送（处理中用于排队）；处理中另有一个 `■` 停止键（`Esc` 同样可停止）；输入为空时发送禁用 |

> 自动审查不再单独占一个开关，已并入权限菜单；顶部 `⋯` 菜单提供新建 / 历史 / 本轮改动 / 清除审查结果 / 诊断 / 设置 / 重启。VS Code 原生标题栏只保留 新建会话 / 会话历史 / 重启 三个图标动作。

### 斜杠指令

在输入框敲 `/` 会弹出指令面板（`↑` `↓` 选择、`Enter` / `Tab` 执行、`Esc` 关闭）。指令**在本地执行、不会发送给模型**；未知指令按普通文本发送，带额外正文的 `/xxx 正文` 也按普通文本发送。

| 指令 | 作用 |
|---|---|
| `/plan` | 进入计划模式（只读分析，写入请求自动拒绝） |
| `/plan off` | 退出计划模式，回到自动 |
| `/goal` | 进入目标模式（跨轮次追踪完成目标） |
| `/goal off` | 退出目标模式，回到自动 |
| `/auto` | 退出计划 / 目标，回到自动模式 |
| `/new` | 新建 DSH 会话 |
| `/history` | 打开会话历史面板 |
| `/review` | 审查当前编辑器里的文件 |
| `/clear` | 清除审查结果与编辑器诊断 |
| `/permission` | 打开权限菜单（含自动审查行） |
| `/model` | 打开模型菜单 |
| `/diagnose` | 生成 DSH 兼容性诊断报告 |
| `/settings` | 打开 DeepSeek Harness 设置 |
| `/help` | 查看全部指令（选中后把用法填回输入框） |

快捷打开侧边栏（可选）：

```powershell
code --open-url "vscode://xliang.deepseek-harness/open"
```

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `deepseekHarness.executable` | `""` | `dsh` 路径；留空自动探测（PATH → DSH 桌面端 → npx） |
| `deepseekHarness.profile` | `"acp"` | 启动的 profile |
| `deepseekHarness.permissionMode` | `"workspace-write"` | `DSH_PERMISSION_MODE`；`read-only` = 每次写/命令都批准 |
| `deepseekHarness.autoApprove` | `"ask"` | `all` 自动批准（危险） |
| `deepseekHarness.autoContext` | `"selection-first"` | 自动上下文：选区优先 / 只带文件 / 关闭 |
| `deepseekHarness.autoContextMaxChars` | `40000` | 自动上下文最大字符数 |
| `deepseekHarness.preferredModel` | `""` | 首选模型 `provider/model`；留空读 DSH 设置 |
| `deepseekHarness.hideLegacyModels` | `true` | 隐藏已下线旧模型名 |
| `deepseekHarness.workspaceRootIndex` | `0` | 多根工作区选择 |
| `deepseekHarness.maxReviewChars` | `60000` | 审查输入上限 |
| `deepseekHarness.saveTranscriptLimit` | `50` | 本地保留会话数 |
| `deepseekHarness.fontScale` | `1` | 侧边栏字体大小 / 字号缩放（0.8–1.8，1 = 跟随 VS Code 字号），改动即时生效；也可在侧边栏 `⋯` 菜单实时调整 |
| `deepseekHarness.autoStartRuntime` | `true` | 扩展激活时后台自动拉起 DSH 运行时（无需先打开侧边栏）；关闭后仅在打开侧边栏时启动 |
| `deepseekHarness.showChangesNotice` | `true` | 本轮改动提示 |
| `deepseekHarness.checkCompatOnVersionChange` | `true` | DSH 版本变化时自检 |
| `deepseekHarness.compat.autoRepair` | `true` | ACP profile 自愈（先备份） |

## 关于模型

`deepseek-v4-flash` 是 DeepSeek 的旧模型名，请求实际由 `deepseek-flash`（显示名 **DeepSeek-V4.1-Flash**）提供。DSH 的 ACP 出厂 profile 把默认模型写成了这个旧名，0.2 起本扩展会隐藏它，并按你的 DSH 用户设置（`~/.dsh/profiles/web/cordis.patch.yml` 的 `agent-default-model`）自动选模型。

## 安全与隐私

- 扩展只在本地启动 `dsh`，不自建网络服务、不收集遥测。
- API Key 由 DSH 自己的凭据库管理，扩展不读取。
- Webview 使用严格 CSP 与消毒后的 Markdown。
- 默认 `workspace-write` 下 DSH 可在工作区内直接改文件；想“改前批准”请切 `read-only`。
- 撤销本轮修改会在开始前记录 git 快照与未跟踪文件内容；若你中途手改过文件会整体拒绝。

## 已知限制

- 官方没有 VS Code 插件，本扩展是社区实现；DSH 升级到不兼容的 ACP v2 时需要发版适配（`npm run compat` 会报警）。
- ACP 只暴露 `model` / `reasoning_effort` 两个会话配置项，**没有** DSH 原生 modes：计划 / 目标模式是扩展侧的提示词指导 + 客户端权限闸门，`exit_plan_mode` 工具在 ACP 会话中不可用；目标模式的自动续轮也不由扩展保证。
- **权限切换会重启运行时**：ACP 不提供运行时切换沙箱的接口（`DSH_PERMISSION_MODE` 只在 DSH 启动时读取），因此切换 `工作区内 / 只读 / 完全权限` 预设会重启 DSH 运行时并自动续接当前会话；重启会**丢失「撤销本轮修改」的内存基线**，正在生成时也会拒绝切换。
- 「完全权限」由 DSH 自身的 approval never 实现，扩展不再做会话级自动批准；开启后 DSH 沙箱不再限制在工作区内，请谨慎使用。
- 自动审查每轮会额外消耗一次模型调用（更慢、更贵），默认关闭。
- 自动上下文/文件级审查靠提示词与“不下发 resource_link”约束；ACP 没有禁用工具的能力，模型仍可能自行读取其它文件。
- 图片附件仅支持 PNG / JPEG / WebP / GIF，单张 ≤5MB；音频/视频不在 ACP image 能力内，会被跳过并提示。图片能否真正被模型看到取决于当前路由与 DSH 的附件存储配置（`imagePrompts` 能力）。
- 后台自启会在 VS Code 启动后约 400ms 拉起一个 DSH 进程；不需要可在设置里关闭 `deepseekHarness.autoStartRuntime`（关闭后仅在打开侧边栏时启动）。
- 撤销仅支持 git 仓库、最近一轮、窗口重载后失效；不处理 ignored 文件；二进制/超大/用户中途修改会拒绝。
- Quick Fix 只针对最近一次审查的 findings；文件改动后行号可能偏移。
- 非 git 工作区可用文件/选区审查；改动类功能需要 git。
- 会话标题为本地根据首条消息生成（ACP 不提供标题接口）。

## 开发

```powershell
npm ci
npm run typecheck
npm test
npm run build
npm run compat   # 真实 DSH 契约检查
npm run smoke    # 真实 ACP 握手
npm run smoke:ext
$env:SMOKE_STRICT="1"; npm run smoke:ext
npm run package
```

架构见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)，UI 设计见 [docs/UI.md](docs/UI.md)，贡献指南见 [CONTRIBUTING.md](CONTRIBUTING.md)，安全策略见 [SECURITY.md](SECURITY.md)，发布流程见 [PUBLISHING.md](PUBLISHING.md)。

## License

MIT
