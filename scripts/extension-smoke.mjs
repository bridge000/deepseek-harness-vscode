/**
 * Extension-host smoke test without VS Code: stubs the `vscode` module, loads
 * the real bundled extension, resolves the sidebar webview and drives a real
 * ACP round-trip against the locally installed DSH CLI.
 *
 * This catches wiring bugs that unit tests cannot (provider registration,
 * command ids, webview message protocol, runtime bootstrap, transcript flow).
 *
 * Usage: npm run smoke:ext   (after npm run build)
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const Module = require('node:module');

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-review-smoke-'));
const cwd = projectRoot;

const logs = [];
const messages = [];
const clipboard = { text: '' };

class Uri {
	constructor(scheme, authority, uriPath) {
		this.scheme = scheme;
		this.authority = authority;
		this.path = uriPath;
		this.query = '';
		this.fragment = '';
		this.fsPath = scheme === 'file' ? path.win32.normalize(uriPath.replace(/^\//, '')) : uriPath;
	}
	static file(filePath) {
		const normalized = path.resolve(filePath).replace(/\\/g, '/');
		return new Uri('file', '', normalized.startsWith('/') ? normalized : `/${normalized}`);
	}
	static parse(value) {
		const url = new URL(value);
		return new Uri(url.protocol.replace(/:$/, ''), url.host, decodeURIComponent(url.pathname));
	}
	static joinPath(base, ...parts) {
		return new Uri(base.scheme, base.authority, path.posix.join(base.path, ...parts.map((part) => String(part).replace(/\\/g, '/'))));
	}
	toString() {
		return `${this.scheme}://${this.authority}${this.path}`;
	}
	with() {
		return this;
	}
}

class Position {
	constructor(line, character) {
		this.line = line;
		this.character = character;
	}
}
class Range {
	constructor(startLine, startCharacter, endLine, endCharacter) {
		this.start = new Position(startLine, startCharacter);
		this.end = new Position(endLine, endCharacter);
	}
}
class Selection extends Range {}
class Diagnostic {
	constructor(range, message, severity) {
		this.range = range;
		this.message = message;
		this.severity = severity;
	}
}
class ThemeColor {
	constructor(id) {
		this.id = id;
	}
}

function makeDocument(uri) {
	const text = 'const a = 1;\nexport function add(a, b) {\n\treturn a + b;\n}\n';
	return {
		uri,
		fileName: uri.fsPath,
		languageId: 'typescript',
		lineCount: 4,
		version: 1,
		isDirty: false,
		isUntitled: false,
		getText: (range) => (range ? text.slice(0, 0) : text),
		lineAt: (line) => ({ text: '', range: new Range(line, 0, line, 0) }),
		positionAt: () => new Position(0, 0),
		offsetAt: () => 0,
		save: async () => true,
	};
}

const commandHandlers = new Map();
const registeredProviders = new Map();
const commandLog = [];
let receiveFromWebview = () => undefined;

function makeVscode() {
	return {
		Uri,
		Range,
		Position,
		Selection,
		Diagnostic,
		ThemeColor,
		DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
		StatusBarAlignment: { Left: 1, Right: 2 },
		ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2 },
		Disposable: class Disposable {
			constructor(fn) {
				this.fn = fn;
			}
			dispose() {
				this.fn?.();
			}
		},
		EventEmitter: class EventEmitter {
			constructor() {
				this.listeners = new Set();
				this.event = (listener) => {
					this.listeners.add(listener);
					return { dispose: () => this.listeners.delete(listener) };
				};
			}
			fire(value) {
				for (const listener of this.listeners) listener(value);
			}
			dispose() {
				this.listeners.clear();
			}
		},
		window: {
			activeTextEditor: undefined,
			visibleTextEditors: [],
			createOutputChannel: () => ({
				appendLine: (line) => logs.push(String(line)),
				append: (line) => logs.push(String(line)),
				show: () => undefined,
				dispose: () => undefined,
			}),
			createStatusBarItem: () => ({
				text: '',
				tooltip: '',
				command: '',
				backgroundColor: undefined,
				show: () => undefined,
				hide: () => undefined,
				dispose: () => undefined,
			}),
			registerWebviewViewProvider: (id, provider, options) => {
				registeredProviders.set(id, { provider, options });
				return { dispose: () => registeredProviders.delete(id) };
			},
			showInformationMessage: async (...args) => {
				messages.push({ kind: 'info', text: String(args[0]) });
				return undefined;
			},
			showWarningMessage: async (...args) => {
				messages.push({ kind: 'warning', text: String(args[0]) });
				return undefined;
			},
			showErrorMessage: async (...args) => {
				messages.push({ kind: 'error', text: String(args[0]) });
				return undefined;
			},
			showQuickPick: async () => undefined,
			showTextDocument: async (uri) => ({ uri, document: makeDocument(uri), selection: undefined }),
			onDidChangeActiveTextEditor: () => ({ dispose: () => undefined }),
		},
		commands: {
			registerCommand: (id, handler) => {
				commandHandlers.set(id, handler);
				return { dispose: () => commandHandlers.delete(id) };
			},
			executeCommand: async (command, ...args) => {
				commandLog.push({ command, args });
				const handler = commandHandlers.get(command);
				if (handler) return handler(...args);
				return undefined;
			},
		},
		languages: {
			createDiagnosticCollection: (name) => ({
				name,
				set: () => undefined,
				delete: () => undefined,
				clear: () => undefined,
				dispose: () => undefined,
			}),
		},
		env: {
			clipboard: {
				writeText: async (text) => {
					clipboard.text = text;
				},
				readText: async () => clipboard.text,
			},
			openExternal: async () => true,
		},
		workspace: {
			workspaceFolders: [{ uri: Uri.file(cwd), name: path.basename(cwd), index: 0 }],
			textDocuments: [],
			getConfiguration: (section) => ({
				get: (key, fallback) => (section === 'dshReview' ? fallback : fallback),
				has: () => false,
				inspect: () => undefined,
				update: async () => undefined,
			}),
			findFiles: async () => [],
			openTextDocument: async (uriOrPath) => makeDocument(typeof uriOrPath === 'string' ? Uri.file(uriOrPath) : uriOrPath),
			fs: {
				readFile: async () => new Uint8Array(),
				writeFile: async () => undefined,
				stat: async () => ({ type: 1, ctime: 0, mtime: 0, size: 0 }),
				createDirectory: async () => undefined,
				delete: async () => undefined,
			},
			onDidSaveTextDocument: () => ({ dispose: () => undefined }),
			onDidChangeTextDocument: () => ({ dispose: () => undefined }),
			onDidOpenTextDocument: () => ({ dispose: () => undefined }),
			onDidChangeWorkspaceFolders: () => ({ dispose: () => undefined }),
		},
	};
}

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
	if (request === 'vscode') return makeVscode();
	return originalLoad.call(this, request, parent, isMain);
};

const extensionPath = path.join(projectRoot, 'dist', 'extension.js');
if (!fs.existsSync(extensionPath)) {
	console.error('dist/extension.js 不存在，请先运行 npm run build');
	process.exit(2);
}
const extension = require(extensionPath);

const globalStateStore = new Map();
const context = {
	subscriptions: [],
	extensionUri: Uri.file(projectRoot),
	extensionPath: projectRoot,
	extension: { packageJSON: { version: '0.1.0' } },
	globalStorageUri: Uri.file(storageDir),
	storageUri: Uri.file(storageDir),
	globalState: {
		get: (key, fallback) => (globalStateStore.has(key) ? globalStateStore.get(key) : fallback),
		update: async (key, value) => {
			globalStateStore.set(key, value);
		},
		keys: () => [...globalStateStore.keys()],
	},
	workspaceState: {
		get: (_key, fallback) => fallback,
		update: async () => undefined,
	},
	secrets: { get: async () => undefined, store: async () => undefined, delete: async () => undefined },
	asAbsolutePath: (p) => path.join(projectRoot, p),
	environmentVariableCollection: {},
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const posted = [];

function makeView() {
	return {
		visible: true,
		show: () => undefined,
		webview: {
			options: undefined,
			html: '',
			cspSource: 'vscode-webview://smoke',
			asWebviewUri: (uri) => uri,
			onDidReceiveMessage: (callback) => {
				receiveFromWebview = callback;
				return { dispose: () => undefined };
			},
			postMessage: async (message) => {
				posted.push(message);
				return true;
			},
		},
		onDidChangeVisibility: () => ({ dispose: () => undefined }),
		onDidDispose: () => ({ dispose: () => undefined }),
	};
}

function fail(message) {
	console.error(`\n✗ ${message}`);
	console.error(`\n最近的状态消息：`);
	for (const message_ of posted.slice(-6)) console.error(JSON.stringify(message_).slice(0, 600));
	console.error(`\n最近的日志：`);
	for (const line of logs.slice(-40)) console.error(line);
	process.exitCode = 1;
	throw new Error(message);
}

async function waitFor(check, timeoutMs, description) {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		if (check()) return;
		await delay(150);
	}
	fail(`等待超时：${description}（${timeoutMs}ms）`);
}

function lastState() {
	for (let index = posted.length - 1; index >= 0; index -= 1) {
		if (posted[index].type === 'state') return posted[index].state;
	}
	return undefined;
}

const checks = [];
const check = (ok, message) => {
	console.log(`${ok ? '  ✓' : '  ✗'} ${message}`);
	checks.push(ok);
	if (!ok) process.exitCode = 1;
};

async function main() {
	console.log(`DSH Review 扩展宿主冒烟（cwd=${cwd}，storage=${storageDir}）`);
	await extension.activate(context);

	const ids = [...commandHandlers.keys()];
	check(ids.length >= 14, `注册了 ${ids.length} 个命令`);
	check(registeredProviders.has('dshReview.chat'), '注册了侧边栏 webview provider');

	const provider = registeredProviders.get('dshReview.chat').provider;
	const view = makeView();
	provider.resolveWebviewView(view, {}, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) });
	check(typeof view.webview.html === 'string' && view.webview.html.includes('Content-Security-Policy'), '注入带 CSP 的 webview HTML');
	check(view.webview.html.includes('dist/webview/main.js') || view.webview.html.includes('/main.js'), 'HTML 引用 dist/webview/main.js');

	receiveFromWebview({ type: 'ready' });
	await delay(200);
	check(lastState()?.runtime?.phase === 'stopped', '初始状态为 stopped');
	check(view.webview.options?.enableScripts === true, 'webview 脚本已启用');

	console.log('  … 打开侧边栏并启动真实 DSH ACP 运行时');
	await commandHandlers.get('dshReview.openChat')();
	await waitFor(() => lastState()?.runtime?.phase === 'ready', 120000, '运行时 ready');
	const state = lastState();
	check(state.runtime.protocolVersion === 1, `ACP protocolVersion=${String(state.runtime.protocolVersion)}`);
	check(typeof state.runtime.dshVersion === 'string' && state.runtime.dshVersion.length > 0, `DSH 版本=${state.runtime.dshVersion}`);
	check(state.runtime.capabilities.sessionList === true, 'session/list 能力可用');

	console.log('  … 通过侧边栏协议发送一条真实消息');
	receiveFromWebview({ type: 'send', text: '请只回复两个字：收到。' });
	await waitFor(
		() => {
			const current = lastState();
			if (!current) return false;
			const assistant = current.transcript.filter((entry) => entry.kind === 'assistant' && entry.text.trim().length > 0);
			return current.busy === false && assistant.length > 0;
		},
		180000,
		'收到 assistant 回复',
	);
	const afterTurn = lastState();
	const assistant = afterTurn.transcript.filter((entry) => entry.kind === 'assistant');
	check(assistant.length > 0, `assistant 条目 ${assistant.length} 个：${String(assistant[0]?.text ?? '').slice(0, 40)}`);
	check(afterTurn.configOptions.some((option) => option.category === 'model' || option.id === 'model'), '模型配置项已下发到侧边栏');
	check(Array.isArray(afterTurn.history), '历史会话字段存在');
	check(!posted.some((message) => message.type === 'error'), '没有向 webview 推送错误消息');

	console.log('  … 切换推理强度');
	const reasoning = afterTurn.configOptions.find((option) => option.category === 'thought_level' || option.id === 'reasoning_effort');
	if (reasoning) {
		const target = reasoning.values.find((value) => value.value === 'low') ?? reasoning.values[0];
		receiveFromWebview({ type: 'setConfig', configId: reasoning.id, value: target.value });
		await delay(2000);
		const updated = lastState()?.configOptions.find((option) => option.id === reasoning.id);
		check(updated?.currentValue === target.value, `推理强度切换为 ${target.value}`);
	} else {
		check(true, '运行时不提供 reasoning 配置，跳过切换');
	}

	console.log('  … 运行一次真实代码审查');
	const reviewUri = Uri.file(path.join(cwd, 'src', 'types.ts'));
	await commandHandlers.get('dshReview.reviewFile')(reviewUri);
	await waitFor(() => posted.some((message) => message.type === 'findings'), 180000, '审查结果推送到侧边栏');
	const findingsMessage = posted.filter((message) => message.type === 'findings').pop();
	check(Array.isArray(findingsMessage.findings), `审查结果已推送（findings=${findingsMessage.findings.length}）`);
	check(!posted.some((message) => message.type === 'error'), '审查过程无错误');
	const reviewState = lastState();
	check(
		reviewState.transcript.some((entry) => entry.kind === 'user' && String(entry.text).includes('审查')),
		'审查请求出现在会话记录里',
	);

	console.log('  … 关闭扩展');
	for (const subscription of context.subscriptions) {
		try {
			await subscription.dispose?.();
		} catch {
			/* ignore */
		}
	}
	await delay(2500);
}

main()
	.then(() => {
		const failed = checks.filter((ok) => ok === false).length;
		console.log(failed === 0 ? '\n结果：通过' : `\n结果：${failed} 项失败`);
		process.exitCode = failed === 0 ? 0 : 1;
	})
	.catch((error) => {
		if (process.exitCode !== 1) console.error(error);
		process.exitCode = 1;
	})
	.finally(() => {
		try {
			fs.rmSync(storageDir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	});
