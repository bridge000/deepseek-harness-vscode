# DeepSeek Harness for VS Code

Bring **DeepSeek Harness (DSH)** into the VS Code secondary sidebar through the official **ACP (Agent Client Protocol)** interface: chat, automatic context, file-scoped code review, Quick Fix, and undo-turn.

> **Unofficial community extension.** Not affiliated with DeepSeek. It is a VS Code client around the official ACP automation surface; it does not patch DSH and does not depend on third-party bridges.
>
> 中文文档：[README.md](README.md)

> Screenshots welcome: this repository intentionally ships no UI screenshots yet (to avoid publishing a personal desktop); contributions can add them under `docs/images/`.

## Features

- **Sidebar chat** — streaming replies, tool cards, thought chain, session history, model / reasoning effort, token usage.
- **Automatic context** — attaches the *focused* editor's file or current selection (with surrounding lines); no manual `@` file picking. Many open tabs do not matter — only the focused one is sent.
- **File-scoped review** — review current file / selection / working-tree diff / staged diff / a commit. Prompts are restricted to the embedded content instead of scanning the whole repository.
- **Diagnostics Quick Fix** — findings become VS Code diagnostics; the lightbulb offers "Fix with DeepSeek Harness", either per finding or all at once from the sidebar.
- **Undo turn** — restore files changed by the latest agent turn (`git stash create` snapshot + untracked-file snapshot + hash guard). Git repos only, latest turn only.
- **Permission control** — in `read-only` mode every write/command is approved in the sidebar card (falls back to a VS Code modal when the sidebar is hidden).
- **Model hygiene** — hides the retired `deepseek-v4-flash` alias and follows your DSH `agent-default-model` (DeepSeek-V4.1-Flash by default).
- **DSH update resilience** — no ACP SDK dependency; tolerant JSON-RPC/stdio client, startup probes, profile self-repair, capability degradation, and a `compat` contract check.

## Install

Requirements: VS Code **1.100+**, Node.js **22+**, and a local [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) installation (desktop app or `npm i -g @deepseek-ai/dsh`).

Install from GitHub Releases:

```sh
code --install-extension deepseek-harness-v0.3.0.vsix
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
- File scoping relies on prompt restrictions (ACP cannot disable tools), so a model may still read other files on its own.
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
