# UI design notes

The sidebar is a narrow (280–520 px) chat surface. The design goals are borrowed from Claude Code and the DSH web UI: compact chrome, clear message hierarchy, quiet tool/thought output, and fast review workflows.

## Layout

```
┌ header ─────────────────────────────┐
│ ● 会话标题…                    [⋯]  │
├ transcript ─────────────────────────┤
│                                      │
│              user bubble ────────────│
│  ✦ DSH 角色行 / markdown             │
│  ▸ ✦ 已思考 3 秒                     │
│  ▸ tool: read src/a.ts        done   │
│  [findings panel: 错误 2 · 警告 1]   │
│                                      │
├ permission card (when needed) ───────┤
├ composer (one rounded card) ─────────┤
│ [自动上下文：src/a.ts（选区 12-30）] │
│ textarea…                            │
│ [＋] [计划] [工作区内⌄]              │
│        [1017] [模型⌄] [High⌄] [↑]    │
│ 状态提醒行（仅 计划/只读/完全权限/自动审查）│
└──────────────────────────────────────┘

popover（`＋` / 权限 / 模型 / 推理 / 顶部 `⋯` 共用同一套）
┌ 添加内容 ──────────────────┐
│ 添加上下文                 │
│   ▤ 选择文件或文件夹…      │
│ 模式                       │
│   ✓ 自动        auto       │
│     计划        plan       │
│     目标        goal       │
│ 审查 / 会话 / 更多 …       │
└────────────────────────────┘
```

Above the transcript sits VS Code's native view title: the container name plus
**icon-only** actions (new session / history / restart). No text-labelled action
may be added — VS Code renders those as the full command title and overflows the
header (the 0.4 header bug). The webview has its own topbar `⋯` menu for session /
review / more actions.

Empty state (no transcript): the official whale mark (`FISH_LOGO_PATH`) on top
(transparent, 56 px wide, drawn with the theme foreground color so there is no
tile/background mismatch), then the official DSH wordmark (`deepseek` + boxed
`HARNESS`, 26 px high) extracted from `@deepseek-ai/dsh-client-ui-primitives`,
one status line and a row of text quick actions. No placeholder glyph, no
subtitle, no recent-session cards, no black tile behind the mark. Neither the
whale nor the letterforms are redrawn: they are the same vectors the DSH
web/desktop UI uses (`src/webview/brand.ts`), and the HARNESS badge letters take
the sidebar background color so the lockup inverts correctly per theme. The
launch screen is shown whenever the transcript has **no conversation rows**
(user / assistant / thought / tool); notice-only transcripts such as
"已新建会话。" or a runtime error keep it visible. It fades in over 200 ms with a
small rise and a subtle whale scale-in, fades out (~140 ms) once the first
conversation row arrives, and is instant under `prefers-reduced-motion`.

## Composer console

One rounded card: context chips → textarea → a single toolbar row that wraps in
narrow sidebars. Left group: `+` menu, mode badge (only in plan / goal), permission
menu. Right group: one combined model/reasoning chip (model name, context-usage
ring, effort label, caret) and the circular send button. Toasts render directly
above the card inside the composer column, so showing one never covers content.
Every dropdown is the same self-drawn two-level popover (section titles, icon +
Chinese label + English hint + description, checkmark on the current item, keyboard
navigable); native `<select>` elements and the standalone review toggle were removed.

| Control | Behaviour |
|---|---|
| `+` | Unified menu: add context / mode (`auto / plan / goal`) / review (current file · changes · explain selection) / session (new · history · turn changes · clear findings) / more (diagnose · settings · restart). Attached refs become chips above the textarea. |
| Mode badge | Hidden in `auto`; in plan / goal it shows the mode and opens the `+` menu. Plan mode gets a warning border and warning-colored permission chip. |
| Permission menu | Three presets `工作区内 / 只读 / 完全权限` plus an **auto review this turn** row. Switching a preset persists `deepseekHarness.permissionMode`, restarts the DSH runtime and resumes the session (refused while busy). Danger-full-access uses the danger color; auto review is disabled in plan mode. |
| 模型 / 推理 | One chip (`模型名 [用量] 档位 ⌄`) opens a two-row summary panel: `模型 … ›` leads to the provider-grouped model list, `推理等级 … ›` leads to the range slider; both sub-panels start with `← 返回`. `modelMenuGroups` still builds the model rows (name, id hint, server description, checkmark); the slider previews on `input` and commits one `set_config_option` on `change`. |
| 上下文用量 | Ring + percentage from `usage_update.used/size` (warning color above 90%); tooltip shows the full `formatUsageText` detail; falls back to the compact token badge (`1017`, `12.3k`) when `size` is unknown. |
| 字号 | Topbar `⋯` → display section → `字号` slider (`80%…180%`), commits `setFontScale` on release and applies immediately; mirrors `deepseekHarness.fontScale`. |
| 排队 / 引导 | Submitting while `busy` never cancels the turn: the message is added to the pending bar above the composer (`PendingMessage`), sent in FIFO order after the turn settles; `steer` items are sent before `queue` items, still without interrupting. Each row can be promoted to steer or cancelled; `Enter` queues and `Ctrl+Enter` steers. |
| 发送 / 停止 | Circular accent `↑` sends (queues while busy); a separate `■` stop button is visible only while busy (`Esc` also stops); send is disabled while the draft is empty. |

Images: picked images or files dropped from Explorer become chips with a `图`
badge; they are sent as ACP `image` blocks (see `context/media.ts`), not links.
Audio/video are recognised and skipped with a toast hint.

The hint row is hidden unless plan mode / read-only / danger-full-access / auto
review is active; shortcut help lives in the textarea placeholder and title.

## Slash commands

Typing `/` as the whole input value opens the palette anchored to the textarea.
It filters as you type and closes once the token is a complete command or contains
a space / newline. Matching is a case-insensitive prefix over both the full `usage`
and its primary command, so `/pl` lists `/plan` and `/plan off`.

Palette keyboard: `↑` `↓` move, `Enter` / `Tab` execute, `Esc` close. Commands run
locally through `runSlashCommand` and never reach the model; unknown commands fall
through to a normal send. `parseSlashCommand` is exact-match only (`/plan`,
`/plan off`, `/PLAN`, trimmed/collapsed whitespace), so `/plan do X` is sent as
plain text. `/help` is read-only: picking a command fills its usage back into the
composer instead of executing it.


## Principles

- **One thing per line.** Tool calls and thoughts collapse to one row; details expand on demand.
- **One control row.** Everything the user changes per message lives on a single composer toolbar; the header carries only status, the session title and the overflow menu.
- **Machine output stays out of the conversation.** Findings JSON is stripped from the rendered assistant message and replaced with a one-line footnote; review prompts never render as user bubbles (only a label).
- **Quiet chrome.** Runtime metadata (DSH/ACP version, tokens) lives in tooltips/details, not permanent rows.
- **Review-first.** Findings are actionable: severity filters, jump-to-line, per-finding Quick Fix.
- **Safe by default.** Permission cards are visually prominent; `read-only` mode is the approve-before-edit path.
- **Theme-native.** Only `--vscode-*` variables, no custom colors that break dark/light/high-contrast; the launch screen is transparent and takes the theme foreground color, so it never clashes with the sidebar background.

## Tokens

Defined at the top of `src/webview/style.css`: `--space-*`, `--radius-*`, `--font-size-*`, `--dsh-font-*`, `--transition`, and component-specific variables. Prefer these over literals when adding UI.

`--dsh-font-scale` comes from the `deepseekHarness.fontScale` setting (0.8–1.8, default 1) and is set on the app root by `applyFontScale`; `1` follows the VS Code font size, larger values scale the transcript and composer together. It reacts live to configuration changes, including changes made from the `⋯` font-size slider (`setFontScale` message).

## Components

| Component | Notes |
|---|---|
| Header | status dot (runtime state/busy), local session title, overflow menu (`显示 / 字号`, session, review, more) |
| Transcript | user bubble right-aligned (label or typed text only); assistant full width; image refs show a `图` badge |
| Thought chain | collapsed one-liner `已思考 N 秒`; streaming `思考中…`; dim body with left rule |
| Tool row | compact title + status dot + kind/duration; expandable detail and file links |
| Findings panel | collapsible; severity chips; jump; per-finding fix; fix-all/clear |
| Permission card | sticky above composer; primary allow / secondary reject; command monospace; file links |
| Composer | rounded card: auto-context chip row; auto-growing textarea; one toolbar row (`+`, mode badge, permission, combined model/usage/effort chip, send); unified popover menus and the slash palette |
| Toast | inline row above the composer card, max height 72px with internal scroll; 3.5s (6s for errors) auto-hide |
| Pending bar | dashed rows above the composer card: `排队` / `引导` badge, one-line text, `引导` and `×` actions; hidden when empty |
| Launch state | transparent official whale mark + official `deepseek HARNESS` wordmark + status line + text quick actions |
| Scroll | stick-to-bottom; floating “back to bottom” button when scrolled up |

## Accessibility

- Focus-visible rings on every interactive element.
- `aria-live` for streaming assistant output; `role="log"` for the transcript.
- `prefers-reduced-motion` disables the thought pulse animation.
- Keyboard: Enter send, Shift+Enter newline, Esc stop (when busy), buttons reachable via Tab.

## Future ideas

- Inline diff preview inside permission cards.
- Session search over local transcripts.
- English UI localization.
