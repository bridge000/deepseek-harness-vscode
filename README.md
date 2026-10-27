# DeepSeek Harness for VS Code

把 **DeepSeek Harness（DSH）** 接进 VS Code 右侧辅助侧边栏，走 DSH 官方 **ACP（Agent Client Protocol）** 自动化接口：聊天、自动上下文、文件级代码审查、诊断 Quick Fix、撤销本轮修改。

> **非官方社区扩展**：本项目与 DeepSeek 官方无隶属关系，只是套在官方 ACP 接口外面的 VS Code 客户端；不改 DSH 本体、不依赖非官方 bridge。
>
> 中文文档：本页 · English: [README.en.md](README.en.md)

> 截图待补：本仓库暂不包含界面截图（避免提交个人桌面画面），欢迎贡献者补充到 `docs/images/`。

## 功能

- **侧边栏聊天**：流式回复、工具调用卡片、思考链、会话历史、模型 / 推理强度切换、token 用量。
- **自动上下文**：自动附带**当前焦点编辑器**的文件内容；有选区只带选区（前后各 20 行）。同时打开多个文件也只认当前焦点那个，不需要手动 `@` 选文件。
- **文件级代码审查**：审查当前文件 / 选中代码 / 工作区改动 / 暂存区 / 某个提交；提示词限制只分析内嵌内容，不主动遍历项目。
- **诊断 Quick Fix**：审查发现以 VS Code 诊断呈现，编辑器灯泡可直接「用 DeepSeek Harness 修复」，也可在侧边栏逐条修复。
- **撤销本轮修改**：DSH 改完文件后可一键恢复到本轮开始前（`git stash create` 快照 + 未跟踪文件快照 + 哈希校验），仅 git 仓库、仅最近一轮。
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
code --install-extension deepseek-harness-v0.3.0.vsix
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
- 自动上下文/文件级审查靠提示词与“不下发 resource_link”约束；ACP 没有禁用工具的能力，模型仍可能自行读取其它文件。
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
