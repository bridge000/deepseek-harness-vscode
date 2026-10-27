# Security Policy

This extension is a local VS Code client for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). It does not run a network service of its own and does not collect telemetry.

## Security model

- The extension spawns the locally installed `dsh` CLI with the `acp` profile and speaks JSON-RPC over stdio.
- Tools run by the agent are executed by DeepSeek Harness, subject to its sandbox and approval policy (`deepseekHarness.permissionMode`).
- With the default `workspace-write` policy, DSH can modify files inside the workspace without asking. Switch to `read-only` for approve-before-edit behavior.
- Model requests go to the model provider configured in your DSH installation; API keys are read by DSH from its own credential store, never by this extension.
- The sidebar webview uses a strict Content-Security-Policy and sanitized Markdown; it has no network access.

## Reporting a vulnerability

Please do **not** open a public issue for security problems. Contact the maintainer privately (repository owner) with:

- affected version / commit,
- reproduction steps,
- impact assessment,
- suggested fix if available.

You should receive a response within a few days. Please allow time for a fix before public disclosure.

## Scope

In scope: extension host code, webview rendering, permission-card behavior, command injection risks in git/DSH invocation, credential leakage.

Out of scope: vulnerabilities inside DeepSeek Harness itself (report upstream), model provider behavior, and risks accepted by users who choose `danger-full-access`.
