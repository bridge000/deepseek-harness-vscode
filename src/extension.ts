import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';

import type { DshRuntime, ProbeResult, PromptDisplayOptions, SessionEvent, SessionService, TranscriptStore } from './acp/contracts';
import { discoverAcpProfiles, probeRuntime, repairAcpProfile } from './acp/compat';
import { createDshRuntime, resolveExecutable } from './acp/runtime';
import { findConfigOption, type ContentBlock, type ContentImage } from './acp/protocol';
import { readConfig } from './config';
import { createAutoContextCollector } from './context/autoContext';
import { imageMimeType, isImagePath, isUnsupportedMediaPath, MAX_IMAGE_BYTES } from './context/media';
import { Logger } from './log';
import { formatModelValue, normalizeModelOptions, parseModelValue, readDshPreferredModel, sameModelRef, type ModelRef } from './model';
import { modeLabel, modePromptBlock, permissionModeLabel, planModeRejectOption } from './mode/modes';
import type { ReviewInput, ReviewService } from './review/contracts';
import { registerFixCodeActions } from './review/quickFix';
import { createReviewService } from './review/service';
import { createSessionService } from './session/manager';
import { enqueuePending, promotePending, removePending, takeNextPending } from './session/pending';
import { createTranscriptStore } from './session/transcript';
import type {
	ActiveSession,
	AutoContextInfo,
	ConfigOption,
	ContextRef,
	Finding,
	PendingMessage,
	PermissionMode,
	PermissionRequest,
	RuntimeState,
	SessionInfo,
	SessionMode,
	TranscriptEntry,
	UiState,
	UsageInfo,
} from './types';
import { createChatViewProvider } from './ui/chatView';
import type { ChatController, ChatViewProvider, DiagnoseInput } from './ui/contract';
import { createPermissionPicker } from './ui/permissions';
import { createPermissionBroker, type PermissionBroker } from './ui/permissionBroker';
import { formatDiagnoseReport, showDiagnoseReport } from './ui/diagnose';
import type { CommandId } from './ui/protocol';
import { createStatusBar, type StatusBarController } from './ui/statusBar';

const VIEW_ID = 'deepseekHarness.chat';
const VERSION_KEY = 'deepseekHarness.lastGoodDshVersion';
const ACTIVE_SESSION_KEY = 'deepseekHarness.activeSessionId';
const LAST_MODEL_KEY = 'deepseekHarness.lastModel';
const MODE_KEY = 'deepseekHarness.sessionMode';
const AUTO_REVIEW_KEY = 'deepseekHarness.autoReview';

const EMPTY_CAPABILITIES: RuntimeState['capabilities'] = {
	sessionList: false,
	sessionResume: false,
	sessionClose: false,
	modelConfig: false,
	reasoningConfig: false,
	imagePrompts: false,
};

function stoppedRuntime(): RuntimeState {
	return { phase: 'stopped', capabilities: { ...EMPTY_CAPABILITIES } };
}

function uid(): string {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function fixPrompt(findingText: string): string {
	return [
		'下面是我刚完成的代码审查发现（JSON）。请修复其中值得修复的问题：',
		'',
		'```json',
		findingText,
		'```',
		'',
		'要求：直接在工作区里修改文件；保持改动最小；不要改动与问题无关的代码；',
		'完成后用中文简要说明每个问题怎么修的（文件:行号）。如果某个发现你认为不该修，说明理由。',
	].join('\n');
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const logger = new Logger('DeepSeek Harness');
	const controller = new DeepSeekHarnessController(context, logger);
	context.subscriptions.push({ dispose: () => logger.dispose() }, controller);
	await controller.init();
	logger.info('DeepSeek Harness 已激活（ACP 客户端）');
}

export async function deactivate(): Promise<void> {
	// Disposal is driven by the registered controller; nothing extra to do here.
}

class DeepSeekHarnessController implements ChatController, vscode.Disposable {
	private readonly context: vscode.ExtensionContext;
	private readonly logger: Logger;
	private provider?: ChatViewProvider;
	private statusBar?: StatusBarController;
	private review?: ReviewService;
	private transcriptStore?: TranscriptStore;
	private permissionBroker?: PermissionBroker;
	private autoContextEnabled = true;
	private autoContextInfo?: AutoContextInfo;
	private autoContextTimer?: NodeJS.Timeout;
	private lastModel?: ModelRef;
	/** Client-side collaboration mode (ACP has no session-mode surface). */
	private mode: SessionMode = 'agent';
	/** Review the turn's changes automatically once it settles. */
	private autoReview = false;
	/** Effective DSH permission preset; applied through the runtime env on (re)start. */
	private permissionMode: PermissionMode = 'workspace-write';
	/** Sidebar font scale (persisted via `deepseekHarness.fontScale`). */
	private fontScale = 1;
	/** Set while this controller itself writes `deepseekHarness.permissionMode`. */
	private applyingPermissionPreset = false;
	/** Background runtime autostart scheduled from `init()`. */
	private autoStartTimer?: NodeJS.Timeout;
	/** Guard against auto-review re-entry (its own prompt must not trigger another). */
	private autoReviewInFlight = false;

	private runtime?: DshRuntime;
	private sessionService?: SessionService;
	private probe?: ProbeResult;
	private launcherCandidates: string[] = [];
	private runtimeError?: string;

	private transcript: TranscriptEntry[] = [];
	private configOptions: ConfigOption[] = [];
	private findings: Finding[] = [];
	private history: SessionInfo[] = [];
	private usage?: UsageInfo;
	private busy = false;
	private activeSession?: ActiveSession;
	private pendingHistoryLoaded = false;
	private lastTurnChanges: string[] = [];
	private lastReviewLabel = '';
	private promptQueue: Promise<unknown> = Promise.resolve();
	/** Messages queued while the agent is busy (排队插话). */
	private pending: PendingMessage[] = [];
	private drainPromise?: Promise<void>;
	private sessionPromise?: Promise<ActiveSession>;
	private saveTimer?: NodeJS.Timeout;
	private readyPromise?: Promise<void>;
	private disposeSubscriptions: vscode.Disposable[] = [];
	private disposed = false;
	private lastRuntimeErrorShown?: string;
	private localTitle?: string;

	constructor(context: vscode.ExtensionContext, logger: Logger) {
		this.context = context;
		this.logger = logger;
	}

	async init(): Promise<void> {
		const storage = this.context.globalStorageUri.fsPath;
		this.transcriptStore = createTranscriptStore(path.join(storage, 'transcripts'), (line) => this.logger.raw(line));
		this.review = createReviewService({
			storageDir: path.join(storage, 'tmp'),
			maxReviewChars: readConfig().maxReviewChars,
			log: this.logger,
		});
		this.lastModel = this.context.globalState.get<ModelRef>(LAST_MODEL_KEY);
		const storedMode = this.context.globalState.get<string>(MODE_KEY);
		this.mode = storedMode === 'plan' || storedMode === 'goal' ? storedMode : 'agent';
		this.autoReview = this.context.globalState.get<boolean>(AUTO_REVIEW_KEY) === true;
		this.permissionMode = readConfig().permissionMode;
		this.fontScale = readConfig().fontScale;
		const modalPicker = createPermissionPicker({
			autoApprove: () => this.autoApproveEnabled(),
			log: (line) => this.logger.raw(line),
		});

		this.provider = createChatViewProvider({
			extensionUri: this.context.extensionUri,
			controller: this,
			log: (line) => this.logger.raw(line),
			onVisible: () => {
				this.refreshAutoContext();
				this.ensureReady()
					// 打开面板时顺手建好会话：ACP 的 model / reasoning 配置项只在
					// session/new 之后才下发，否则"刚启动时模型选项加载不出来"。
					.then(() => this.ensureSession())
					.catch((error: unknown) => {
						this.logger.warn(`自动启动运行时失败：${errorMessage(error)}`);
					});
			},
		});
		this.permissionBroker = createPermissionBroker({
			isViewVisible: () => this.provider?.isVisible() ?? false,
			postPermission: (request: PermissionRequest) => {
				this.provider?.post({ type: 'permission', request });
			},
			modalPick: modalPicker,
			autoApprove: () => this.autoApproveEnabled(),
			log: (line) => this.logger.raw(line),
			timeoutMs: 120_000,
		});
		this.context.subscriptions.push(
			vscode.window.registerWebviewViewProvider(VIEW_ID, this.provider, {
				webviewOptions: { retainContextWhenHidden: true },
			}),
			vscode.window.onDidChangeActiveTextEditor(() => this.scheduleAutoContextRefresh()),
			vscode.window.onDidChangeTextEditorSelection(() => this.scheduleAutoContextRefresh()),
			vscode.workspace.onDidChangeConfiguration((event) => this.onConfigurationChanged(event)),
			vscode.window.registerUriHandler({
				handleUri: async () => {
					await this.openChat();
				},
			}),
		);
		this.disposeSubscriptions.push(
			registerFixCodeActions({
				findings: () => this.findings,
				workspaceRoot: () => readConfig().workspaceRoot,
				log: this.logger,
			}),
		);
		this.statusBar = createStatusBar(() => {
			void vscode.commands.executeCommand('deepseekHarness.openChat');
		});
		this.context.subscriptions.push(this.statusBar);
		this.registerCommands();
		await this.restoreTranscript();
		this.refreshAutoContext();
		this.postState();
		this.scheduleRuntimeAutostart();
	}

	/**
	 * Start the DSH runtime in the background even if the sidebar was never
	 * opened (Claude-Code-like behaviour). `ensureReady()` is single-flight, so a
	 * later sidebar reveal or prompt reuses the same bootstrap.
	 */
	private scheduleRuntimeAutostart(): void {
		const config = readConfig();
		if (!config.autoStartRuntime || !config.workspaceRoot) return;
		this.autoStartTimer = setTimeout(() => {
			this.autoStartTimer = undefined;
			if (this.disposed) return;
			const latest = readConfig();
			if (!latest.autoStartRuntime || !latest.workspaceRoot) return;
			this.logger.info('后台自动启动 DSH 运行时');
			void this.ensureReady()
				// 后台预建会话，让面板一打开就有模型 / 推理配置项。
				.then(() => this.ensureSession())
				.catch((error: unknown) => {
					this.logger.warn(`后台自动启动 DSH 失败：${errorMessage(error)}`);
				});
		}, 400);
	}

	private registerCommands(): void {
		const register = (id: string, handler: (...args: unknown[]) => unknown): void => {
			this.disposeSubscriptions.push(vscode.commands.registerCommand(id, handler));
		};
		register('deepseekHarness.openChat', () => this.openChat());
		register('deepseekHarness.reviewFile', (uri?: unknown) => this.reviewFile(uri instanceof vscode.Uri ? uri : undefined));
		register('deepseekHarness.reviewSelection', () => this.reviewSelection('review'));
		register('deepseekHarness.explainSelection', () => this.reviewSelection('explain'));
		register('deepseekHarness.reviewChanges', () => this.reviewDiff('working'));
		register('deepseekHarness.reviewStaged', () => this.reviewDiff('staged'));
		register('deepseekHarness.reviewCommit', () => this.reviewDiff('commit'));
		register('deepseekHarness.fixFindings', () => this.fixFindings());
		register('deepseekHarness.fixFinding', (finding?: unknown) => this.fixFinding(finding));
		register('deepseekHarness.revertTurnChanges', () => this.revertTurnChanges());
		register('deepseekHarness.showTurnChanges', () => this.showTurnChanges());
		register('deepseekHarness.clearFindings', () => this.clearFindings());
		register('deepseekHarness.newSession', () => this.newSession());
		register('deepseekHarness.history', () => this.showHistory());
		register('deepseekHarness.restartRuntime', () => this.restartRuntime());
		register('deepseekHarness.diagnose', () => this.diagnose());
		register('deepseekHarness.configure', () => this.openSettings());
	}

	// ---------------------------------------------------------------- state ---

	getState(): UiState {
		const runtime = this.runtime?.state() ?? this.failedState() ?? stoppedRuntime();
		return {
			runtime,
			session: this.activeSession
				? {
						sessionId: this.activeSession.sessionId,
						cwd: this.activeSession.cwd,
						title: this.deriveLocalTitle(),
					}
				: undefined,
			busy: this.busy,
			configOptions: this.configOptions,
			transcript: this.transcript,
			findings: this.findings,
			history: this.history,
			usage: this.usage,
			autoContext: this.autoContextInfo,
			mode: this.mode,
			autoReview: this.autoReview,
			permissionMode: this.permissionMode,
			fontScale: this.fontScale,
			pending: [...this.pending],
		};
	}

	/** Local title from the first user message (ACP exposes no title surface). */
	private deriveLocalTitle(): string | undefined {
		const explicit = this.activeSession?.title;
		if (explicit && explicit.trim().length > 0) return explicit;
		for (const entry of this.transcript) {
			if (entry.kind === 'user' && entry.text.trim().length > 0) {
				const singleLine = entry.text.replace(/\s+/g, ' ').trim();
				return singleLine.length > 36 ? `${singleLine.slice(0, 36)}…` : singleLine;
			}
		}
		return undefined;
	}

	private failedState(): RuntimeState | undefined {
		if (!this.runtimeError) return undefined;
		return { phase: 'error', capabilities: { ...EMPTY_CAPABILITIES }, error: this.runtimeError };
	}

	private postState(): void {
		this.provider?.postState();
		this.statusBar?.update(this.getState().runtime, this.busy);
	}

	private setBusy(busy: boolean): void {
		this.busy = busy;
		this.provider?.post({ type: 'busy', busy });
		this.postState();
		if (!busy) this.drainPending();
	}

	private upsertEntry(entry: TranscriptEntry): void {
		const index = this.transcript.findIndex((item) => item.id === entry.id);
		if (index >= 0) this.transcript[index] = entry;
		else this.transcript.push(entry);
		if (this.transcript.length > 2000) this.transcript.splice(0, this.transcript.length - 2000);
	}

	private appendNotice(level: 'info' | 'warn' | 'error', text: string): void {
		const entry: TranscriptEntry = { id: uid(), kind: 'notice', level, text, at: Date.now() };
		this.upsertEntry(entry);
		this.provider?.post({ type: 'append', entries: [entry] });
		this.scheduleSave();
	}

	/**
	 * Transient status (session created, mode switched, runtime restarted …).
	 *
	 * Toasts stay out of the transcript on purpose: a notice row would otherwise
	 * count as "conversation started" and hide the whale launch screen.
	 */
	private postToast(level: 'info' | 'warn' | 'error', text: string): void {
		if (level === 'warn' || level === 'error') this.logger.warn(text);
		else this.logger.info(text);
		this.provider?.post({ type: 'toast', level, message: text });
	}

	private scheduleSave(): void {
		if (this.saveTimer) clearTimeout(this.saveTimer);
		this.saveTimer = setTimeout(() => {
			this.saveTimer = undefined;
			void this.saveTranscript();
		}, 700);
	}

	private async saveTranscript(): Promise<void> {
		const sessionId = this.activeSession?.sessionId;
		if (!sessionId || !this.transcriptStore) return;
		try {
			await this.transcriptStore.save(sessionId, this.transcript);
		} catch (error) {
			this.logger.warn(`保存会话记录失败：${errorMessage(error)}`);
		}
	}

	private async restoreTranscript(): Promise<void> {
		const sessionId = this.context.globalState.get<string>(ACTIVE_SESSION_KEY);
		if (!sessionId || !this.transcriptStore) return;
		try {
			const entries = this.transcriptStore.load(sessionId);
			if (entries.length > 0) {
				this.transcript = entries;
				this.pendingHistoryLoaded = true;
			}
		} catch (error) {
			this.logger.warn(`恢复本地会话记录失败：${errorMessage(error)}`);
		}
	}

	// ------------------------------------------------------- auto context ---

	private scheduleAutoContextRefresh(): void {
		if (this.autoContextTimer) clearTimeout(this.autoContextTimer);
		this.autoContextTimer = setTimeout(() => {
			this.autoContextTimer = undefined;
			this.refreshAutoContext();
		}, 200);
	}

	/** Collect the focused editor's file/selection and push it to the sidebar. */
	private refreshAutoContext(): void {
		if (this.disposed) return;
		if (!this.autoContextEnabled) {
			this.autoContextInfo = { kind: 'none' };
			this.provider?.post({ type: 'autoContext', info: this.autoContextInfo });
			return;
		}
		try {
			const config = readConfig();
			const collector = createAutoContextCollector({
				mode: config.autoContext,
				maxChars: config.autoContextMaxChars,
				workspaceRoot: config.workspaceRoot,
				log: this.logger,
			});
			const { info } = collector.collect();
			this.autoContextInfo = info;
			this.provider?.post({ type: 'autoContext', info });
		} catch (error) {
			this.logger.warn(`收集自动上下文失败：${errorMessage(error)}`);
		}
	}

	/** Auto context blocks for the next prompt; empty when disabled/unavailable. */
	private collectAutoContextBlocks(): ContentBlock[] {
		if (!this.autoContextEnabled || !readConfig().workspaceRoot) return [];
		try {
			const config = readConfig();
			const collector = createAutoContextCollector({
				mode: config.autoContext,
				maxChars: config.autoContextMaxChars,
				workspaceRoot: config.workspaceRoot,
				log: this.logger,
			});
			const { info, blocks } = collector.collect();
			if (info.kind === 'none') return [];
			this.autoContextInfo = info;
			this.provider?.post({ type: 'autoContext', info });
			return blocks;
		} catch (error) {
			this.logger.warn(`构建自动上下文失败：${errorMessage(error)}`);
			return [];
		}
	}

	setAutoContext(enabled: boolean): void {
		if (this.autoContextEnabled === enabled) return;
		this.autoContextEnabled = enabled;
		this.logger.info(`自动上下文已${enabled ? '开启' : '关闭'}`);
		this.refreshAutoContext();
		this.postState();
	}

	// -------------------------------------------------- modes and toggles ---

	/**
	 * Whether a permission request may be answered without asking the user.
	 *
	 * Plan mode always wins: it never auto-approves, because the whole point of
	 * the mode is a read-only stance that the user did not have to police.
	 */
	private autoApproveEnabled(): boolean {
		if (this.mode === 'plan') return false;
		return readConfig().autoApprove === 'all';
	}

	private postPrefs(): void {
		this.provider?.post({
			type: 'prefs',
			mode: this.mode,
			autoReview: this.autoReview,
			permissionMode: this.permissionMode,
			fontScale: this.fontScale,
		});
	}

	setMode(mode: SessionMode): void {
		if (this.mode === mode) return;
		this.mode = mode;
		void this.context.globalState.update(MODE_KEY, mode);
		this.logger.info(`协作模式切换为「${modeLabel(mode)}」`);
		this.postPrefs();
		this.postState();
		if (mode === 'plan') this.postToast('info', '计划模式：只读分析，写入请求会被自动拒绝。');
	}

	setAutoReview(enabled: boolean): void {
		if (this.autoReview === enabled) return;
		this.autoReview = enabled;
		void this.context.globalState.update(AUTO_REVIEW_KEY, enabled);
		this.logger.info(`自动审查已${enabled ? '开启' : '关闭'}`);
		this.postPrefs();
		this.postState();
	}

	/**
	 * Switch the effective permission preset.
	 *
	 * ACP cannot switch the sandbox at runtime: `DSH_PERMISSION_MODE` is read
	 * when the DSH process starts. The preset is therefore persisted, the
	 * runtime restarts with the new environment, and the previous session is
	 * resumed. An in-flight turn is refused instead of being silently killed.
	 */
	async setPermissionMode(mode: PermissionMode): Promise<void> {
		if (this.permissionMode === mode) return;
		if (this.busy) {
			void vscode.window.showInformationMessage('正在处理中：结束或停止当前任务后再切换权限。');
			return;
		}
		const previous = this.permissionMode;
		const previousSessionId = this.activeSession?.sessionId;
		this.permissionMode = mode;
		await this.persistPermissionMode(mode);
		this.postPrefs();
		this.postState();
		const ready = this.runtime?.state().phase === 'ready';
		this.postToast(
			'info',
			`权限已切换为「${permissionModeLabel(mode)}」${ready ? '，正在重启 DSH 运行时…' : '，将在启动运行时生效。'}`,
		);
		if (!ready) return;
		try {
			await this.restartCore(previousSessionId);
		} catch (error) {
			this.permissionMode = previous;
			await this.persistPermissionMode(previous);
			this.postPrefs();
			this.postState();
			this.appendNotice('error', `切换权限失败：${errorMessage(error)}（已回滚为「${permissionModeLabel(previous)}」）`);
			void vscode.window.showErrorMessage(`切换权限失败：${errorMessage(error)}`);
		}
	}

	/** Persist the preset to workspace settings (falling back to user settings); never throws. */
	private async persistPermissionMode(mode: PermissionMode): Promise<void> {
		const configuration = vscode.workspace.getConfiguration('deepseekHarness');
		this.applyingPermissionPreset = true;
		try {
			try {
				await configuration.update('permissionMode', mode, vscode.ConfigurationTarget.Workspace);
			} catch (error) {
				this.logger.warn(`写入工作区权限设置失败，改用用户设置：${errorMessage(error)}`);
				await configuration.update('permissionMode', mode, vscode.ConfigurationTarget.Global);
			}
		} catch (error) {
			this.logger.warn(`写入权限设置失败（仅本次运行生效）：${errorMessage(error)}`);
		} finally {
			this.applyingPermissionPreset = false;
		}
	}

	/** Persist and apply the sidebar font scale (0.8–1.8); non-fatal on write errors. */
	async setFontScale(value: number): Promise<void> {
		if (!Number.isFinite(value)) return;
		const next = Math.min(1.8, Math.max(0.8, Math.round(value * 20) / 20));
		if (Math.abs(next - this.fontScale) < 0.001) return;
		this.fontScale = next;
		const configuration = vscode.workspace.getConfiguration('deepseekHarness');
		try {
			await configuration.update('fontScale', next, vscode.ConfigurationTarget.Workspace);
		} catch (error) {
			try {
				await configuration.update('fontScale', next, vscode.ConfigurationTarget.Global);
			} catch (inner) {
				this.logger.warn(`写入字号设置失败（仅本次运行生效）：${errorMessage(inner)}`);
			}
		}
		this.postPrefs();
		this.postState();
	}

	private onConfigurationChanged(event: vscode.ConfigurationChangeEvent): void {
		if (event.affectsConfiguration('deepseekHarness.fontScale')) {
			const configuredFontScale = readConfig().fontScale;
			if (Math.abs(configuredFontScale - this.fontScale) > 0.001) {
				this.fontScale = configuredFontScale;
				this.postPrefs();
			}
			this.postState();
		}
		if (this.applyingPermissionPreset || !event.affectsConfiguration('deepseekHarness.permissionMode')) return;
		const configured = readConfig().permissionMode;
		if (configured === this.permissionMode) return;
		this.permissionMode = configured;
		this.postPrefs();
		this.postState();
		if (this.runtime?.state().phase === 'ready') {
			void vscode.window
				.showInformationMessage('权限设置已更改，重启 DSH 运行时后生效。', '立即重启')
				.then((action) => {
					if (action === '立即重启') void this.restartRuntime();
				});
		}
	}

	/**
	 * Route one ACP permission request.
	 *
	 * In plan mode a write/command request is refused with the agent's own
	 * reject option and a notice; read-only requests are approved silently so
	 * planning does not drown the user in cards.
	 */
	private async pickPermission(request: PermissionRequest): Promise<string | undefined> {
		if (this.mode === 'plan') {
			const reject = planModeRejectOption(request);
			if (reject) {
				this.appendNotice('warn', `计划模式已拒绝「${request.title}」：切回「自动」模式后可执行。`);
				return reject;
			}
			const allow = request.options.find((option) => option.kind.startsWith('allow_'));
			return allow?.optionId;
		}
		return this.permissionBroker?.pick(request);
	}

	// -------------------------------------------------------------- models ---

	/** Explicit config > DSH `agent-default-model` > last successful choice. */
	private resolvePreferredModel(): ModelRef | undefined {
		const configured = readConfig().preferredModel;
		const separator = configured.indexOf('/');
		if (separator > 0 && separator < configured.length - 1) {
			return { provider: configured.slice(0, separator), model: configured.slice(separator + 1) };
		}
		try {
			const fromDsh = readDshPreferredModel();
			if (fromDsh) return fromDsh;
		} catch (error) {
			this.logger.warn(`读取 DSH 模型设置失败：${errorMessage(error)}`);
		}
		return this.lastModel;
	}

	/** Hide legacy model ids in the option list shown by the sidebar. */
	private displayConfigOptions(options: ConfigOption[]): ConfigOption[] {
		try {
			const config = readConfig();
			const result = normalizeModelOptions(options, {
				hideLegacy: config.hideLegacyModels,
				preferred: this.resolvePreferredModel(),
			});
			return result.options;
		} catch (error) {
			this.logger.warn(`归一化模型列表失败：${errorMessage(error)}`);
			return options;
		}
	}

	/**
	 * Align the new/resumed session with the user's preferred model and strip
	 * legacy ids from the option list. Runs once per session.
	 */
	private async applyModelPreference(session: ActiveSession): Promise<void> {
		const config = readConfig();
		try {
			const preferred = this.resolvePreferredModel();
			const normalized = normalizeModelOptions(session.configOptions, {
				hideLegacy: config.hideLegacyModels,
				preferred,
			});
			this.configOptions = normalized.options;
			const currentOption = findConfigOption(normalized.options, 'model') ?? findConfigOption(session.configOptions, 'model');
			const current = parseModelValue(currentOption?.currentValue);
			if (normalized.selected && !sameModelRef(current, normalized.selected)) {
				const options = await this.sessionService!.setConfig('model', formatModelValue(normalized.selected));
				this.configOptions = this.displayConfigOptions(options);
				this.logger.info(
					`已按设置选择模型 ${formatModelValue(normalized.selected)}（原 ${current ? formatModelValue(current) : '未知'}）`,
				);
			}
			this.provider?.post({ type: 'configOptions', configOptions: this.configOptions });
			this.postState();
		} catch (error) {
			this.logger.warn(`应用模型偏好失败：${errorMessage(error)}`);
			this.configOptions = this.displayConfigOptions(session.configOptions);
		}
	}

	// ------------------------------------------------------------- runtime ---

	private async ensureReady(): Promise<void> {
		if (this.runtime?.state().phase === 'ready') return;
		if (this.readyPromise) return this.readyPromise;
		this.readyPromise = this.bootstrap().finally(() => {
			this.readyPromise = undefined;
		});
		return this.readyPromise;
	}

	private async bootstrap(): Promise<void> {
		const config = readConfig();
		if (!config.workspaceRoot) {
			this.runtimeError = '请先在 VS Code 中打开一个工作区文件夹，DSH 需要一个工作目录。';
			this.postState();
			throw new Error(this.runtimeError);
		}
		this.runtimeError = undefined;
		this.postState();
		this.logger.info(`启动 ACP 运行时（cwd=${config.workspaceRoot}）`);
		try {
			const launcher = await resolveExecutable(config.executable);
			this.launcherCandidates = launcher.candidates;
			this.logger.info(`dsh launcher: ${launcher.file}（来源 ${launcher.source}）`);

			const profilesDir = path.join(os.homedir(), '.dsh', 'profiles');
			const discovered = await discoverAcpProfiles(profilesDir);
			this.logger.info(`发现 ACP profile: ${discovered.join(', ') || '(无)'}`);
			const profile = config.profile || discovered[0] || 'acp';

			let probe = await probeRuntime({
				launcher,
				profile,
				cwd: config.workspaceRoot,
				log: (line) => this.logger.raw(`[probe] ${line}`),
				timeoutMs: 45000,
			});
			if (!probe.ok && config.compatAutoRepair) {
				const action = await vscode.window.showWarningMessage(
					`DSH 兼容性自检失败：${probe.error ?? '未知原因'}`,
					{
						modal: true,
						detail: '可以用官方模板重建 ACP profile 后重试；当前 profile 配置会先备份为 .bak-时间戳。',
					},
					'重建 ACP profile 并重试',
				);
				if (action) {
					const repaired = await repairAcpProfile(launcher, profile, (line) => this.logger.raw(`[repair] ${line}`));
					this.logger.info(`重建 ACP profile：${repaired ? '成功' : '失败'}`);
					probe = await probeRuntime({
						launcher,
						profile,
						cwd: config.workspaceRoot,
						log: (line) => this.logger.raw(`[probe-retry] ${line}`),
						timeoutMs: 45000,
					});
				}
			}
			this.probe = probe;
			if (!probe.ok) throw new Error(probe.error ?? 'DSH 兼容性自检失败，详见“DeepSeek Harness: 兼容性诊断”');

			const runtime = createDshRuntime({
				executable: config.executable,
				profile,
				cwd: config.workspaceRoot,
				permissionMode: this.permissionMode,
				log: (line) => this.logger.raw(`[runtime] ${line}`),
				onDirtyStdout: (line) => this.logger.raw(`[stdout] ${line}`),
			});
			// Hand the probe facts to the runtime before start() so RuntimeState
			// carries the DSH version for the sidebar / diagnose report.
			runtime.setProbe(probe);
			this.runtime = runtime;
			this.disposeSubscriptions.push(
				runtime.onDidChangeState((state) => this.onRuntimeState(state)),
			);
			const state = await runtime.start();
			this.sessionService = createSessionService(runtime, {
				cwd: () => readConfig().workspaceRoot,
				pickPermission: (request) => this.pickPermission(request),
				autoApprove: () => this.autoApproveEnabled(),
				log: (line) => this.logger.raw(`[session] ${line}`),
				onEvent: (event) => this.onSessionEvent(event),
			});
			this.onRuntimeState(state);
			this.detectVersionChange(probe);
		} catch (error) {
			this.runtimeError = errorMessage(error);
			this.postState();
			this.appendNotice('error', `DSH 运行时启动失败：${this.runtimeError}`);
			throw error instanceof Error ? error : new Error(this.runtimeError);
		}
	}

	private detectVersionChange(probe: ProbeResult): void {
		if (!probe.dshVersion) return;
		const previous = this.context.globalState.get<string>(VERSION_KEY);
		void this.context.globalState.update(VERSION_KEY, probe.dshVersion);
		if (!previous || previous === probe.dshVersion) return;
		this.logger.info(`DSH 版本变化：${previous} -> ${probe.dshVersion}`);
		if (!readConfig().checkCompatOnVersionChange) return;
		const warnings = probe.warnings.length > 0 ? `（${probe.warnings.join('；')}）` : '';
		void vscode.window.showInformationMessage(
			`DSH 已更新到 ${probe.dshVersion}，兼容性自检通过${warnings}。`,
		);
	}

	private onRuntimeState(state: RuntimeState): void {
		this.statusBar?.update(state, this.busy);
		this.provider?.post({ type: 'runtime', runtime: state });
		this.postState();
		if (state.phase === 'error') {
			this.permissionBroker?.cancelAll('运行时错误');
		}
		if (state.phase === 'error' && state.error && this.lastRuntimeErrorShown !== state.error) {
			this.lastRuntimeErrorShown = state.error;
			this.appendNotice('error', `DSH 运行时错误：${state.error}（可执行 “DeepSeek Harness: 重启运行时”）`);
		}
	}

	private onSessionEvent(event: SessionEvent): void {
		switch (event.type) {
			case 'entry': {
				this.upsertEntry(event.entry);
				this.provider?.post({ type: 'append', entries: [event.entry] });
				break;
			}
			case 'entryPatch': {
				const index = this.transcript.findIndex((item) => item.id === event.id);
				if (index >= 0) {
					this.transcript[index] = { ...this.transcript[index], ...event.patch } as TranscriptEntry;
					this.provider?.post({ type: 'patch', id: event.id, patch: event.patch });
				}
				break;
			}
			case 'configOptions': {
				this.configOptions = this.displayConfigOptions(event.options);
				this.provider?.post({ type: 'configOptions', configOptions: this.configOptions });
				break;
			}
			case 'usage': {
				this.usage = event.usage;
				this.provider?.post({ type: 'usage', usage: event.usage });
				break;
			}
			case 'busy': {
				this.setBusy(event.busy);
				break;
			}
			case 'session': {
				this.activeSession = event.session;
				this.configOptions = this.displayConfigOptions(event.session.configOptions);
				void this.context.globalState.update(ACTIVE_SESSION_KEY, event.session.sessionId);
				this.provider?.post({ type: 'configOptions', configOptions: this.configOptions });
				break;
			}
			case 'error': {
				this.appendNotice('error', event.message);
				break;
			}
		}
		this.scheduleSave();
	}

	// ------------------------------------------------------------- session ---

	private async ensureSession(): Promise<ActiveSession> {
		if (this.sessionPromise) return this.sessionPromise;
		this.sessionPromise = this.ensureSessionInner().finally(() => {
			this.sessionPromise = undefined;
		});
		return this.sessionPromise;
	}

	private async ensureSessionInner(): Promise<ActiveSession> {
		if (!this.sessionService) throw new Error('会话服务尚未就绪');
		const current = this.sessionService.active();
		if (current) {
			this.activeSession = current;
			return current;
		}
		const session = await this.sessionService.create(readConfig().workspaceRoot);
		this.activeSession = session;
		await this.applyModelPreference(session);
		this.transcript = [];
		this.findings = [];
		void this.context.globalState.update(ACTIVE_SESSION_KEY, session.sessionId);
		this.provider?.post({ type: 'configOptions', configOptions: this.configOptions });
		this.provider?.post({ type: 'findings', findings: [] });
		this.review?.clearFindings();
		this.postState();
		this.scheduleSave();
		return session;
	}

	private enqueue<T>(task: () => Promise<T>): Promise<T> {
		const run = this.promptQueue.then(task, task);
		this.promptQueue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	private async runPrompt(
		label: string,
		blocks: ContentBlock[],
		display?: PromptDisplayOptions,
	): Promise<{ text: string; stopReason: string }> {
		return this.enqueue(async () => {
			await this.ensureReady();
			const session = await this.ensureSession();
			// The session manager emits the user transcript entry itself (including
			// context refs and the display policy); we only need a marker to collect
			// this turn's assistant text once the prompt settles.
			const marker = this.transcript.length;
			this.logger.info(`发送 prompt：${label}`);
			const outcome = await this.sessionService!.prompt(session.sessionId, blocks, display);
			const text = this.transcript
				.slice(marker)
				.filter((entry): entry is Extract<TranscriptEntry, { kind: 'assistant' }> => entry.kind === 'assistant')
				.map((entry) => entry.text)
				.join('')
				.trim();
			this.scheduleSave();
			return { text, stopReason: outcome.stopReason };
		});
	}

	// ------------------------------------------------------- ChatController ---

	/** Turn one attached ref into an ACP content block (image content or resource link). */
	private async buildRefBlock(ref: ContextRef): Promise<ContentBlock | undefined> {
		if (ref.kind === 'image' || isImagePath(ref.uri)) {
			return this.readImageBlock(ref);
		}
		if (isUnsupportedMediaPath(ref.uri)) {
			this.postToast('warn', `暂不支持音频/视频附件，已跳过：${ref.name}`);
			return undefined;
		}
		return { type: 'resource_link', uri: ref.uri, name: ref.name };
	}

	/** Read one image attachment as a base64 ACP image block, or `undefined` when skipped. */
	private async readImageBlock(ref: ContextRef): Promise<ContentImage | undefined> {
		const runtime = this.getState().runtime;
		if (!runtime.capabilities.imagePrompts) {
			this.postToast('warn', `当前模型/路由不支持图片提示，已跳过：${ref.name}`);
			return undefined;
		}
		const mimeType = ref.mimeType ?? imageMimeType(ref.uri);
		if (!mimeType) {
			this.postToast('warn', `不支持的图片格式，已跳过：${ref.name}`);
			return undefined;
		}
		try {
			const bytes = await vscode.workspace.fs.readFile(vscode.Uri.parse(ref.uri));
			if (bytes.byteLength > MAX_IMAGE_BYTES) {
				this.postToast('warn', `图片超过 ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)}MB，已跳过：${ref.name}`);
				return undefined;
			}
			return { type: 'image', mimeType, data: Buffer.from(bytes).toString('base64'), uri: ref.uri };
		} catch (error) {
			this.logger.warn(`读取图片失败：${ref.name}（${errorMessage(error)}）`);
			this.postToast('warn', `读取图片失败，已跳过：${ref.name}`);
			return undefined;
		}
	}

	async send(text: string, refs: ContextRef[] = [], pendingMode?: 'queue' | 'steer'): Promise<void> {
		const trimmed = text.trim();
		if (!trimmed) return;
		// While a turn is running (or a queue already exists) do not interrupt:
		// store the message locally and send it when the runtime is idle again.
		if (this.busy || this.pending.length > 0) {
			this.enqueuePendingMessage(trimmed, refs, pendingMode);
			return;
		}
		await this.sendNow(trimmed, refs);
		this.drainPending();
	}

	/** Queue one interjection while the agent is busy; `steer` jumps the queue. */
	private enqueuePendingMessage(text: string, refs: ContextRef[], mode: 'queue' | 'steer' = 'queue'): void {
		const item: PendingMessage = {
			id: uid(),
			text,
			refs: refs.length > 0 ? refs : undefined,
			mode,
			at: Date.now(),
		};
		this.pending = mode === 'steer' ? promotePending(enqueuePending(this.pending, item), item.id) : enqueuePending(this.pending, item);
		this.postToast('info', mode === 'steer' ? '已加入引导：当前回复结束后立即发送。' : '已排队：当前回复结束后自动发送。');
		this.postState();
		if (!this.busy) this.drainPending();
	}

	/** Send one message immediately (no queue check): builds ACP blocks and runs it. */
	private async sendNow(text: string, refs: ContextRef[]): Promise<void> {
		const trimmed = text.trim();
		if (!trimmed) return;
		// Mode guidance first (ACP exposes no session modes), then the auto
		// context, then the user's question, then attached @file links.
		const blocks: ContentBlock[] = [];
		const modeBlock = modePromptBlock(this.mode);
		if (modeBlock) blocks.push(modeBlock);
		blocks.push(...this.collectAutoContextBlocks(), { type: 'text', text: trimmed });
		for (const ref of refs) {
			const block = await this.buildRefBlock(ref);
			if (block) blocks.push(block);
		}
		try {
			await this.review?.beginChanges().catch(() => undefined);
			// The bubble shows only what the user typed: instructions, inline code
			// and auto context stay out of the transcript.
			await this.runPrompt('聊天', blocks, { userEntry: trimmed });
			const changed = (await this.review?.endChanges()) ?? [];
			if (changed.length > 0) {
				this.lastTurnChanges = changed;
				// Fire-and-forget: the notice is informational and must not delay
				// the auto review that follows.
				void this.notifyChanges(changed).catch((error: unknown) => {
					this.logger.warn(`提示本轮改动失败：${errorMessage(error)}`);
				});
			}
			if (this.autoReview && this.mode !== 'plan' && changed.length > 0) {
				await this.runAutoReview(changed);
			}
		} catch (error) {
			this.appendNotice('error', `发送失败：${errorMessage(error)}`);
		}
	}

	/** Promote (`steer`) or drop (`cancel`) one queued interjection. */
	pendingAction(id: string, action: 'steer' | 'cancel'): void {
		if (action === 'cancel') {
			const next = removePending(this.pending, id);
			if (next.length === this.pending.length) return;
			this.pending = next;
			this.postToast('info', '已取消排队消息。');
			this.postState();
			return;
		}
		if (!this.pending.some((item) => item.id === id)) return;
		this.pending = promotePending(this.pending, id);
		this.postToast('info', '已转为引导：当前回复结束后立即发送。');
		this.postState();
		if (!this.busy) this.drainPending();
	}

	/** Drain queued interjections once the current turn settled (single-flight). */
	private drainPending(): void {
		if (this.drainPromise) return;
		this.drainPromise = this.runDrain().finally(() => {
			this.drainPromise = undefined;
			this.postState();
		});
	}

	private async runDrain(): Promise<void> {
		for (;;) {
			if (this.disposed || this.busy) return;
			const next = takeNextPending(this.pending);
			if (!next) return;
			this.pending = next.rest;
			this.postState();
			await this.sendNow(next.item.text, next.item.refs ?? []);
		}
	}

	cancel(): void {
		if (!this.sessionService?.busy()) {
			void vscode.window.showInformationMessage('当前没有进行中的任务。');
			return;
		}
		const sessionId = this.activeSession?.sessionId;
		if (sessionId) this.sessionService?.cancel(sessionId);
		this.permissionBroker?.cancelAll('用户取消任务');
		this.postToast('info', '已请求停止当前任务。');
	}

	async newSession(): Promise<void> {
		try {
			await this.ensureReady();
			this.permissionBroker?.cancelAll('新建会话');
			await this.sessionService?.close();
			this.activeSession = undefined;
			this.pending = [];
			this.transcript = [];
			this.findings = [];
			this.usage = undefined;
			this.review?.clearFindings();
			this.provider?.post({ type: 'findings', findings: [] });
			await this.ensureSession();
			this.refreshAutoContext();
			this.postToast('info', '已新建会话。');
		} catch (error) {
			this.appendNotice('error', `新建会话失败：${errorMessage(error)}`);
		}
	}

	async resumeSession(sessionId: string): Promise<void> {
		try {
			await this.ensureReady();
			const entries = this.transcriptStore?.load(sessionId) ?? [];
			const session = await this.sessionService!.resume(sessionId, readConfig().workspaceRoot);
			this.activeSession = session;
			await this.applyModelPreference(session);
			this.transcript = entries;
			this.findings = [];
			this.review?.clearFindings();
			void this.context.globalState.update(ACTIVE_SESSION_KEY, session.sessionId);
			this.provider?.post({ type: 'configOptions', configOptions: this.configOptions });
			this.provider?.post({ type: 'findings', findings: [] });
			this.postState();
			this.postToast('info', `已恢复会话 ${sessionId.slice(0, 8)}。`);
		} catch (error) {
			this.appendNotice('error', `恢复会话失败：${errorMessage(error)}`);
		}
	}

	async refreshHistory(): Promise<SessionInfo[]> {
		await this.ensureReady();
		const sessions = await this.sessionService!.list(readConfig().workspaceRoot);
		this.history = sessions;
		this.provider?.post({ type: 'history', history: sessions });
		this.postState();
		return sessions;
	}

	async pickContext(): Promise<ContextRef[]> {
		if (!this.review) return [];
		return this.review.pickContextFiles();
	}

	async setConfig(configId: string, value: string): Promise<void> {
		try {
			await this.ensureReady();
			if (!this.activeSession) return;
			const options = await this.sessionService!.setConfig(configId, value);
			this.configOptions = this.displayConfigOptions(options);
			this.provider?.post({ type: 'configOptions', configOptions: this.configOptions });
			if (configId === 'model') {
				const selected = parseModelValue(value);
				if (selected) {
					this.lastModel = selected;
					void this.context.globalState.update(LAST_MODEL_KEY, selected);
				}
			}
			this.postState();
		} catch (error) {
			this.appendNotice('error', `切换配置失败：${errorMessage(error)}`);
		}
	}

	permissionResponse(requestId: string, optionId?: string): void {
		this.permissionBroker?.respond(requestId, optionId);
	}

	openFile(filePath: string, line?: number): void {
		const root = readConfig().workspaceRoot;
		const resolved = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(root || process.cwd(), filePath);
		if (!root || !resolved.toLowerCase().startsWith(path.resolve(root).toLowerCase())) {
			void vscode.window.showWarningMessage(`拒绝打开工作区之外的文件：${filePath}`);
			return;
		}
		void vscode.window
			.showTextDocument(vscode.Uri.file(resolved), {
				selection: typeof line === 'number' ? new vscode.Range(Math.max(line - 1, 0), 0, Math.max(line - 1, 0), 0) : undefined,
			})
			.then(undefined, (error: unknown) => this.appendNotice('error', `打开文件失败：${errorMessage(error)}`));
	}

	runCommand(command: CommandId): void {
		void vscode.commands.executeCommand(`deepseekHarness.${command}`);
	}

	clearFindings(): void {
		this.findings = [];
		this.review?.clearFindings();
		this.provider?.post({ type: 'findings', findings: [] });
		this.postState();
	}

	async restartRuntime(): Promise<void> {
		try {
			this.postToast('info', '重新启动 DSH 运行时…');
			await this.restartCore(undefined);
			this.postToast('info', 'DSH 运行时已重启。');
		} catch (error) {
			this.appendNotice('error', `重启运行时失败：${errorMessage(error)}`);
		}
	}

	/**
	 * Stop the ACP runtime and start a fresh one, optionally resuming a session.
	 *
	 * Shared by the restart command and the permission-preset switch (the new
	 * `DSH_PERMISSION_MODE` only takes effect on a fresh process).
	 */
	private async restartCore(resumeSessionId?: string): Promise<void> {
		this.permissionBroker?.cancelAll('重启运行时');
		await this.sessionService?.close().catch(() => undefined);
		this.sessionService = undefined;
		await this.runtime?.stop().catch(() => undefined);
		this.runtime = undefined;
		this.activeSession = undefined;
		this.probe = undefined;
		this.runtimeError = undefined;
		this.busy = false;
		this.postState();
		await this.ensureReady();
		if (resumeSessionId) {
			await this.resumeAfterRestart(resumeSessionId);
		} else {
			await this.ensureSession();
		}
		this.refreshAutoContext();
	}

	private async resumeAfterRestart(sessionId: string): Promise<void> {
		try {
			const entries = this.transcriptStore?.load(sessionId) ?? [];
			const session = await this.sessionService!.resume(sessionId, readConfig().workspaceRoot);
			this.activeSession = session;
			await this.applyModelPreference(session);
			this.transcript = entries;
			this.findings = [];
			this.review?.clearFindings();
			void this.context.globalState.update(ACTIVE_SESSION_KEY, session.sessionId);
			this.provider?.post({ type: 'configOptions', configOptions: this.configOptions });
			this.provider?.post({ type: 'findings', findings: [] });
			this.postState();
			this.postToast('info', `已恢复会话 ${session.sessionId.slice(0, 8)}。`);
		} catch (error) {
			this.appendNotice('warn', `恢复原会话失败：${errorMessage(error)}，已新建会话。`);
			await this.ensureSession();
		}
	}

	openSettings(): void {
		void vscode.commands.executeCommand('workbench.action.openSettings', 'deepseekHarness');
	}

	async copyDiagnostics(): Promise<void> {
		const report = formatDiagnoseReport(this.buildDiagnoseInput());
		await vscode.env.clipboard.writeText(report);
		void vscode.window.showInformationMessage('DSH 兼容性诊断报告已复制到剪贴板。');
	}

	// ------------------------------------------------------------- sidebar ---

	async openChat(): Promise<void> {
		try {
			await vscode.commands.executeCommand('workbench.view.extension.deepseekHarness');
		} catch {
			/* container id differs on older VS Code; the reveal below still works */
		}
		// Secondary sidebar is not always focused/opened by the view-container
		// command (e.g. when the view has never been resolved). Try the built-in
		// focus/toggle commands as a fallback so URI opens and the status bar work.
		if (!(this.provider?.isVisible() ?? false)) {
			for (const command of ['workbench.action.focusAuxiliaryBar', 'workbench.action.toggleAuxiliaryBar']) {
				try {
					await vscode.commands.executeCommand(command);
					if (this.provider?.isVisible()) break;
				} catch {
					/* older VS Code may not expose this command; ignore */
				}
			}
		}
		await this.provider?.reveal();
		this.provider?.postState();
		this.ensureReady().catch((error: unknown) => {
			this.logger.warn(`运行时未就绪：${errorMessage(error)}`);
		});
	}

	// -------------------------------------------------------------- review ---

	private async reviewFile(uri?: vscode.Uri): Promise<void> {
		if (!this.review) return;
		const input = await this.review.collectFile(uri, 'review');
		if (input) await this.runReview(input);
	}

	private async reviewSelection(kind: 'review' | 'explain'): Promise<void> {
		if (!this.review) return;
		const input = await this.review.collectSelection(kind);
		if (!input) return;
		await this.runReview(input, kind === 'explain');
	}

	private async reviewDiff(kind: 'working' | 'staged' | 'commit'): Promise<void> {
		if (!this.review) return;
		const input = await this.review.collectDiff(kind);
		if (input) await this.runReview(input);
	}

	private async runReview(input: ReviewInput, explainOnly = false): Promise<void> {
		if (!this.review) return;
		await vscode.commands.executeCommand('deepseekHarness.openChat');
		try {
			await this.review.beginChanges();
		} catch (error) {
			this.logger.warn(`记录改动基线失败：${errorMessage(error)}`);
		}
		let text = '';
		try {
			// Review prompts already constrain the agent to the embedded content and
			// are read-only by construction: no mode guidance here, or it would
			// compete with the findings contract the review relies on.
			({ text } = await this.runPrompt(input.label, input.blocks, { userEntry: input.label }));
		} catch (error) {
			this.appendNotice('error', `审查失败：${errorMessage(error)}`);
			return;
		}
		if (!explainOnly) {
			try {
				const findings = await this.review.publishFindings(input.label, text);
				this.findings = findings;
				this.lastReviewLabel = input.label;
				this.provider?.post({ type: 'findings', findings });
				this.postState();
				if (findings.length === 0) {
					this.appendNotice('info', '审查完成：未发现问题。');
				} else {
					this.appendNotice('info', `审查完成：${findings.length} 个问题，已显示在“问题”面板。`);
				}
			} catch (error) {
				this.logger.warn(`发布审查结果失败：${errorMessage(error)}`);
			}
		} else {
			this.appendNotice('info', '解释完成。');
		}
		try {
			const changed = await this.review.endChanges();
			this.lastTurnChanges = changed;
			await this.notifyChanges(changed);
		} catch (error) {
			this.logger.warn(`检测本轮改动失败：${errorMessage(error)}`);
		}
	}

	private async fixFindings(): Promise<void> {
		const report = this.review?.latest();
		if (!report || report.findings.length === 0) {
			void vscode.window.showInformationMessage('还没有审查发现；请先运行一次代码审查。');
			return;
		}
		if (this.mode === 'plan') {
			void vscode.window.showInformationMessage('计划模式不会修改文件；请先把输入区模式切回「自动」。');
			return;
		}
		await vscode.commands.executeCommand('deepseekHarness.openChat');
		const prompt = fixPrompt(JSON.stringify(report.findings, null, 2));
		try {
			await this.review?.beginChanges();
			await this.runPrompt('修复审查发现', [{ type: 'text', text: prompt }], { userEntry: '修复审查发现' });
			const changed = (await this.review?.endChanges()) ?? [];
			this.lastTurnChanges = changed;
			this.appendNotice('info', changed.length > 0 ? `修复完成，本轮改动 ${changed.length} 个文件。` : '修复完成，未检测到文件改动。');
			await this.notifyChanges(changed);
		} catch (error) {
			this.appendNotice('error', `修复失败：${errorMessage(error)}`);
		}
	}

	async fixFinding(input: unknown): Promise<void> {
		if (!this.review) return;
		const finding = input as Finding;
		if (
			typeof finding !== 'object' ||
			finding === null ||
			typeof finding.file !== 'string' ||
			typeof finding.line !== 'number'
		) {
			void vscode.window.showWarningMessage('无效的审查发现，已取消修复。');
			return;
		}
		if (this.mode === 'plan') {
			void vscode.window.showInformationMessage('计划模式不会修改文件；请先把输入区模式切回「自动」。');
			return;
		}
		await vscode.commands.executeCommand('deepseekHarness.openChat');
		const prompt = fixPrompt(JSON.stringify([finding], null, 2));
		try {
			await this.review.beginChanges();
			await this.runPrompt(`修复 ${finding.file}:${finding.line}`, [{ type: 'text', text: prompt }], {
				userEntry: `修复 ${finding.file}:${finding.line}`,
			});
			const changed = (await this.review.endChanges()) ?? [];
			this.lastTurnChanges = changed;
			this.appendNotice('info', changed.length > 0 ? `修复完成，本轮改动 ${changed.length} 个文件。` : '修复完成，未检测到文件改动。');
			await this.notifyChanges(changed);
		} catch (error) {
			this.appendNotice('error', `修复失败：${errorMessage(error)}`);
		}
	}

	private async showTurnChanges(): Promise<void> {
		if (!this.review) return;
		if (this.lastTurnChanges.length === 0) {
			void vscode.window.showInformationMessage('本轮没有检测到文件改动。');
			return;
		}
		await this.review.showChanges(this.lastTurnChanges);
	}

	private async revertTurnChanges(): Promise<void> {
		if (!this.review?.canRevert()) {
			void vscode.window.showInformationMessage('没有可撤销的本轮改动（需要 git 仓库且本轮有改动）。');
			return;
		}
		const confirm = await vscode.window.showWarningMessage(
			'撤销本轮修改？',
			{
				modal: true,
				detail: '将把本轮改动的文件恢复到本轮开始前，并删除本轮新建的文件。若文件在本轮之后被手动修改过，会整体拒绝。',
			},
			'撤销',
		);
		if (confirm !== '撤销') return;
		try {
			const result = await this.review.revertLastTurn();
			if (result.ok) {
				this.lastTurnChanges = [];
				this.appendNotice('info', `已撤销本轮修改：${result.reverted.length} 个文件。`);
				void vscode.window.showInformationMessage(`已撤销 ${result.reverted.length} 个文件的本轮修改。`);
			} else {
				const detail = result.error ?? '未知原因';
				this.appendNotice('warn', `撤销本轮修改被拒绝或失败：${detail}`);
				void vscode.window.showWarningMessage(`撤销失败：${detail}`);
			}
			for (const skipped of result.skipped) {
				this.logger.warn(`撤销跳过 ${skipped.path}：${skipped.reason}`);
			}
		} catch (error) {
			this.appendNotice('error', `撤销本轮修改失败：${errorMessage(error)}`);
		}
	}

	private async notifyChanges(changed: string[]): Promise<void> {
		if (changed.length === 0 || !readConfig().showChangesNotice) return;
		const buttons = this.review?.canRevert()
			? ['查看差异', '撤销本轮修改', '忽略']
			: ['查看差异', '忽略'];
		const action = await vscode.window.showInformationMessage(
			`DSH 本轮修改了 ${changed.length} 个文件：${changed.slice(0, 3).join(', ')}${changed.length > 3 ? ' …' : ''}`,
			...buttons,
		);
		if (action === '查看差异') await this.review?.showChanges(changed);
		else if (action === '撤销本轮修改') await this.revertTurnChanges();
	}

	/**
	 * Review the files the turn changed, right after the turn settles.
	 *
	 * Deliberately bypasses `beginChanges`/`endChanges`: the turn's undo baseline
	 * must stay valid, and the review prompt must not become another tracked turn.
	 */
	private async runAutoReview(changed: readonly string[]): Promise<void> {
		if (this.autoReviewInFlight || !this.review) return;
		this.autoReviewInFlight = true;
		try {
			const input = await this.review.collectTurnDiff(changed);
			if (!input) {
				this.logger.info('自动审查：本轮没有可审查的 diff（非 git 或无文本改动），已跳过。');
				return;
			}
			this.appendNotice('info', '正在自动审查本轮改动…');
			const { text } = await this.runPrompt('自动审查本轮改动', input.blocks, { userEntry: 'none' });
			const findings = await this.review.publishFindings('自动审查本轮改动', text);
			this.findings = findings;
			this.lastReviewLabel = '自动审查本轮改动';
			this.provider?.post({ type: 'findings', findings });
			this.postState();
			this.appendNotice(
				'info',
				findings.length === 0
					? '自动审查完成：未发现问题。'
					: `自动审查完成：${findings.length} 个问题，已显示在「审查结果」面板。`,
			);
		} catch (error) {
			this.logger.warn(`自动审查失败：${errorMessage(error)}`);
			this.appendNotice('warn', `自动审查失败：${errorMessage(error)}`);
		} finally {
			this.autoReviewInFlight = false;
		}
	}

	// ------------------------------------------------------------- history ---

	private async showHistory(): Promise<void> {
		try {
			const sessions = await this.refreshHistory();
			if (sessions.length === 0) {
				void vscode.window.showInformationMessage('暂无历史会话。');
				return;
			}
			const picked = await vscode.window.showQuickPick(
				sessions.map((session) => ({
					label: session.title || `会话 ${session.sessionId.slice(0, 8)}`,
					description: session.updatedAt ? new Date(session.updatedAt).toLocaleString() : undefined,
					detail: session.cwd,
					session,
				})),
				{ placeHolder: '选择要恢复的 DSH 会话' },
			);
			if (picked) await this.resumeSession(picked.session.sessionId);
		} catch (error) {
			this.appendNotice('error', `读取历史会话失败：${errorMessage(error)}`);
		}
	}

	// ------------------------------------------------------------- diagnose ---

	private buildDiagnoseInput(): DiagnoseInput {
		const config = readConfig();
		return {
			extensionVersion: String((this.context.extension.packageJSON as { version?: string }).version ?? 'unknown'),
			runtime: this.getState().runtime,
			probe: this.probe,
			executableCandidates: this.launcherCandidates,
			config: {
				executable: config.executable,
				profile: config.profile,
				permissionMode: config.permissionMode,
				autoApprove: config.autoApprove,
				workspaceRoot: config.workspaceRoot,
			},
			logTail: this.logger.tail(80),
			notes: [
				`activeSession: ${this.activeSession?.sessionId ?? '(none)'}`,
				`sessionService: ${this.sessionService ? 'ready' : 'not-created'}`,
				`lastReview: ${this.lastReviewLabel || '(none)'}`,
				`turnChanges: ${this.lastTurnChanges.length}`,
				`mode: ${this.mode}`,
				`autoReview: ${String(this.autoReview)}`,
				`permissionMode: ${this.permissionMode}`,
				`fontScale: ${String(this.fontScale)}`,
			],
		};
	}

	async diagnose(): Promise<void> {
		await showDiagnoseReport(this.buildDiagnoseInput());
	}

	// -------------------------------------------------------------- dispose ---

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		if (this.saveTimer) {
			clearTimeout(this.saveTimer);
			this.saveTimer = undefined;
			void this.saveTranscript();
		}
		if (this.autoContextTimer) {
			clearTimeout(this.autoContextTimer);
			this.autoContextTimer = undefined;
		}
		if (this.autoStartTimer) {
			clearTimeout(this.autoStartTimer);
			this.autoStartTimer = undefined;
		}
		this.permissionBroker?.cancelAll('扩展停用');
		for (const subscription of this.disposeSubscriptions.splice(0)) {
			try {
				subscription.dispose();
			} catch {
				/* ignore */
			}
		}
		void this.sessionService?.close().catch(() => undefined);
		void this.runtime?.stop().catch(() => undefined);
		this.statusBar?.dispose();
	}
}
