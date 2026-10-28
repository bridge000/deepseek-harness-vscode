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
const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepseek-harness-smoke-'));
const cwd = projectRoot;
const strictMode = process.env.SMOKE_STRICT === '1';
const smokeWorkspace = strictMode ? fs.mkdtempSync(path.join(os.tmpdir(), 'deepseek-harness-ws-')) : cwd;
const configOverrides = strictMode ? { permissionMode: 'read-only' } : {};

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

function makeDocument(uri, content) {
	const text = content ?? 'const a = 1;\nexport function add(a, b) {\n\treturn a + b;\n}\n';
	const lines = text.split(/\r?\n/);
	return {
		uri,
		fileName: uri.fsPath,
		languageId: 'typescript',
		lineCount: lines.length,
		version: 1,
		isDirty: false,
		isUntitled: false,
		getText: (range) => (range ? text.slice(0, 0) : text),
		lineAt: (line) => ({ text: lines[line] ?? '', range: new Range(line, 0, line, (lines[line] ?? '').length) }),
		positionAt: () => new Position(0, 0),
		offsetAt: () => 0,
		save: async () => true,
	};
}

function makeEditor(uri, content) {
	return {
		document: makeDocument(uri, content),
		selection: { isEmpty: true, start: new Position(0, 0), end: new Position(0, 0) },
	};
}

function focusedEditor() {
	if (strictMode) return undefined;
	const file = path.join(projectRoot, 'src', 'types.ts');
	return makeEditor(Uri.file(file), fs.readFileSync(file, 'utf8'));
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
			activeTextEditor: focusedEditor(),
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
			registerUriHandler: () => ({ dispose: () => undefined }),
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
			onDidChangeTextEditorSelection: () => ({ dispose: () => undefined }),
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
			registerCodeActionsProvider: () => ({ dispose: () => undefined }),
		},
		CodeActionKind: { QuickFix: { value: 'quickfix' } },
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
			workspaceFolders: [{ uri: Uri.file(smokeWorkspace), name: path.basename(smokeWorkspace), index: 0 }],
			textDocuments: [],
			getConfiguration: (section) => ({
				get: (key, fallback) =>
					Object.prototype.hasOwnProperty.call(configOverrides, key) ? configOverrides[key] : fallback,
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
			onDidChangeConfiguration: () => ({ dispose: () => undefined }),
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
	extension: { packageJSON: { version: '0.9.0' } },
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
	console.log(`DeepSeek Harness 扩展宿主冒烟（cwd=${cwd}，storage=${storageDir}）`);
	await extension.activate(context);

	const ids = [...commandHandlers.keys()];
	check(ids.length >= 14, `注册了 ${ids.length} 个命令`);
	check(registeredProviders.has('deepseekHarness.chat'), '注册了侧边栏 webview provider');

	const provider = registeredProviders.get('deepseekHarness.chat').provider;
	const view = makeView();
	provider.resolveWebviewView(view, {}, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) });
	check(typeof view.webview.html === 'string' && view.webview.html.includes('Content-Security-Policy'), '注入带 CSP 的 webview HTML');
	check(view.webview.html.includes('dist/webview/main.js') || view.webview.html.includes('/main.js'), 'HTML 引用 dist/webview/main.js');

	receiveFromWebview({ type: 'ready' });
	await delay(200);
	const bootPhase = lastState()?.runtime?.phase;
	check(bootPhase === 'stopped' || bootPhase === 'starting', `激活后运行时状态：${bootPhase}（后台自动启动中）`);
	check(view.webview.options?.enableScripts === true, 'webview 脚本已启用');
	check(
		lastState()?.mode === 'agent' &&
			lastState()?.autoReview === false &&
			lastState()?.permissionMode === (strictMode ? 'read-only' : 'workspace-write'),
		`输入区默认状态：自动 / 审查关 / 权限=${strictMode ? 'read-only' : 'workspace-write'}`,
	);

	console.log('  … 后台自动启动：不调用 openChat，等运行时 ready');
	await waitFor(() => lastState()?.runtime?.phase === 'ready', 120000, '后台自动启动到 ready');
	check(true, '未打开聊天面板即自动拉起 DSH 运行时（autoStartRuntime）');
	const state = lastState();
	check(state.runtime.protocolVersion === 1, `ACP protocolVersion=${String(state.runtime.protocolVersion)}`);
	check(typeof state.runtime.dshVersion === 'string' && state.runtime.dshVersion.length > 0, `DSH 版本=${state.runtime.dshVersion}`);
	check(state.runtime.capabilities.sessionList === true, 'session/list 能力可用');
	// 回归：后台自启/打开面板时预建会话，模型配置项无需先发消息就应就绪。
	await waitFor(
		() =>
			(lastState()?.configOptions ?? []).some(
				(option) => option.category === 'model' || option.id === 'model',
			),
		60000,
		'后台预建会话后下发模型配置项',
	);
	check(true, '未发送消息前模型配置项已就绪（修复"刚启动时模型选项加载不出来"）');

	console.log('  … 输入区模式与权限预设');
	receiveFromWebview({ type: 'setMode', mode: 'plan' });
	await delay(150);
	check(lastState()?.mode === 'plan', '模式切换为「计划」');
	check(
		posted.some((message) => message.type === 'prefs' && message.mode === 'plan'),
		'prefs 增量消息已推送到侧边栏',
	);
	receiveFromWebview({ type: 'setAutoReview', enabled: true });
	await delay(150);
	check(lastState()?.autoReview === true, '自动审查开关已开启');

	receiveFromWebview({ type: 'setFontScale', value: 1.2 });
	await delay(150);
	check(lastState()?.fontScale === 1.2, '字号切换为 120%');
	check(
		posted.some((message) => message.type === 'prefs' && message.fontScale === 1.2),
		'prefs 增量消息已推送字号变更',
	);
	receiveFromWebview({ type: 'setFontScale', value: 1 });
	await delay(150);
	check(lastState()?.fontScale === 1, '字号已复位为 100%');

	// 运行时已 ready，切权限会真的重启 DSH 运行时并等待新进程就绪。
	const initialPermission = strictMode ? 'read-only' : 'workspace-write';
	await receiveFromWebview({ type: 'setPermissionMode', mode: 'read-only' });
	check(lastState()?.permissionMode === 'read-only', '权限切换为「只读」');
	await receiveFromWebview({ type: 'setPermissionMode', mode: 'danger-full-access' });
	check(lastState()?.permissionMode === 'danger-full-access', '权限切换为「完全权限」');
	check(
		posted.some((message) => message.type === 'prefs' && message.permissionMode === 'danger-full-access'),
		'prefs 增量消息已推送权限变更',
	);
	await receiveFromWebview({ type: 'setPermissionMode', mode: initialPermission });
	check(lastState()?.permissionMode === initialPermission, `权限已复位为 ${initialPermission}`);

	receiveFromWebview({ type: 'setMode', mode: 'agent' });
	receiveFromWebview({ type: 'setAutoReview', enabled: false });
	await delay(150);
	check(
		lastState()?.mode === 'agent' && lastState()?.autoReview === false,
		'模式与自动审查已复位，后续流程不受影响',
	);

	console.log('  … 打开聊天面板（运行时由后台自启就绪）');
	await commandHandlers.get('deepseekHarness.openChat')();
	await waitFor(() => lastState()?.runtime?.phase === 'ready', 120000, '运行时 ready');

	console.log('  … 自动上下文检查');
	const autoContextMessage = posted.filter((message) => message.type === 'autoContext').pop();
	if (strictMode) {
		check(autoContextMessage?.info?.kind === 'none', '严格模式（无焦点编辑器）自动上下文为空');
	} else {
		check(autoContextMessage?.info?.kind !== 'none', `自动上下文已推送：${JSON.stringify(autoContextMessage?.info ?? null).slice(0, 140)}`);
		check(String(autoContextMessage?.info?.path ?? '').includes('types.ts'), '自动上下文指向当前焦点文件');
	}

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

	const modelOption = afterTurn.configOptions.find((option) => option.category === 'model' || option.id === 'model');
	const modelValues = modelOption?.values ?? [];
	check(!modelValues.some((value) => String(value.value).includes('deepseek-v4-flash')), '模型列表已隐藏旧名 deepseek-v4-flash');
	check(!String(modelOption?.currentValue ?? '').includes('deepseek-v4-flash'), `当前模型已不是旧名：${String(modelOption?.currentValue ?? '')}`);
	check(modelValues.some((value) => String(value.value).includes('deepseek-flash')), '模型列表包含 DeepSeek-V4.1-Flash');
	check(
		String(modelOption?.currentValue ?? '').includes(`deepseek-flash`),
		'已按 DSH 设置自动选择 DeepSeek-V4.1-Flash',
	);

	if (strictMode) {
		console.log('  … 严格模式权限卡片（read-only 写文件）');
		const target = path.join(smokeWorkspace, 'smoke-permission.txt');
		receiveFromWebview({
			type: 'send',
			text: '请在工作区根目录创建一个名为 smoke-permission.txt 的文件，内容为 hello。完成后只回复 OK。',
		});
		const handled = new Set();
		const deadline = Date.now() + 240000;
		while (Date.now() < deadline && !fs.existsSync(target)) {
			const permission = posted
				.filter((message) => message.type === 'permission')
				.find((message) => message.request && !handled.has(message.request.id));
			if (permission) {
				handled.add(permission.request.id);
				check(Array.isArray(permission.request.options) && permission.request.options.length > 0, '权限卡片带有选项');
				const allow = permission.request.options.find((option) => String(option.kind).startsWith('allow_')) ?? permission.request.options[0];
				receiveFromWebview({ type: 'permissionResponse', requestId: permission.request.id, optionId: allow.optionId });
			}
			await delay(400);
		}
		check(fs.existsSync(target), '严格模式允许后文件已创建');
		await waitFor(() => lastState()?.busy === false, 180000, '权限任务结束');
	} else {
		console.log('  … 排队插话：运行中提交自动排队，引导不打断当前回复');
		const slow = receiveFromWebview({ type: 'send', text: '请只回复两个字：收到。' });
		await waitFor(() => lastState()?.busy === true, 30000, '运行时进入 busy');
		receiveFromWebview({ type: 'send', text: '排队消息：请只回复 OK。', pendingMode: 'queue' });
		await waitFor(() => (lastState()?.pending ?? []).length === 1, 10000, '运行中发送进入排队');
		const queued = lastState().pending[0];
		check(queued?.mode === 'queue' && String(queued?.text).includes('排队消息'), '运行中发送自动进入排队队列');
		receiveFromWebview({ type: 'pendingAction', id: queued.id, action: 'steer' });
		await waitFor(() => lastState()?.pending?.[0]?.mode === 'steer', 10000, '排队消息转为引导');
		const steered = lastState().pending[0];
		check(steered?.mode === 'steer', '排队消息可一键转为引导');
		receiveFromWebview({ type: 'pendingAction', id: steered.id, action: 'cancel' });
		await waitFor(() => (lastState()?.pending ?? []).length === 0, 10000, '排队消息可取消');
		check((lastState()?.pending ?? []).length === 0, '引导/排队消息可取消');
		await slow;
		await waitFor(() => lastState()?.busy === false, 180000, '排队测试的当前回复结束');
		check(
			!(lastState()?.transcript ?? []).some((entry) => entry.kind === 'user' && String(entry.text).includes('OK')),
			'被取消的排队消息没有发送',
		);

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
		await commandHandlers.get('deepseekHarness.reviewFile')(reviewUri);
		await waitFor(() => posted.some((message) => message.type === 'findings'), 180000, '审查结果推送到侧边栏');
		const findingsMessage = posted.filter((message) => message.type === 'findings').pop();
		check(Array.isArray(findingsMessage.findings), `审查结果已推送（findings=${findingsMessage.findings.length}）`);
		check(!posted.some((message) => message.type === 'error'), '审查过程无错误');
		const reviewState = lastState();
		check(
			reviewState.transcript.some((entry) => entry.kind === 'user' && String(entry.text).includes('审查')),
			'审查请求出现在会话记录里',
		);
		const reviewUserEntries = reviewState.transcript.filter((entry) => entry.kind === 'user');
		const reviewUserEntry = reviewUserEntries[reviewUserEntries.length - 1];
		check(
			reviewUserEntry !== undefined &&
				String(reviewUserEntry.text).length < 200 &&
				!String(reviewUserEntry.text).includes('资深代码审查员') &&
				!String(reviewUserEntry.text).includes('输出格式'),
			`审查提示词正文未进入用户气泡（气泡=${JSON.stringify(String(reviewUserEntry?.text ?? '')).slice(0, 80)}）`,
		);
	}

	console.log('  … 新建会话：提示走 toast，不写对话流');
	await commandHandlers.get('deepseekHarness.newSession')();
	await delay(800);
	check(
		posted.some((message) => message.type === 'toast' && String(message.message).includes('已新建会话')),
		'新建会话提示以 toast 推送',
	);
	const newSessionState = lastState();
	check(
		!newSessionState.transcript.some(
			(entry) => entry.kind === 'notice' && String(entry.text).includes('已新建会话'),
		),
		'新建会话提示不再写入对话流（启动页不会被遮挡）',
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
		if (strictMode) {
			try {
				fs.rmSync(smokeWorkspace, { recursive: true, force: true });
			} catch {
				/* ignore */
			}
		}
	});
