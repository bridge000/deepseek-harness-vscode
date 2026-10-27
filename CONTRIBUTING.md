# Contributing

Thanks for helping improve DeepSeek Harness for VS Code! This is an unofficial community extension built on the official [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) ACP interface.

## Prerequisites

- Node.js **22 or 24**
- VS Code **1.100+**
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) installed locally (`dsh` CLI or desktop app). You only need it for the end-to-end smoke tests, not for unit tests.
- Windows / macOS / Linux; the repository is developed on Windows with PowerShell 7.

## Local setup

```sh
npm ci
npm run typecheck
npm test
npm run build
```

Load the extension for manual testing:

```sh
npm run package
code --install-extension deepseek-harness.vsix --force
```

## Project layout

```
src/acp/       ACP protocol types, JSON-RPC, stdio transport, runtime, compatibility probing
src/context/   auto context (focused-editor collector + pure builders)
src/model/     legacy model aliases, model preference parsing
src/session/   session manager, transcript persistence
src/review/    prompts, findings parsing, git helpers, diagnostics, change diff, quick fix, revert
src/ui/        sidebar provider, permission broker/modal, status bar, diagnose report
src/webview/   sidebar front end (vanilla TS + marked + DOMPurify)
test/          vitest unit tests
scripts/       build, compat, smoke, extension-host smoke
```

## Code style

- TypeScript, tabs for indentation, single quotes, semicolons.
- Keep pure logic free of `vscode` imports so it is unit-testable.
- User-facing strings in the extension UI are currently Chinese; document English changes in `README.en.md`.
- Do not add runtime dependencies unless necessary. The extension deliberately avoids ACP SDKs so upstream protocol changes are tolerated.

## Tests

- Unit tests must stay green: `npm test`.
- Add tests for every pure helper you touch.
- Real-DSH smoke tests (optional locally): `npm run compat`, `npm run smoke`, `npm run smoke:ext`, and `SMOKE_STRICT=1 npm run smoke:ext`.
- CI runs typecheck + unit tests + build on Node 22/24; DSH-dependent smoke tests are skipped in CI because no DSH runtime is installed there.

## Pull requests

1. Keep changes focused; describe the user-visible effect.
2. Include tests or explain why no test is practical.
3. Update `README.md` / `README.en.md` / `CHANGELOG.md` when behavior, commands, or settings change.
4. Never commit API keys, `.env` files, personal paths, or `node_modules`/`dist`/vsix artifacts.
5. Run `npm run typecheck && npm test && npm run build` before pushing.

## Commit messages

Prefer conventional commits: `feat:`, `fix:`, `docs:`, `test:`, `chore:`, `refactor:`.

## Security

See [SECURITY.md](SECURITY.md). Please report vulnerabilities privately rather than opening a public issue.
