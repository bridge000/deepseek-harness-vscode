/**
 * 侧边栏聊天视图（WebviewView）的扩展侧实现。
 *
 * 职责边界：
 * - 生成 webview HTML（CSP + nonce，脚本/样式都来自 `dist/webview`）；
 * - 校验并分发 webview -> 扩展的消息（统一走 `isWebviewToExt` / `isCommandId`）；
 * - 把控制器需要推送的增量消息（append/patch/permission/toast/...）转给 webview。
 *
 * 本文件不直接接触 ACP：所有业务动作都通过 `ChatController`（./contract）完成。
 */
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { ContextRef, Finding } from '../types';
import type { ChatViewDeps, ChatViewProvider } from './contract';
import { isCommandId, isWebviewToExt } from './protocol';
import type { ExtToWeb, WebviewToExt } from './protocol';

/** 与 package.json `contributes.views.deepseekHarness[0].id` 保持一致。 */
export const CHAT_VIEW_ID = 'deepseekHarness.chat';

function createNonce(): string {
	return randomBytes(16).toString('base64');
}

function describeError(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (typeof error === 'string') return error;
	return String(error);
}

function normalizeRefs(value: unknown): ContextRef[] {
	if (!Array.isArray(value)) return [];
	const refs: ContextRef[] = [];
	for (const item of value) {
		if (typeof item !== 'object' || item === null) continue;
		const ref = item as { name?: unknown; uri?: unknown };
		if (typeof ref.name !== 'string' || typeof ref.uri !== 'string') continue;
		refs.push({ name: ref.name, uri: ref.uri });
	}
	return refs;
}

/**
 * 生成 webview HTML。
 *
 * CSP：`default-src 'none'` 全禁，只放开本地资源（脚本用 nonce 放行，样式用
 * webview.cspSource + nonce 放行，图片只允许 data:）。脚本/样式都引用
 * `dist/webview` 下的构建产物，不内联大段代码。
 */
function buildHtml(webview: vscode.Webview, webviewRoot: vscode.Uri): string {
	const nonce = createNonce();
	const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(webviewRoot, 'main.js'));
	const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(webviewRoot, 'style.css'));
	const csp = [
		"default-src 'none'",
		`img-src ${webview.cspSource} data:`,
		`style-src ${webview.cspSource} 'nonce-${nonce}'`,
		`script-src 'nonce-${nonce}'`,
		`font-src ${webview.cspSource}`,
		"connect-src 'none'",
		"base-uri 'none'",
		"form-action 'none'",
	].join('; ');

	return `<!DOCTYPE html>
<html lang="zh-CN">
	<head>
		<meta charset="UTF-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1.0" />
		<meta http-equiv="Content-Security-Policy" content="${csp}" />
		<link rel="stylesheet" href="${styleUri.toString()}" nonce="${nonce}" />
		<title>DeepSeek Harness</title>
	</head>
	<body>
		<div id="app"></div>
		<script nonce="${nonce}" src="${scriptUri.toString()}"></script>
	</body>
</html>
`;
}

class ChatViewProviderImpl implements ChatViewProvider {
	readonly viewId = CHAT_VIEW_ID;

	private view: vscode.WebviewView | undefined;
	private readonly deps: ChatViewDeps;
	/** `onVisible` fires once so the controller can auto-start the runtime. */
	private notifiedVisible = false;

	constructor(deps: ChatViewDeps) {
		this.deps = deps;
	}

	resolveWebviewView(
		webviewView: vscode.WebviewView,
		_context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken,
	): void {
		this.view = webviewView;
		const webviewRoot = vscode.Uri.joinPath(this.deps.extensionUri, 'dist', 'webview');
		const options: vscode.WebviewOptions & { retainContextWhenHidden?: boolean } = {
			enableScripts: true,
			enableForms: false,
			localResourceRoots: [webviewRoot],
			// 视图 API 运行时支持该开关（隐藏时保留 DOM），但当前 @types/vscode 尚未暴露。
			retainContextWhenHidden: true,
		};
		webviewView.webview.options = options;
		webviewView.webview.html = buildHtml(webviewView.webview, webviewRoot);

		const messageSubscription = webviewView.webview.onDidReceiveMessage((raw: unknown) => {
			void this.handleMessage(raw);
		});
		const visibilitySubscription = webviewView.onDidChangeVisibility(() => {
			// 隐藏期间 post 被丢弃，重新可见时用全量状态恢复（Lead 也会在 openChat/reveal 后调用）。
			if (webviewView.visible) this.postState();
		});
		webviewView.onDidDispose(() => {
			messageSubscription.dispose();
			visibilitySubscription.dispose();
			if (this.view === webviewView) this.view = undefined;
		});
		if (!this.notifiedVisible) {
			this.notifiedVisible = true;
			try {
				this.deps.onVisible?.();
			} catch (error) {
				this.log(`[聊天视图] onVisible 回调失败：${describeError(error)}`);
			}
		}
	}

	/** 侧边栏当前是否可见（决定权限请求走卡片还是模态弹窗）。 */
	isVisible(): boolean {
		return this.view?.visible ?? false;
	}

	/** 推送一条协议消息；视图不可见（或尚未创建）时静默丢弃。 */
	post(message: ExtToWeb): void {
		const view = this.view;
		if (!view || !view.visible) return;
		const pending = view.webview.postMessage(message);
		void Promise.resolve(pending).then(undefined, (error: unknown) => {
			this.log(`[聊天视图] 推送 ${message.type} 消息失败：${describeError(error)}`);
		});
	}

	postState(): void {
		try {
			this.post({ type: 'state', state: this.deps.controller.getState() });
		} catch (error) {
			this.log(`[聊天视图] 读取界面状态失败：${describeError(error)}`);
		}
	}

	postFindings(findings: Finding[]): void {
		this.post({ type: 'findings', findings: Array.isArray(findings) ? findings : [] });
	}

	async reveal(): Promise<void> {
		const view = this.view;
		if (view) {
			view.show(true);
			return;
		}
		try {
			await vscode.commands.executeCommand(`${this.viewId}.focus`);
		} catch (error) {
			this.log(`[聊天视图] 打开侧边栏失败：${describeError(error)}`);
		}
	}

	private log(line: string): void {
		try {
			this.deps.log(line);
		} catch {
			// 日志本身失败不应该影响界面。
		}
	}

	private async handleMessage(raw: unknown): Promise<void> {
		if (!isWebviewToExt(raw)) {
			this.log('[聊天视图] 忽略未知的 webview 消息');
			return;
		}
		try {
			await this.dispatch(raw);
		} catch (error) {
			const message = describeError(error);
			this.log(`[聊天视图] 处理 ${raw.type} 消息失败：${message}`);
			this.post({ type: 'error', message: `操作失败：${message}` });
		}
	}

	private async dispatch(message: WebviewToExt): Promise<void> {
		const controller = this.deps.controller;
		switch (message.type) {
			case 'ready':
				this.postState();
				return;
			case 'send': {
				if (typeof message.text !== 'string' || message.text.trim().length === 0) return;
				await controller.send(message.text, normalizeRefs(message.refs));
				return;
			}
			case 'cancel':
				controller.cancel();
				return;
			case 'permissionResponse': {
				if (typeof message.requestId !== 'string' || message.requestId.length === 0) return;
				const optionId = typeof message.optionId === 'string' ? message.optionId : undefined;
				controller.permissionResponse(message.requestId, optionId);
				return;
			}
			case 'newSession':
				await controller.newSession();
				return;
			case 'resumeSession': {
				if (typeof message.sessionId !== 'string' || message.sessionId.length === 0) return;
				await controller.resumeSession(message.sessionId);
				return;
			}
			case 'setConfig': {
				if (typeof message.configId !== 'string' || message.configId.length === 0) return;
				if (typeof message.value !== 'string') return;
				await controller.setConfig(message.configId, message.value);
				return;
			}
			case 'pickContext': {
				const refs = await controller.pickContext();
				this.post({ type: 'contextRefs', refs: normalizeRefs(refs) });
				return;
			}
			case 'openFile': {
				if (typeof message.path !== 'string' || message.path.length === 0) return;
				const line = typeof message.line === 'number' ? message.line : undefined;
				controller.openFile(message.path, line);
				return;
			}
			case 'runCommand': {
				if (!isCommandId(message.command)) {
					this.log('[聊天视图] 忽略未知命令');
					return;
				}
				controller.runCommand(message.command);
				return;
			}
			case 'clearFindings':
				controller.clearFindings();
				return;
			case 'restartRuntime':
				await controller.restartRuntime();
				return;
			case 'openSettings':
				controller.openSettings();
				return;
			case 'copyDiagnostics':
				await controller.copyDiagnostics();
				return;
			default:
				return;
		}
	}
}

/** 创建侧边栏聊天视图 provider；由扩展在 `registerWebviewViewProvider` 时注册。 */
export function createChatViewProvider(deps: ChatViewDeps): ChatViewProvider {
	return new ChatViewProviderImpl(deps);
}
