# UI design notes

The sidebar is a narrow (280–520 px) chat surface. The design goals are borrowed from Claude Code and the DSH web UI: compact chrome, clear message hierarchy, quiet tool/thought output, and fast review workflows.

## Layout

```
┌ header ─────────────────────────────┐
│ ● 会话标题…        [模型] [⋯ 菜单] │
├ transcript ─────────────────────────┤
│                                      │
│              user bubble ────────────│
│  ✦ DSH 角色行 / markdown             │
│  ▸ ✦ 已思考 3 秒                     │
│  ▸ tool: read src/a.ts        done   │
│  [findings panel: 错误 2 · 警告 1]   │
│                                      │
├ permission card (when needed) ───────┤
├ composer ────────────────────────────┤
│ [自动上下文：src/a.ts（选区 12-30）] │
│ textarea…                            │
│ ＋上下文   模型▾  推理▾        ●发送 │
└──────────────────────────────────────┘
```

## Principles

- **One thing per line.** Tool calls and thoughts collapse to one row; details expand on demand.
- **No repeated labels.** Role labels are shown once per message group as a small meta line.
- **Quiet chrome.** Runtime metadata (DSH/ACP version, tokens) lives in tooltips/details, not permanent rows.
- **Review-first.** Findings are actionable: severity filters, jump-to-line, per-finding Quick Fix.
- **Safe by default.** Permission cards are visually prominent; `read-only` mode is the approve-before-edit path.
- **Theme-native.** Only `--vscode-*` variables, no custom colors that break dark/light/high-contrast.

## Tokens

Defined at the top of `src/webview/style.css`: `--space-*`, `--radius-*`, `--font-size-*`, `--transition`, and component-specific variables. Prefer these over literals when adding UI.

## Components

| Component | Notes |
|---|---|
| Header | status dot (runtime state/busy), local session title, model pill, overflow menu (new/history/restart/settings/diagnose) |
| Transcript | user bubble right-aligned; assistant full width; timestamps/copy on hover |
| Thought chain | collapsed one-liner `已思考 N 秒`; streaming `思考中…`; dim body with left rule |
| Tool row | compact title + status dot + kind/duration; expandable detail and file links |
| Findings panel | collapsible; severity chips; jump; per-finding fix; fix-all/clear |
| Permission card | sticky above composer; primary allow / secondary reject; command monospace; file links |
| Composer | auto-context chip row; auto-growing textarea; attach + compact selects + send/stop |
| Empty state | quick actions (review file/changes, explain selection, new session) + recent sessions |
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
