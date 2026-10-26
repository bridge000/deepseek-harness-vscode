import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';

import type { DshRuntime, ProbeResult, SessionEvent, SessionService, TranscriptStore } from './acp/contracts';
import { discoverAcpProfiles, probeRuntime, repairAcpProfile } from './acp/compat';
import { createDshRuntime, resolveExecutable } from './acp/runtime';
import type { ContentBlock } from './acp/protocol';
import { readConfig } from './config';
import { Logger } from './log';
import type { ReviewInput, ReviewService } from './review/contracts';
import { createReviewService } from './review/service';
import { createSessionService } from './session/manager';
import { createTranscriptStore } from './session/transcript';
import type {
	ActiveSession,
	ConfigOption,
	ContextRef,
	Finding,
	RuntimeState,
	SessionInfo,
	TranscriptEntry,
	UiState,
	UsageInfo,
} from './types';
import { createChatViewProvider } from './ui/chatView';
import type { ChatController, ChatViewProvider, DiagnoseInput } from './ui/contract';
import { createPermissionPicker } from './ui/permissions';
import { formatDiagnoseReport, showDiagnoseReport } from './ui/diagnose';
import type { CommandId } from './ui/protocol';
import { createStatusBar, type StatusBarController } from './ui/statusBar';

const VIEW_ID = 'dshReview.chat';
const VERSION_KEY = 'dshReview.lastGoodDshVersion';
const ACTIVE_SESSION_KEY = 'dshReview.activeSessionId';

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
	const logger = new Logger('DSH Review');
	const controller = new DshReviewController(context, logger);
	context.subscriptions.push({ dispose: () => logger.dispose() }, controller);
	await controller.init();
	logger.info('DSH Review 已激活（ACP 客户端）');
}

export async function deactivate(): Promise<void> {
	// Disposal is driven by the registered controller; nothing extra to do here.
}

class DshReviewController implements ChatController, vscode.Disposable {
	private readonly context: vscode.ExtensionContext;
	private readonly logger: Logger;
	private provider?: ChatViewProvider;
	private statusBar?: StatusBarController;
	private review?: ReviewService;
	private transcriptStore?: TranscriptStore;
	private permissionPicker?: (request: import('./types').PermissionRequest) => Promise<string | undefined>;

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
	private saveTimer?: NodeJS.Timeout;
	private readyPromise?: Promise<void>;
	private disposeSubscriptions: vscode.Disposable[] = [];
	private disposed = false;
	private lastRuntimeErrorShown?: string;

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
		this.permissionPicker = createPermissionPicker({
			autoApprove: () => readConfig().autoApprove === 'all',
			log: (line) => this.logger.raw(line),
		});

		this.provider = createChatViewProvider({
			extensionUri: this.context.extensionUri,
			controller: this,
			log: (line) => this.logger.raw(line),
		});
		this.context.subscriptions.push(
			vscode.window.registerWebviewViewProvider(VIEW_ID, this.provider, {
				webviewOptions: { retainContextWhenHidden: true },
			}),
		);
		this.statusBar = createStatusBar(() => {
			void vscode.commands.executeCommand('dshReview.openChat');
		});
		this.context.subscriptions.push(this.statusBar);
		this.registerCommands();
		await this.restoreTranscript();
		this.postState();
	}

	private registerCommands(): void {
		const register = (id: string, handler: (...args: unknown[]) => unknown): void => {
			this.disposeSubscriptions.push(vscode.commands.registerCommand(id, handler));
		};
		register('dshReview.openChat', () => this.openChat());
		register('dshReview.reviewFile', (uri?: unknown) => this.reviewFile(uri instanceof vscode.Uri ? uri : undefined));
		register('dshReview.reviewSelection', () => this.reviewSelection('review'));
		register('dshReview.explainSelection', () => this.reviewSelection('explain'));
		register('dshReview.reviewChanges', () => this.reviewDiff('working'));
		register('dshReview.reviewStaged', () => this.reviewDiff('staged'));
		register('dshReview.reviewCommit', () => this.reviewDiff('commit'));
		register('dshReview.fixFindings', () => this.fixFindings());
		register('dshReview.showTurnChanges', () => this.showTurnChanges());
		register('dshReview.clearFindings', () => this.clearFindings());
		register('dshReview.newSession', () => this.newSession());
		register('dshReview.history', () => this.showHistory());
		register('dshReview.restartRuntime', () => this.restartRuntime());
		register('dshReview.diagnose', () => this.diagnose());
		register('dshReview.configure', () => this.openSettings());
	}

	// ---------------------------------------------------------------- state ---

	getState(): UiState {
		const runtime = this.runtime?.state() ?? this.failedState() ?? stoppedRuntime();
		return {
			runtime,
			session: this.activeSession
				? { sessionId: this.activeSession.sessionId, cwd: this.activeSession.cwd, title: this.activeSession.title }
				: undefined,
			busy: this.busy,
			configOptions: this.configOptions,
			transcript: this.transcript,
			findings: this.findings,
			history: this.history,
			usage: this.usage,
		};
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
					});
				}
			}
			this.probe = probe;
			if (!probe.ok) throw new Error(probe.error ?? 'DSH 兼容性自检失败，详见“DSH: 兼容性诊断”');

			const runtime = createDshRuntime({
				executable: config.executable,
				profile,
				cwd: config.workspaceRoot,
				permissionMode: config.permissionMode,
				log: (line) => this.logger.raw(`[runtime] ${line}`),
				onDirtyStdout: (line) => this.logger.raw(`[stdout] ${line}`),
			});
			this.runtime = runtime;
			this.disposeSubscriptions.push(
				runtime.onDidChangeState((state) => this.onRuntimeState(state)),
			);
			const state = await runtime.start();
			this.sessionService = createSessionService(runtime, {
				cwd: () => readConfig().workspaceRoot,
				pickPermission: this.permissionPicker,
				autoApprove: () => readConfig().autoApprove === 'all',
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
		if (state.phase === 'error' && state.error && this.lastRuntimeErrorShown !== state.error) {
			this.lastRuntimeErrorShown = state.error;
			this.appendNotice('error', `DSH 运行时错误：${state.error}（可执行 “DSH: 重启运行时”）`);
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
				this.configOptions = event.options;
				this.provider?.post({ type: 'configOptions', configOptions: event.options });
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
				this.configOptions = event.session.configOptions;
				void this.context.globalState.update(ACTIVE_SESSION_KEY, event.session.sessionId);
				this.provider?.post({ type: 'configOptions', configOptions: event.session.configOptions });
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
		if (!this.sessionService) throw new Error('会话服务尚未就绪');
		const current = this.sessionService.active();
		if (current) {
			this.activeSession = current;
			return current;
		}
		const session = await this.sessionService.create(readConfig().workspaceRoot);
		this.activeSession = session;
		this.configOptions = session.configOptions;
		this.transcript = [];
		this.findings = [];
		void this.context.globalState.update(ACTIVE_SESSION_KEY, session.sessionId);
		this.provider?.post({ type: 'configOptions', configOptions: session.configOptions });
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

	private async runPrompt(label: string, blocks: ContentBlock[], refs?: ContextRef[]): Promise<{ text: string; stopReason: string }> {
		return this.enqueue(async () => {
			await this.ensureReady();
			const session = await this.ensureSession();
			const marker = this.transcript.length;
			const userText = blocks
				.map((block) => (block.type === 'text' ? String((block as { text?: unknown }).text ?? '') : ''))
				.join('\n')
				.trim();
			this.upsertEntry({ id: uid(), kind: 'user', text: userText || label, refs, at: Date.now() });
			this.provider?.post({ type: 'append', entries: [this.transcript[this.transcript.length - 1]] });
			this.setBusy(true);
			try {
				this.logger.info(`发送 prompt：${label}`);
				const outcome = await this.sessionService!.prompt(session.sessionId, blocks);
				const text = this.transcript
					.slice(marker)
					.filter((entry): entry is Extract<TranscriptEntry, { kind: 'assistant' }> => entry.kind === 'assistant')
					.map((entry) => entry.text)
					.join('')
					.trim();
				return { text, stopReason: outcome.stopReason };
			} finally {
				this.setBusy(false);
				this.scheduleSave();
			}
		});
	}

	// ------------------------------------------------------- ChatController ---

	async send(text: string, refs: ContextRef[] = []): Promise<void> {
		const trimmed = text.trim();
		if (!trimmed) return;
		const blocks: ContentBlock[] = [{ type: 'text', text: trimmed }];
		for (const ref of refs) {
			blocks.push({ type: 'resource_link', uri: ref.uri, name: ref.name });
		}
		try {
			await this.runPrompt('聊天', blocks, refs);
		} catch (error) {
			this.appendNotice('error', `发送失败：${errorMessage(error)}`);
		}
	}

	cancel(): void {
		if (!this.sessionService?.busy()) {
			void vscode.window.showInformationMessage('当前没有进行中的任务。');
			return;
		}
		const sessionId = this.activeSession?.sessionId;
		if (sessionId) this.sessionService?.cancel(sessionId);
		this.appendNotice('info', '已请求停止当前任务。');
	}

	async newSession(): Promise<void> {
		try {
			await this.ensureReady();
			await this.sessionService?.close();
			this.activeSession = undefined;
			this.transcript = [];
			this.findings = [];
			this.usage = undefined;
			this.review?.clearFindings();
			this.provider?.post({ type: 'findings', findings: [] });
			await this.ensureSession();
			this.appendNotice('info', '已新建会话。');
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
			this.configOptions = session.configOptions;
			this.transcript = entries;
			this.findings = [];
			this.review?.clearFindings();
			void this.context.globalState.update(ACTIVE_SESSION_KEY, session.sessionId);
			this.provider?.post({ type: 'configOptions', configOptions: session.configOptions });
			this.provider?.post({ type: 'findings', findings: [] });
			this.postState();
			this.appendNotice('info', `已恢复会话 ${sessionId.slice(0, 8)}。`);
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
			this.configOptions = options;
			this.provider?.post({ type: 'configOptions', configOptions: options });
			this.postState();
		} catch (error) {
			this.appendNotice('error', `切换配置失败：${errorMessage(error)}`);
		}
	}

	permissionResponse(_requestId: string, _optionId?: string): void {
		// Permission decisions are handled by the VS Code modal picker in v1.
	}

	openFile(filePath: string, line?: number): void {
		const root = readConfig().workspaceRoot;
		const resolved = path.resolve(filePath);
		if (!root || !resolved.toLowerCase().startsWith(path.resolve(root).toLowerCase())) {
			void vscode.window.showWarningMessage(`拒绝打开工作区之外的文件：${filePath}`);
			return;
		}
		void vscode.window
			.showTextDocument(vscode.Uri.file(resolved), {
				selection: typeof line === 'number' ? new vscode.Range(Math.max(line - 1, 0), 0, Math.max(line - 1, 0), 0) : undefined,
			})
			.catch((error: unknown) => this.appendNotice('error', `打开文件失败：${errorMessage(error)}`));
	}

	runCommand(command: CommandId): void {
		void vscode.commands.executeCommand(`dshReview.${command}`);
	}

	clearFindings(): void {
		this.findings = [];
		this.review?.clearFindings();
		this.provider?.post({ type: 'findings', findings: [] });
		this.postState();
	}

	async restartRuntime(): Promise<void> {
		try {
			await this.sessionService?.close().catch(() => undefined);
			this.sessionService = undefined;
			await this.runtime?.stop().catch(() => undefined);
			this.runtime = undefined;
			this.activeSession = undefined;
			this.probe = undefined;
			this.runtimeError = undefined;
			this.busy = false;
			this.postState();
			this.appendNotice('info', '重新启动 DSH 运行时…');
			await this.ensureReady();
			await this.ensureSession();
			this.appendNotice('info', 'DSH 运行时已重启。');
		} catch (error) {
			this.appendNotice('error', `重启运行时失败：${errorMessage(error)}`);
		}
	}

	openSettings(): void {
		void vscode.commands.executeCommand('workbench.action.openSettings', 'dshReview');
	}

	async copyDiagnostics(): Promise<void> {
		const report = formatDiagnoseReport(this.buildDiagnoseInput());
		await vscode.env.clipboard.writeText(report);
		void vscode.window.showInformationMessage('DSH 兼容性诊断报告已复制到剪贴板。');
	}

	// ------------------------------------------------------------- sidebar ---

	async openChat(): Promise<void> {
		try {
			await vscode.commands.executeCommand('workbench.view.extension.dshReview');
		} catch {
			/* container id differs on older VS Code; the reveal below still works */
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
		await vscode.commands.executeCommand('dshReview.openChat');
		try {
			await this.review.beginChanges();
		} catch (error) {
			this.logger.warn(`记录改动基线失败：${errorMessage(error)}`);
		}
		let text = '';
		try {
			({ text } = await this.runPrompt(input.label, input.blocks));
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
		await vscode.commands.executeCommand('dshReview.openChat');
		const prompt = fixPrompt(JSON.stringify(report.findings, null, 2));
		try {
			await this.review?.beginChanges();
			await this.runPrompt('修复审查发现', [{ type: 'text', text: prompt }]);
			const changed = (await this.review?.endChanges()) ?? [];
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

	private async notifyChanges(changed: string[]): Promise<void> {
		if (changed.length === 0 || !readConfig().showChangesNotice) return;
		const action = await vscode.window.showInformationMessage(
			`DSH 本轮修改了 ${changed.length} 个文件：${changed.slice(0, 3).join(', ')}${changed.length > 3 ? ' …' : ''}`,
			'查看差异',
			'忽略',
		);
		if (action === '查看差异') await this.review?.showChanges(changed);
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
