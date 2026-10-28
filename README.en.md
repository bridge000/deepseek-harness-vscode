# DeepSeek Harness for VS Code

Bring **DeepSeek Harness (DSH)** into the VS Code secondary sidebar through the official **ACP (Agent Client Protocol)** interface: chat, automatic context, file-scoped code review, Quick Fix, and undo-turn.

> **Unofficial community extension.** Not affiliated with DeepSeek. It is a VS Code client around the official ACP automation surface; it does not patch DSH and does not depend on third-party bridges.
>
> 中文文档：[README.md](README.md)

> Screenshots welcome: this repository intentionally ships no UI screenshots yet (to avoid publishing a personal desktop); contributions can add them under `docs/images/`.

## Features

- **Sidebar chat** — streaming replies, tool cards, thought chain, session history, a combined model + reasoning entry, and a context-window usage ring.
- **Automatic context** — attaches the *focused* editor's file or current selection (with surrounding lines); no manual `@` file picking. Many open tabs do not matter — only the focused one is sent.
- **File-scoped review** — review current file / selection / working-tree diff / staged diff / a commit. Prompts are restricted to the embedded content instead of scanning the whole repository.
- **Diagnostics Quick Fix** — findings become VS Code diagnostics; the lightbulb offers "Fix with DeepSeek Harness", either per finding or all at once from the sidebar.
- **Undo turn** — restore files changed by the latest agent turn (`git stash create` snapshot + untracked-file snapshot + hash guard). Git repos only, latest turn only.
- **Composer menus** — the `+` menu (context / mode / review / session / more), permission menu (workspace-write / read-only / danger-full-access + auto review), the combined model/reasoning entry and the topbar `⋯` menu (including display / font size) all share one custom two-level popover; native `<select>`s and the standalone review toggle are gone.
- **Image attachments** — pick workspace images or "choose images from disk…" in the `+` menu, or drag files from Explorer; images are embedded as ACP image content blocks (PNG/JPEG/WebP/GIF, ≤5MB each) and audio/video get an explicit unsupported hint.
- **Slash commands** — type `/` in the composer to open the palette; `/plan`, `/goal`, `/review`, `/permission`, `/help` and nine more run locally and are never sent to the model.
- **Prompts stay out of the transcript** — review / fix / auto-review instruction bodies are logged only; the sidebar shows a one-line label. Chat bubbles show only what you typed.
- **Auto review** — after a turn that changed files, review that turn's diff (including new files) and publish findings to the panel and diagnostics. The toggle lives in the permission menu.
- **Permission presets** — workspace-write / read-only / danger-full-access, persisted to `deepseekHarness.permissionMode`; switching restarts the DSH runtime and resumes the current session (refused while a turn is running).
- **Plan / goal modes** — plan injects read-only planning guidance and rejects writes automatically; goal steers the goal toolchain. ACP exposes no native modes, so these are client-side modes (see limitations).
- **Launch screen** — an empty conversation shows the official whale mark above the official `deepseek HARNESS` wordmark (vectors extracted from the DSH client UI package), fading in and out.
- **Queued interjections** — submitting while a turn is running never interrupts it; the message goes into a queue bar above the composer and is sent in order once the turn settles. Each item can be promoted to a steering message (sent first, still without interrupting) or cancelled.
- **Background autostart** — the DSH runtime is spawned in the background shortly after VS Code starts (and a session is pre-created so the model list is ready), even if the sidebar is never opened (disable with `deepseekHarness.autoStartRuntime`).
- **Permission control** — in `read-only` mode every write/command is approved in the sidebar card (falls back to a VS Code modal when the sidebar is hidden).
- **Model hygiene** — hides the retired `deepseek-v4-flash` alias and follows your DSH `agent-default-model` (DeepSeek-V4.1-Flash by default).
- **DSH update resilience** — no ACP SDK dependency; tolerant JSON-RPC/stdio client, startup probes, profile self-repair, capability degradation, and a `compat` contract check.

## Install

Requirements: VS Code **1.100+**, Node.js **22+**, and a local [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) installation (desktop app or `npm i -g @deepseek-ai/dsh`).

Install from GitHub Releases:

```sh
code --install-extension deepseek-harness-v0.9.0.vsix
```

If you installed the old `xliang.dsh-review`, remove it first:

```sh
code --uninstall-extension xliang.dsh-review
```

The community extension `lixxx1.dsh-sidebar` uses the same `deepseekHarness` view/command/config ids; disable it:

```sh
code --disable-extension lixxx1.dsh-sidebar
```

From source:

```sh
npm ci
npm run build
npm run package
code --install-extension deepseek-harness.vsix --force
```

## Quick start

1. Open a trusted workspace folder.
2. Secondary sidebar → `Other Views` → **DeepSeek Harness** (or Command Palette: `DeepSeek Harness: 打开侧边栏`). The runtime starts automatically.
3. Focus the file you want to analyze (optionally select code) and chat or run a review command.
4. Review commands: review current file / selection / working-tree diff / staged diff / a commit; `Fix findings`, `Undo turn`, `Show turn changes`.

### Composer

The composer is a single rounded card: context chips → textarea → one toolbar row (wraps in narrow sidebars). Every dropdown uses the same **two-level popover** (section titles, icon + Chinese label + English hint + description, checkmark on the current item, keyboard navigable) instead of a native `<select>`.

| Control | Behaviour |
|---|---|
| `+` menu | Sections: add context / mode (auto · plan · goal) / review (current file · changes · explain selection) / session (new · history · turn changes · clear findings) / more (diagnose · settings · restart) |
| Mode badge | Appears in the toolbar only while plan / goal mode is active; click it to open the `+` menu and switch. Plan mode is read-only and rejects writes. |
| Permission menu | Three presets `工作区内` / `只读` / `完全权限` plus an "auto review this turn's changes" row. Danger-full-access uses the danger color; auto review is disabled in plan mode. Switching a preset persists the setting, restarts the runtime and resumes the current session. |
| Model / reasoning chip | One combined entry: `model [usage] effort ⌄`. Clicking opens a two-row summary panel ("模型 … ›" / "推理等级 … ›") that leads to the provider-grouped model list and the reasoning slider (sub-panels have "← 返回"); the retired `deepseek-v4-flash` stays hidden. |
| Context usage | Ring progress + percentage inside the combined chip (`usage_update.used/size`), turns warning-colored above 90%; falls back to the token count when `size` is unknown. |
| Font size | Topbar `⋯` → "显示 / 字号" slider (80%–180%), applied on release; same as `deepseekHarness.fontScale`. |
| Queue / steer | Submitting while busy queues the message (queue bar above the composer; promote to steer or cancel). `Enter` queues, `Ctrl+Enter` steers; neither interrupts the running turn. |
| Send / stop | Circular `↑` sends (queues while busy); a separate `■` stop button appears while busy (`Esc` also stops); send is disabled for an empty draft. |

Auto review is no longer a separate toggle — it lives in the permission menu. The topbar `⋯` menu holds new session / history / turn changes / clear findings / diagnose / settings / restart; VS Code's native view title keeps only the new-session / history / restart icon actions.

### Slash commands

Type `/` in the composer to open the palette (`↑` `↓` to move, `Enter` / `Tab` to run, `Esc` to close). Commands run **locally and are never sent to the model**; unknown commands and `/xxx some text` are sent as plain text.

| Command | Effect |
|---|---|
| `/plan` | Enter plan mode (read-only analysis, writes rejected) |
| `/plan off` | Leave plan mode, back to auto |
| `/goal` | Enter goal mode (track the objective across turns) |
| `/goal off` | Leave goal mode, back to auto |
| `/auto` | Leave plan / goal, back to auto mode |
| `/new` | Start a new DSH session |
| `/history` | Open the session history panel |
| `/review` | Review the file in the active editor |
| `/clear` | Clear findings and editor diagnostics |
| `/permission` | Open the permission menu (including the auto-review row) |
| `/model` | Open the model menu |
| `/diagnose` | Generate a DSH compatibility report |
| `/settings` | Open DeepSeek Harness settings |
| `/help` | List all commands (picking one fills its usage back into the composer) |

Open the sidebar from a URL (optional):

```sh
code --open-url "vscode://xliang.deepseek-harness/open"
```

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `deepseekHarness.executable` | `""` | `dsh` path; empty = auto-detect (PATH → desktop app → npx) |
| `deepseekHarness.profile` | `"acp"` | DSH profile to boot |
| `deepseekHarness.permissionMode` | `"workspace-write"` | `DSH_PERMISSION_MODE`; `read-only` = approve every write/command |
| `deepseekHarness.autoApprove` | `"ask"` | `all` auto-approves permission requests (dangerous) |
| `deepseekHarness.autoContext` | `"selection-first"` | selection first / file only / off |
| `deepseekHarness.autoContextMaxChars` | `40000` | auto-context size cap |
| `deepseekHarness.preferredModel` | `""` | `provider/model`; empty = read DSH settings |
| `deepseekHarness.hideLegacyModels` | `true` | hide retired model aliases |
| `deepseekHarness.workspaceRootIndex` | `0` | multi-root workspace selection |
| `deepseekHarness.maxReviewChars` | `60000` | review prompt cap |
| `deepseekHarness.saveTranscriptLimit` | `50` | local transcript retention |
| `deepseekHarness.fontScale` | `1` | sidebar font size / scale (0.8–1.8, 1 = follow the VS Code font size); applies immediately, also adjustable from the `⋯` menu |
| `deepseekHarness.autoStartRuntime` | `true` | spawn the DSH runtime in the background when the extension activates (no need to open the sidebar first) |
| `deepseekHarness.showChangesNotice` | `true` | notify after a turn changed files |
| `deepseekHarness.checkCompatOnVersionChange` | `true` | re-probe after DSH updates |
| `deepseekHarness.compat.autoRepair` | `true` | rebuild a broken ACP profile (backup first) |

## About `deepseek-v4-flash`

It is a retired DeepSeek model id; requests are served by `deepseek-flash` (displayed as **DeepSeek-V4.1-Flash**). DSH's ACP profile still pins the old id by default. This extension hides it and follows your DSH `agent-default-model` preference.

## Security & privacy

- Local only; the extension spawns `dsh`, exposes no network service and collects no telemetry.
- API keys are managed by DSH's credential store; the extension never reads them.
- The webview uses a strict CSP and sanitized Markdown.
- Review and undo-turn snapshots stay on your machine.

## Known limitations

- Official VS Code support does not exist; this is a community client. Incompatible ACP v2 changes require an extension release (`npm run compat` reports it).
- ACP only exposes `model` / `reasoning_effort` config options and **no** native DSH modes: plan / goal are client-side prompt guidance plus a permission gate, and `exit_plan_mode` is unusable on an ACP session; goal auto-continuation is not guaranteed.
- **Switching permissions restarts the runtime** — ACP offers no runtime sandbox switch (`DSH_PERMISSION_MODE` is read when the DSH process starts), so changing the `工作区内 / 只读 / 完全权限` preset restarts the DSH runtime and resumes the current session. The restart **drops the in-memory undo-turn baseline** and is refused while a turn is running.
- `danger-full-access` is enforced by DSH's own approval-never policy (the extension no longer auto-approves per session); the sandbox no longer limits writes to the workspace, so use it carefully.
- Auto review costs one extra model turn per changing turn (slower, pricier) and is off by default.
- File scoping relies on prompt restrictions (ACP cannot disable tools), so a model may still read other files on its own.
- Image attachments are limited to PNG / JPEG / WebP / GIF, ≤5MB each; audio/video are outside ACP's image capability and are skipped with a hint. Whether the model actually sees an image depends on the route and DSH's attachment-store configuration (`imagePrompts` capability).
- Background autostart spawns a DSH process ~400ms after VS Code starts; disable `deepseekHarness.autoStartRuntime` to start it only when the sidebar opens.
- Undo turn: git only, latest turn only, lost after a window reload, binary/large files refused, manual edits abort the revert.
- Quick Fix targets the latest review only; line numbers can drift after edits.
- Non-git workspaces support file/selection review only.
- Session titles are derived locally from the first message (ACP exposes no title surface).

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/UI.md](docs/UI.md), [SECURITY.md](SECURITY.md), and [PUBLISHING.md](PUBLISHING.md).

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run compat
npm run smoke
npm run smoke:ext
```

## License

MIT
