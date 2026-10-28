/**
 * DeepSeek Harness 侧边栏聊天前端（原生 TypeScript + DOM，无框架）。
 *
 * 只依赖 DOM 与纯模块（`../acp/protocol` 的 `findConfigOption`、`./markdown`、
 * `./thought`、`./format`），不 import vscode。与扩展的通信全部走
 * `acquireVsCodeApi().postMessage`，消息形状见 `../ui/protocol.ts`；扩展推送的
 * 增量消息（append/patch/busy/...）与全量 state 都能渲染。
 *
 * 0.6 UI：输入区改成 DSH Web 式统一二级菜单（`+` / 权限 / 模型 / 推理 / 顶部 ⋯ 全部走
 * `menu.ts` 的 popover），模式与自动审查并入菜单，输入 `/` 弹出斜杠指令面板；
 * `deepseekHarness.fontScale` 通过 `--dsh-font-scale` 作用到整个侧边栏。
 */
import type {
	AcpCapabilities,
	AutoContextInfo,
	ConfigOption,
	ContextRef,
	Finding,
	PendingMessage,
	PermissionMode,
	PermissionOptionInfo,
	PermissionRequest,
	RuntimePhase,
	SessionMode,
	TranscriptEntry,
	UiState,
} from '../types';
import { findConfigOption } from '../acp/protocol';
import type { ExtToWeb, WebviewToExt } from '../ui/protocol';
import { renderMarkdown } from './markdown';
import { groupThoughtEntries, thoughtHeader } from './thought';
import type { ThoughtGroup } from './thought';
import {
	composerHintText,
	contextUsagePercent,
	filterFindings,
	findingFilterLabel,
	FONT_SCALES,
	fontScaleIndex,
	fontScalePercent,
	formatRelativeTime,
	formatTimestamp,
	formatToolDuration,
	formatUsageText,
	headerTitle,
	modeLabel,
	modeMenuItems,
	modelMenuGroups,
	permissionDescription,
	permissionHint,
	permissionLabel,
	permissionMenuItems,
	reasoningChipLabel,
	severityCounts,
	shouldShowLaunch,
	stripFindingsBlock,
	toolKindIcon,
	toolStatusGlyph,
	toolStatusLabel,
	truncateTitle,
	usageBadgeText,
} from './format';
import type { FindingFilter, MenuItemModel } from './format';
import { imageMimeType, isUnsupportedMediaPath, refNameFromUri } from '../context/media';
import {
	closePopoverMenu,
	highlightPopoverItem,
	icon,
	isPopoverMenuOpen,
	openPopoverMenu,
} from './menu';
import type { MenuEntry } from './menu';
import {
	FISH_LOGO_PATH,
	FISH_LOGO_VIEWBOX,
	WORDMARK_BADGE,
	WORDMARK_BADGE_CLIP,
	WORDMARK_BADGE_LETTERS,
	WORDMARK_LETTERS,
	WORDMARK_TEXT_VIEWBOX,
} from './brand';
import {
	SLASH_COMMANDS,
	matchSlashCommands,
	parseSlashCommand,
	shouldShowSlashPalette,
} from './slashCommands';
import type { SlashCommand } from './slashCommands';

type ToolEntry = Extract<TranscriptEntry, { kind: 'tool' }>;

interface VsCodeApi {
	postMessage(message: WebviewToExt): void;
	getState(): unknown;
	setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscodeApi = acquireVsCodeApi();

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

function post(message: WebviewToExt): void {
	vscodeApi.postMessage(message);
}

function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	className?: string,
	text?: string,
): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

function button(label: string, title: string, className = 'tool-button'): HTMLButtonElement {
	const node = el('button', className, label);
	node.type = 'button';
	node.title = title;
	node.setAttribute('aria-label', title);
	return node;
}

function actionButton(
	label: string,
	title: string,
	onClick: () => void,
	className = 'tool-button',
): HTMLButtonElement {
	const node = button(label, title, className);
	node.addEventListener('click', onClick);
	return node;
}

function requiredElement(id: string): HTMLElement {
	const node = document.getElementById(id);
	if (!node) throw new Error(`[DeepSeek Harness] 缺少界面节点 #${id}`);
	return node;
}

function emptyCapabilities(): AcpCapabilities {
	return {
		sessionList: false,
		sessionResume: false,
		sessionClose: false,
		modelConfig: false,
		reasoningConfig: false,
		imagePrompts: false,
	};
}

function createInitialState(): UiState {
	return {
		runtime: { phase: 'stopped', capabilities: emptyCapabilities() },
		busy: false,
		configOptions: [],
		transcript: [],
		findings: [],
		history: [],
		mode: 'agent',
		autoReview: false,
		permissionMode: 'workspace-write',
		fontScale: 1,
		pending: [],
	};
}

/** 排队消息：只接受扩展侧下发的形状，脏数据丢弃。 */
function normalizePending(value: unknown): PendingMessage[] {
	if (!Array.isArray(value)) return [];
	const items: PendingMessage[] = [];
	for (const raw of value) {
		if (typeof raw !== 'object' || raw === null) continue;
		const item = raw as { id?: unknown; text?: unknown; refs?: unknown; mode?: unknown; at?: unknown };
		if (typeof item.id !== 'string' || typeof item.text !== 'string' || item.text.trim().length === 0) continue;
		const refs = normalizeRefs(item.refs);
		items.push({
			id: item.id,
			text: item.text,
			refs: refs.length > 0 ? refs : undefined,
			mode: item.mode === 'steer' ? 'steer' : 'queue',
			at: typeof item.at === 'number' ? item.at : Date.now(),
		});
	}
	return items;
}

/** 模式只接受协议里的三个值，其余（含历史持久化脏数据）一律回落到「自动」。 */
function normalizeMode(value: unknown): SessionMode {
	return value === 'plan' || value === 'goal' ? value : 'agent';
}

/** 权限预设只接受协议里的三个值，脏数据回落到「工作区内」。 */
function normalizePermissionMode(value: unknown): PermissionMode {
	return value === 'read-only' || value === 'danger-full-access' ? value : 'workspace-write';
}

/** 字号缩放：扩展侧已夹紧到 0.8–1.8，这里再兜一层，非法值回落到 1。 */
function normalizeFontScale(value: unknown): number {
	const scale = typeof value === 'number' ? value : Number(value);
	if (!Number.isFinite(scale)) return 1;
	return Math.min(1.8, Math.max(0.8, scale));
}

function applyFontScale(scale: number): void {
	document.documentElement.style.setProperty('--dsh-font-scale', String(normalizeFontScale(scale)));
}

function normalizeRefs(value: unknown): ContextRef[] {
	if (!Array.isArray(value)) return [];
	const refs: ContextRef[] = [];
	for (const item of value) {
		if (typeof item !== 'object' || item === null) continue;
		const ref = item as { name?: unknown; uri?: unknown; kind?: unknown; mimeType?: unknown };
		if (typeof ref.name !== 'string' || typeof ref.uri !== 'string') continue;
		const contextRef: ContextRef = { name: ref.name, uri: ref.uri };
		if (ref.kind === 'image') contextRef.kind = 'image';
		else if (ref.kind === 'file') contextRef.kind = 'file';
		if (typeof ref.mimeType === 'string' && ref.mimeType.length > 0) contextRef.mimeType = ref.mimeType;
		refs.push(contextRef);
	}
	return refs;
}

const ENTRY_KINDS = new Set(['user', 'assistant', 'thought', 'tool', 'notice']);

function isTranscriptEntry(value: unknown): value is TranscriptEntry {
	if (typeof value !== 'object' || value === null) return false;
	const entry = value as { id?: unknown; kind?: unknown };
	return typeof entry.id === 'string' && typeof entry.kind === 'string' && ENTRY_KINDS.has(entry.kind);
}

const SEVERITY_LABELS: Record<Finding['severity'], string> = {
	error: '错误',
	warning: '警告',
	info: '提示',
};

function currentConfigValue(option: ConfigOption | undefined): string {
	if (!option) return '';
	const value = option.currentValue;
	if (typeof value === 'string') return value;
	if (typeof value === 'object' && value !== null) {
		const nested = (value as { value?: unknown }).value;
		if (typeof nested === 'string') return nested;
	}
	return '';
}

// ---------------------------------------------------------------------------
// 界面骨架
// ---------------------------------------------------------------------------

interface UiRefs {
	statusDot: HTMLSpanElement;
	sessionTitle: HTMLSpanElement;
	menuButton: HTMLButtonElement;
	historyPanel: HTMLDivElement;
	banner: HTMLDivElement;
	bannerText: HTMLSpanElement;
	bannerClose: HTMLButtonElement;
	mainArea: HTMLDivElement;
	scroll: HTMLElement;
	transcript: HTMLDivElement;
	emptyState: HTMLDivElement;
	jumpButton: HTMLButtonElement;
	findingsSection: HTMLElement;
	findingsToggle: HTMLButtonElement;
	findingsChevron: HTMLSpanElement;
	findingsCount: HTMLSpanElement;
	findingsFilters: HTMLDivElement;
	findingsList: HTMLDivElement;
	btnFindingsFix: HTMLButtonElement;
	btnFindingsClear: HTMLButtonElement;
	permission: HTMLElement;
	permissionTitle: HTMLDivElement;
	permissionMeta: HTMLDivElement;
	permissionBody: HTMLDivElement;
	permissionActions: HTMLDivElement;
	autoContextBar: HTMLDivElement;
	chips: HTMLDivElement;
	input: HTMLTextAreaElement;
	btnPickContext: HTMLButtonElement;
	composerShell: HTMLDivElement;
	composerHint: HTMLDivElement;
	modeBadge: HTMLButtonElement;
	permissionChip: HTMLButtonElement;
	modelChip: HTMLButtonElement;
	btnStop: HTMLButtonElement;
	btnSteer: HTMLButtonElement;
	btnSend: HTMLButtonElement;
	pendingBar: HTMLDivElement;
	toast: HTMLDivElement;
}

function buildUi(root: HTMLElement): UiRefs {
	root.classList.add('app');

	// 顶部：状态点 + 本地标题 + 「⋯」菜单（版本/ACP/token 在状态点 tooltip）
	const topbar = el('header', 'topbar');
	const identity = el('div', 'identity');
	const statusDot = el('span', 'status-dot');
	statusDot.setAttribute('aria-hidden', 'true');
	statusDot.tabIndex = 0;
	statusDot.setAttribute('role', 'img');
	const sessionTitle = el('span', 'session-title', '未连接');
	identity.append(statusDot, sessionTitle);
	const menuButton = button('⋯', '更多操作', 'icon-button menu-button');
	menuButton.setAttribute('aria-haspopup', 'menu');
	menuButton.setAttribute('aria-expanded', 'false');
	topbar.append(identity, menuButton);

	// 历史会话下拉
	const historyPanel = el('div', 'history-panel');
	historyPanel.hidden = true;

	// 错误横幅
	const banner = el('div', 'banner');
	banner.hidden = true;
	banner.setAttribute('role', 'alert');
	const bannerText = el('span', 'banner-text');
	const bannerClose = button('×', '关闭');
	bannerClose.className = 'icon-button';
	banner.append(bannerText, bannerClose);

	// 主区域：消息流 + 空状态 + findings + 回到底部浮层
	const mainArea = el('div', 'main-area');
	const scroll = el('main', 'scroll-area');
	const transcript = el('div', 'transcript');
	transcript.setAttribute('role', 'log');
	transcript.setAttribute('aria-live', 'polite');
	const emptyState = el('div', 'empty-state');
	emptyState.hidden = true;

	const findingsSection = el('section', 'findings');
	findingsSection.hidden = true;
	const findingsHeader = el('div', 'findings-header');
	const findingsToggle = button('', '折叠审查结果', 'findings-toggle');
	findingsToggle.setAttribute('aria-expanded', 'true');
	const findingsChevron = el('span', 'findings-chevron', '▾');
	findingsChevron.setAttribute('aria-hidden', 'true');
	const findingsCount = el('span', 'findings-count');
	findingsToggle.append(findingsChevron, el('span', 'findings-title', '审查结果'), findingsCount);
	const findingsActions = el('div', 'findings-actions');
	const btnFindingsFix = button('修复全部', '让 DSH 修复这些发现', 'ghost-button');
	const btnFindingsClear = button('清除', '清除审查结果', 'ghost-button');
	findingsActions.append(btnFindingsFix, btnFindingsClear);
	findingsHeader.append(findingsToggle, el('span', 'spacer'), findingsActions);
	const findingsFilters = el('div', 'findings-filters');
	findingsFilters.setAttribute('role', 'toolbar');
	findingsFilters.setAttribute('aria-label', '按严重级别筛选');
	const findingsList = el('div', 'findings-list');
	findingsSection.append(findingsHeader, findingsFilters, findingsList);

	scroll.append(transcript, emptyState, findingsSection);
	const jumpButton = el('button', 'scroll-jump', '↓ 回到底部');
	jumpButton.type = 'button';
	jumpButton.hidden = true;
	jumpButton.title = '回到底部';
	mainArea.append(scroll, jumpButton);

	// 权限确认卡片（固定在输入框上方）
	const permission = el('section', 'permission');
	permission.hidden = true;
	permission.setAttribute('role', 'alertdialog');
	permission.setAttribute('aria-label', '工具权限请求');
	const permissionTitle = el('div', 'permission-title');
	const permissionMeta = el('div', 'permission-meta');
	const permissionBody = el('div', 'permission-body');
	const permissionActions = el('div', 'permission-actions');
	permission.append(permissionTitle, permissionMeta, permissionBody, permissionActions);

	// 输入区：圆角卡片 = 上下文 chips + textarea + 单行工具栏（参考 DSH Web 输入区）。
	const composer = el('div', 'composer');
	const shell = el('div', 'composer-shell');
	const autoContextBar = el('div', 'auto-context-bar');
	autoContextBar.hidden = true;
	autoContextBar.setAttribute('aria-label', '自动上下文');
	const chips = el('div', 'context-chips');
	chips.hidden = true;
	const input = el('textarea', 'composer-input');
	input.rows = 1;
	input.placeholder = '给 DeepSeek Harness 发消息，/ 调用指令';
	input.title = 'Enter 发送 · Shift+Enter 换行 · / 调用指令 · Esc 停止';
	input.setAttribute('aria-label', '消息输入框');

	const tools = el('div', 'composer-tools');
	const toolsLeft = el('div', 'tools-left');
	const toolsRight = el('div', 'tools-right');

	// `+`：统一菜单入口（添加上下文 / 模式 / 审查 / 会话 / 更多）。
	const btnPickContext = button('', '添加内容：上下文、模式、审查与会话操作', 'icon-button attach-button');
	btnPickContext.append(icon('plus', 16));
	btnPickContext.setAttribute('aria-haspopup', 'menu');
	btnPickContext.setAttribute('aria-expanded', 'false');

	// 模式徽标：只在计划/目标模式出现，点击打开「+」菜单切换模式。
	const modeBadge = button('', '当前协作模式（点击切换）', 'mode-badge');
	modeBadge.hidden = true;
	modeBadge.setAttribute('aria-haspopup', 'menu');
	modeBadge.setAttribute('aria-expanded', 'false');

	// 权限 chip：显示当前预设 + ⌄，点击打开权限菜单（含自动审查行）。
	const permissionChip = button('', '权限', 'chip permission-chip');
	permissionChip.setAttribute('aria-haspopup', 'menu');
	permissionChip.setAttribute('aria-expanded', 'false');

	// 合并 chip：模型名 + 用量指示 + 推理档位 + ⌄（对应 DSH Web 的单个模型/推理入口）。
	const modelChip = button('', '选择模型与推理等级', 'chip model-chip');
	modelChip.setAttribute('aria-haspopup', 'menu');
	modelChip.setAttribute('aria-expanded', 'false');

	// 处理中：发送键仍然发送（排队），停止单独一个键，引导键把当前草稿插队发送。
	const btnSteer = button('引导', '引导：不打断当前回复，插队优先发送', 'guide-button');
	btnSteer.hidden = true;
	const btnStop = button('■', '停止当前回复（Esc）', 'send-button stop-button');
	btnStop.hidden = true;
	const btnSend = button('↑', '发送（Enter）', 'send-button');
	toolsLeft.append(btnPickContext, modeBadge, permissionChip);
	toolsRight.append(modelChip, btnSteer, btnStop, btnSend);
	tools.append(toolsLeft, toolsRight);

	const hint = el('div', 'composer-hint');
	hint.hidden = true;

	// 操作提示：放在输入框正上方（正常文档流），不再悬浮遮挡底部信息。
	const toast = el('div', 'toast');
	toast.hidden = true;
	toast.setAttribute('role', 'status');
	toast.setAttribute('aria-live', 'polite');

	// 排队插话：当前回复结束前提交的消息显示在这里（可转引导或取消）。
	const pendingBar = el('div', 'pending-bar');
	pendingBar.hidden = true;
	pendingBar.setAttribute('role', 'list');
	pendingBar.setAttribute('aria-label', '排队中的消息');

	shell.append(autoContextBar, chips, input, tools, hint);
	composer.append(toast, pendingBar, shell);

	root.append(topbar, historyPanel, banner, mainArea, permission, composer);

	return {
		statusDot,
		sessionTitle,
		menuButton,
		historyPanel,
		banner,
		bannerText,
		bannerClose,
		mainArea,
		scroll,
		transcript,
		emptyState,
		jumpButton,
		findingsSection,
		findingsToggle,
		findingsChevron,
		findingsCount,
		findingsFilters,
		findingsList,
		btnFindingsFix,
		btnFindingsClear,
		permission,
		permissionTitle,
		permissionMeta,
		permissionBody,
		permissionActions,
		autoContextBar,
		chips,
		input,
		btnPickContext,
		composerShell: shell,
		composerHint: hint,
		modeBadge,
		permissionChip,
		modelChip,
		btnStop,
		btnSteer,
		btnSend,
		pendingBar,
		toast,
	};
}

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------

interface ViewState {
	ui: UiState;
	draftRefs: ContextRef[];
	permissionQueue: PermissionRequest[];
}

const state: ViewState = {
	ui: createInitialState(),
	draftRefs: [],
	permissionQueue: [],
};

// 自动上下文开关是纯 webview 偏好，用 webview 的 state 持久化，重开侧边栏仍然生效。
interface PersistedViewState {
	autoContextEnabled?: boolean;
}

function readPersistedState(): PersistedViewState {
	try {
		const raw = vscodeApi.getState();
		if (!raw || typeof raw !== 'object') return {};
		const enabled = (raw as { autoContextEnabled?: unknown }).autoContextEnabled;
		return { autoContextEnabled: typeof enabled === 'boolean' ? enabled : undefined };
	} catch {
		return {};
	}
}

let autoContextEnabled = readPersistedState().autoContextEnabled !== false;

function persistAutoContextEnabled(): void {
	try {
		vscodeApi.setState({ autoContextEnabled });
	} catch {
		// 持久化失败不影响界面。
	}
}

// UI 本地视图状态：findings 筛选/折叠、回到底部的新消息计数、工具卡展开/耗时。
let findingsFilter: FindingFilter = 'all';
let findingsCollapsed = false;
let pendingNewCount = 0;

const entryNodes = new Map<string, HTMLElement>();
const refs = buildUi(requiredElement('app'));

// ---------------------------------------------------------------------------
// 滚动
// ---------------------------------------------------------------------------

function isNearBottom(): boolean {
	const element = refs.scroll;
	return element.scrollHeight - element.scrollTop - element.clientHeight < 80;
}

function scrollToBottom(): void {
	refs.scroll.scrollTop = refs.scroll.scrollHeight;
}

function renderJumpButton(): void {
	const nearBottom = isNearBottom();
	refs.jumpButton.hidden = nearBottom;
	refs.jumpButton.textContent = pendingNewCount > 0 ? `↓ ${pendingNewCount} 条新消息` : '↓ 回到底部';
	refs.jumpButton.title = pendingNewCount > 0 ? '跳到最新消息' : '回到底部';
}

/** 新内容到达时按「是否贴底」决定自动滚动，还是累计「新消息」提示。 */
function handleNewContent(stick: boolean): void {
	if (stick) {
		scrollToBottom();
		return;
	}
	pendingNewCount += 1;
	renderJumpButton();
}

function jumpToBottom(): void {
	pendingNewCount = 0;
	scrollToBottom();
	renderJumpButton();
}

// ---------------------------------------------------------------------------
// Markdown 增强：代码块复制按钮
// ---------------------------------------------------------------------------

function copyText(text: string): Promise<void> {
	if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
		return navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
	}
	fallbackCopy(text);
	return Promise.resolve();
}

function fallbackCopy(text: string): void {
	const area = el('textarea', 'copy-fallback');
	area.value = text;
	document.body.appendChild(area);
	area.select();
	try {
		document.execCommand('copy');
	} finally {
		area.remove();
	}
}

/** 代码块标题栏的语言名：`code.className` 里的 `language-xxx`，缺省用 `code`。 */
function codeLanguage(code: HTMLElement | null): string {
	const className = code?.className ?? '';
	const match = /(?:^|\s)language-([\w+#.-]+)/.exec(className);
	return match?.[1] ?? 'code';
}

/**
 * 给每个 `pre` 加一条标题栏：左侧语言名、右侧复制按钮。
 * 旧实现把复制按钮绝对定位在代码块右上角，会挡住长代码首行，这里改成标题栏布局。
 */
function decorateMarkdown(container: HTMLElement): void {
	for (const pre of Array.from(container.querySelectorAll('pre'))) {
		const code = pre.querySelector('code');
		const wrapper = el('div', 'code-block');
		const head = el('div', 'code-head');
		head.append(el('span', 'code-lang', codeLanguage(code)));
		const copyButton = button('复制', '复制代码', 'copy-button');
		copyButton.addEventListener('click', () => {
			void copyText(code?.textContent ?? '').then(() => {
				copyButton.textContent = '已复制';
				window.setTimeout(() => {
					copyButton.textContent = '复制';
				}, 1200);
			});
		});
		head.append(copyButton);
		pre.replaceWith(wrapper);
		wrapper.append(head, pre);
	}
}

function markdownBody(text: string, streaming = false): HTMLElement {
	const body = el('div', streaming ? 'md streaming' : 'md');
	body.innerHTML = renderMarkdown(text);
	decorateMarkdown(body);
	return body;
}

// ---------------------------------------------------------------------------
// 思考链：折叠成一行「已思考 N 秒」，展开是低饱和小字
// ---------------------------------------------------------------------------

interface ThoughtViewState {
	/** 首条 thought chunk 的时间戳（由条目 at 给出）。 */
	startedAt: number;
	expanded: boolean;
	/** 流式结束后的实际思考时长；历史恢复的条目没有。 */
	durationMs?: number;
	/** 是否已经因为助手正文出现而自动收起过（只自动收一次）。 */
	autoCollapsed: boolean;
}

const thoughtStates = new Map<string, ThoughtViewState>();
let thoughtGroups: ThoughtGroup[] = [];
let thoughtIndex = new Map<string, ThoughtGroup>();

/** 按当前 transcript 重新分组；非 thought 条目会打断相邻关系。 */
function rebuildThoughtIndex(): void {
	thoughtGroups = groupThoughtEntries(state.ui.transcript);
	thoughtIndex = new Map();
	for (const group of thoughtGroups) {
		for (const entry of group.entries) thoughtIndex.set(entry.id, group);
	}
}

function thoughtViewState(group: ThoughtGroup): ThoughtViewState {
	let view = thoughtStates.get(group.id);
	if (!view) {
		view = {
			startedAt: typeof group.at === 'number' && Number.isFinite(group.at) ? group.at : Date.now(),
			expanded: false,
			autoCollapsed: false,
		};
		thoughtStates.set(group.id, view);
	}
	return view;
}

/** 流式结束时记录「首条 chunk → streaming=false」的时长，按秒取整展示。 */
function finalizeThoughtGroup(group: ThoughtGroup): void {
	if (group.streaming) return;
	const view = thoughtStates.get(group.id);
	if (!view || view.durationMs !== undefined) return;
	view.durationMs = Math.max(0, Date.now() - view.startedAt);
}

/** patch / 追加后按组重渲染（组内除首条外都是隐藏占位节点）。 */
function refreshThoughtGroup(group: ThoughtGroup): void {
	for (const member of group.entries) {
		const node = createEntryNode(member);
		const existing = entryNodes.get(member.id);
		if (existing) existing.replaceWith(node);
		else refs.transcript.append(node);
		entryNodes.set(member.id, node);
	}
}

/** 该消息的第一条助手正文到达后自动收起思考链（符合 Claude Code 行为）。 */
function autoCollapseThoughts(messageId: string | undefined): void {
	if (!messageId) return;
	for (const group of thoughtGroups) {
		if (group.messageId !== messageId || group.streaming) continue;
		const view = thoughtStates.get(group.id);
		if (!view || view.autoCollapsed) continue;
		view.autoCollapsed = true;
		if (!view.expanded) continue;
		view.expanded = false;
		refreshThoughtGroup(group);
	}
}

// ---------------------------------------------------------------------------
// 工具卡：一行「图标 + 工具名 + 状态点 + kind/耗时」，点击展开详情
// ---------------------------------------------------------------------------

interface ToolViewState {
	expanded: boolean;
	startedAt?: number;
	durationMs?: number;
}

const toolViews = new Map<string, ToolViewState>();

/** 超过这个时长的条目视为历史会话：没有实时起点，不能拿当前时间算耗时。 */
const TOOL_HISTORY_MS = 12 * 3600 * 1000;

function toolViewState(entry: ToolEntry): ToolViewState {
	let view = toolViews.get(entry.id);
	if (!view) {
		view = { expanded: false };
		const at = typeof entry.at === 'number' ? entry.at : undefined;
		// 历史会话恢复出来的工具条目没有实时起点，记录 startedAt 会得到「耗时 2 天」。
		if (at !== undefined && Date.now() - at <= TOOL_HISTORY_MS) view.startedAt = at;
		toolViews.set(entry.id, view);
	}
	if (
		(entry.status === 'completed' || entry.status === 'failed') &&
		view.durationMs === undefined &&
		typeof view.startedAt === 'number'
	) {
		view.durationMs = Math.max(0, Date.now() - view.startedAt);
	}
	return view;
}

function toolDurationLabel(view: ToolViewState): string {
	if (view.durationMs === undefined) return '';
	return `耗时 ${formatToolDuration(view.durationMs)}`;
}

// ---------------------------------------------------------------------------
// 单条消息渲染
// ---------------------------------------------------------------------------

function refsRow(refsList: readonly ContextRef[]): HTMLElement {
	const row = el('div', 'ref-row');
	for (const ref of refsList) {
		const chip = el('span', 'ref-chip');
		if (ref.kind === 'image') chip.append(el('span', 'ref-chip-kind', '图'));
		chip.append(el('span', 'ref-chip-name', ref.name));
		chip.title = ref.kind === 'image' ? `图片 · ${ref.uri}` : ref.uri;
		row.append(chip);
	}
	return row;
}

function createUserEntry(entry: Extract<TranscriptEntry, { kind: 'user' }>): HTMLElement {
	const node = el('div', 'entry entry-user');
	node.dataset.entryId = entry.id;
	node.append(el('div', 'user-bubble', entry.text));
	if (entry.refs && entry.refs.length > 0) node.append(refsRow(entry.refs));
	const time = formatTimestamp(entry.at);
	if (time) node.append(el('div', 'msg-meta msg-meta-user', time));
	return node;
}

function createAssistantEntry(entry: Extract<TranscriptEntry, { kind: 'assistant' }>): HTMLElement {
	const node = el('div', 'entry entry-assistant');
	node.dataset.entryId = entry.id;
	const content = stripFindingsBlock(entry.text);
	const roleRow = el('div', 'role-row');
	roleRow.append(el('span', 'role-name', 'DSH'));
	if (entry.streaming === true) roleRow.append(el('span', 'role-streaming', '生成中…'));
	const time = formatTimestamp(entry.at);
	if (time) roleRow.append(el('span', 'hover-meta', time));
	const copy = button('复制', '复制这条回答', 'copy-answer');
	copy.addEventListener('click', () => {
		void copyText(content.text).then(() => {
			copy.textContent = '已复制';
			window.setTimeout(() => {
				copy.textContent = '复制';
			}, 1200);
		});
	});
	roleRow.append(copy);
	node.append(roleRow, markdownBody(content.text, entry.streaming === true));
	if (content.stripped) {
		node.append(el('div', 'answer-footnote', '审查发现已提取到下方「审查结果」'));
	}
	return node;
}

function createThoughtEntry(entry: Extract<TranscriptEntry, { kind: 'thought' }>): HTMLElement {
	const node = el('div', 'entry entry-thought');
	node.dataset.entryId = entry.id;
	const group = thoughtIndex.get(entry.id);
	if (!group || group.id !== entry.id) {
		// 同组条目合并到首条渲染，其余只保留一个隐藏占位节点供 patch 定位。
		node.hidden = true;
		node.classList.add('thought-ghost');
		return node;
	}
	node.classList.add('thought-chain');
	const view = thoughtViewState(group);
	const header = thoughtHeader({
		streaming: group.streaming,
		durationMs: view.durationMs,
		hasBody: group.text.trim().length > 0,
	});
	const row = el('button', 'thought-row');
	row.type = 'button';
	const chevron = el('span', 'thought-chevron', view.expanded ? '▾' : '▸');
	chevron.setAttribute('aria-hidden', 'true');
	const spark = el('span', 'thought-spark', group.streaming ? '✻' : '✦');
	spark.setAttribute('aria-hidden', 'true');
	if (group.streaming) spark.classList.add('is-streaming');
	row.append(chevron, spark, el('span', 'thought-label', header.label));
	if (header.detail) row.append(el('span', 'thought-detail', header.detail));
	const time = formatTimestamp(group.at);
	if (time) row.append(el('span', 'hover-meta', time));
	row.setAttribute('aria-expanded', view.expanded ? 'true' : 'false');
	row.title = header.detail ? `${header.label}（${header.detail}）` : header.label;
	const body = el('div', 'thought-body');
	body.hidden = !view.expanded;
	if (group.text.length > 0) body.append(markdownBody(group.text, group.streaming));
	const toggle = (): void => {
		view.expanded = !view.expanded;
		row.setAttribute('aria-expanded', view.expanded ? 'true' : 'false');
		chevron.textContent = view.expanded ? '▾' : '▸';
		body.hidden = !view.expanded;
	};
	row.addEventListener('click', toggle);
	node.append(row, body);
	return node;
}

function createToolEntry(entry: ToolEntry): HTMLElement {
	const node = el('div', 'entry entry-tool');
	node.dataset.entryId = entry.id;
	const view = toolViewState(entry);
	const hasBody =
		(entry.locations?.length ?? 0) > 0 || (typeof entry.detail === 'string' && entry.detail.length > 0);
	const row = hasBody ? el('button', 'tool-row') : el('div', 'tool-row');
	if (hasBody) (row as HTMLButtonElement).type = 'button';
	const icon = el('span', 'tool-icon', toolKindIcon(entry.toolKind));
	icon.setAttribute('aria-hidden', 'true');
	const title = el('span', 'tool-title', entry.title || '工具调用');
	row.append(icon, title);
	if (entry.toolKind) row.append(el('span', 'tool-kind', entry.toolKind));
	const duration = toolDurationLabel(view);
	if (duration) row.append(el('span', 'tool-duration', duration));
	const status = el('span', `tool-status status-${entry.status}`, toolStatusGlyph(entry.status));
	status.title = toolStatusLabel(entry.status);
	status.setAttribute('aria-label', toolStatusLabel(entry.status));
	row.append(status);
	if (hasBody) {
		const chevron = el('span', 'tool-chevron', view.expanded ? '▾' : '▸');
		chevron.setAttribute('aria-hidden', 'true');
		row.append(chevron);
		row.setAttribute('aria-expanded', view.expanded ? 'true' : 'false');
		const body = el('div', 'tool-body');
		body.hidden = !view.expanded;
		const locations = entry.locations ?? [];
		if (locations.length > 0) {
			const locationRow = el('div', 'tool-locations');
			for (const location of locations) {
				const label = location.line ? `${location.path}:${location.line}` : location.path;
				const link = button(label, `打开 ${location.path}`, 'link-button');
				link.addEventListener('click', () => {
					post({ type: 'openFile', path: location.path, line: location.line });
				});
				locationRow.append(link);
			}
			body.append(locationRow);
		}
		if (entry.detail) body.append(el('pre', 'tool-detail-text', entry.detail));
		row.addEventListener('click', () => {
			view.expanded = !view.expanded;
			row.setAttribute('aria-expanded', view.expanded ? 'true' : 'false');
			chevron.textContent = view.expanded ? '▾' : '▸';
			body.hidden = !view.expanded;
		});
		node.append(row, body);
	} else {
		node.append(row);
	}
	return node;
}

function createEntryNode(entry: TranscriptEntry): HTMLElement {
	switch (entry.kind) {
		case 'user':
			return createUserEntry(entry);
		case 'assistant':
			return createAssistantEntry(entry);
		case 'thought':
			return createThoughtEntry(entry);
		case 'tool':
			return createToolEntry(entry);
		case 'notice': {
			const node = el('div', `entry entry-notice notice-${entry.level}`);
			node.dataset.entryId = entry.id;
			const glyph = entry.level === 'error' ? '✕' : entry.level === 'warn' ? '⚠' : 'ℹ';
			node.append(el('span', 'notice-icon', glyph), el('span', 'notice-text', entry.text));
			return node;
		}
		default:
			return el('div', 'entry', JSON.stringify(entry));
	}
}

function pruneEntryViewStates(): void {
	const ids = new Set(state.ui.transcript.map((entry) => entry.id));
	for (const id of [...thoughtStates.keys()]) {
		if (!ids.has(id)) thoughtStates.delete(id);
	}
	for (const id of [...toolViews.keys()]) {
		if (!ids.has(id)) toolViews.delete(id);
	}
}

function rebuildTranscript(): void {
	entryNodes.clear();
	refs.transcript.replaceChildren();
	rebuildThoughtIndex();
	for (const entry of state.ui.transcript) {
		const node = createEntryNode(entry);
		entryNodes.set(entry.id, node);
		refs.transcript.append(node);
	}
	pruneEntryViewStates();
}

function upsertEntry(entry: TranscriptEntry, fresh = false): void {
	const stick = isNearBottom();
	rebuildThoughtIndex();
	if (entry.kind === 'thought') {
		const group = thoughtIndex.get(entry.id);
		if (group) {
			finalizeThoughtGroup(group);
			refreshThoughtGroup(group);
			if (fresh) handleNewContent(stick);
			else if (stick) scrollToBottom();
			return;
		}
	}
	// 助手正文开始输出后收起同一条消息的思考链。
	if (entry.kind === 'assistant' && entry.streaming === true && entry.text.trim().length > 0) {
		autoCollapseThoughts(entry.messageId);
	}
	const node = createEntryNode(entry);
	const existing = entryNodes.get(entry.id);
	if (existing) existing.replaceWith(node);
	else refs.transcript.append(node);
	entryNodes.set(entry.id, node);
	if (fresh) handleNewContent(stick);
	else if (stick) scrollToBottom();
}

// ---------------------------------------------------------------------------
// 空状态：词标 + 黑底白鲸 + 状态行 + 文字链接
// ---------------------------------------------------------------------------

const SVG_NS = 'http://www.w3.org/2000/svg';

/** 启动页黑底方块里的官方白鲸 logo（DSH FISH_LOGO_PATH，23.16×17.04）。 */
function whaleMark(): SVGSVGElement {
	const svg = document.createElementNS(SVG_NS, 'svg');
	svg.setAttribute('viewBox', `0 0 ${FISH_LOGO_VIEWBOX.width} ${FISH_LOGO_VIEWBOX.height}`);
	svg.setAttribute('width', '56');
	svg.setAttribute('height', String((56 * FISH_LOGO_VIEWBOX.height) / FISH_LOGO_VIEWBOX.width));
	svg.setAttribute('fill', 'currentColor');
	svg.setAttribute('aria-hidden', 'true');
	svg.setAttribute('focusable', 'false');
	const path = document.createElementNS(SVG_NS, 'path');
	path.setAttribute('d', FISH_LOGO_PATH);
	svg.append(path);
	return svg;
}

/**
 * 官方横向 wordmark（只显示 "deepseek" + HARNESS 徽标，不重复鲸鱼）。
 *
 * 图形来自 `@deepseek-ai/dsh-client-ui-primitives` 的 BrandWordmark：字母用
 * currentColor；HARNESS 徽标底为 currentColor、字母用启动页背景色（CSS
 * `.brand-badge-letter`），与官方深/浅主题一致。
 */
function brandWordmark(): SVGSVGElement {
	const width = (26 * 156) / 24;
	const svg = document.createElementNS(SVG_NS, 'svg');
	svg.setAttribute('viewBox', WORDMARK_TEXT_VIEWBOX);
	svg.setAttribute('width', String(width));
	svg.setAttribute('height', '26');
	svg.setAttribute('fill', 'none');
	svg.setAttribute('aria-hidden', 'true');
	svg.setAttribute('focusable', 'false');

	for (const data of WORDMARK_LETTERS) {
		const path = document.createElementNS(SVG_NS, 'path');
		path.setAttribute('d', data);
		path.setAttribute('fill', 'currentColor');
		svg.append(path);
	}

	const badge = document.createElementNS(SVG_NS, 'rect');
	badge.setAttribute('x', String(WORDMARK_BADGE.x));
	badge.setAttribute('y', String(WORDMARK_BADGE.y));
	badge.setAttribute('width', String(WORDMARK_BADGE.width));
	badge.setAttribute('height', String(WORDMARK_BADGE.height));
	badge.setAttribute('rx', String(WORDMARK_BADGE.rx));
	badge.setAttribute('fill', 'currentColor');
	svg.append(badge);

	const clipId = 'dsh-brand-badge-clip';
	const defs = document.createElementNS(SVG_NS, 'defs');
	const clip = document.createElementNS(SVG_NS, 'clipPath');
	clip.setAttribute('id', clipId);
	const clipRect = document.createElementNS(SVG_NS, 'rect');
	clipRect.setAttribute('width', String(WORDMARK_BADGE_CLIP.width));
	clipRect.setAttribute('height', String(WORDMARK_BADGE_CLIP.height));
	clipRect.setAttribute('x', String(WORDMARK_BADGE_CLIP.x));
	clipRect.setAttribute('y', String(WORDMARK_BADGE_CLIP.y));
	clipRect.setAttribute(
		'transform',
		`translate(${WORDMARK_BADGE_CLIP.translateX} ${WORDMARK_BADGE_CLIP.translateY})`,
	);
	clipRect.setAttribute('fill', 'white');
	clip.append(clipRect);
	defs.append(clip);
	svg.append(defs);

	const letters = document.createElementNS(SVG_NS, 'g');
	letters.setAttribute('clip-path', `url(#${clipId})`);
	for (const data of WORDMARK_BADGE_LETTERS) {
		const path = document.createElementNS(SVG_NS, 'path');
		path.setAttribute('d', data);
		path.setAttribute('class', 'brand-badge-letter');
		letters.append(path);
	}
	svg.append(letters);
	return svg;
}

function emptyStatusText(phase: RuntimePhase, error: string | undefined): string {
	switch (phase) {
		case 'ready':
			return '发送消息开始对话，或从下面的快捷操作开始。';
		case 'starting':
			return '正在启动 DSH 运行时，稍等几秒即可开始。';
		case 'error':
			return error || '运行时连接失败，可在「⋯」菜单里重启。';
		default:
			return '发送消息会自动启动 DSH 运行时。';
	}
}

/** 启动页退场动画时长（与 style.css 的 `.empty-state.is-leaving` 对齐）。 */
const LAUNCH_EXIT_MS = 160;

let launchVisible = false;
let launchHideTimer: number | undefined;
let launchStatusNode: HTMLDivElement | undefined;

/** 重建启动页内容（白鲸 + 词标 + 状态行 + 快捷链接）。 */
function buildLaunchContent(): void {
	const empty = refs.emptyState;
	empty.replaceChildren();
	const { runtime } = state.ui;

	const launch = el('div', 'launch');
	// 图标在上、文字在下；鲸鱼不再套黑底方块，避免和主题背景产生色差。
	const mark = el('div', 'launch-mark');
	mark.append(whaleMark());
	launch.append(mark);
	const wordmark = el('div', 'launch-wordmark');
	wordmark.setAttribute('role', 'img');
	wordmark.setAttribute('aria-label', 'DeepSeek Harness');
	wordmark.append(brandWordmark());
	launch.append(wordmark);
	launchStatusNode = el('div', 'launch-status', emptyStatusText(runtime.phase, runtime.error));
	launch.append(launchStatusNode);

	const links = el('div', 'launch-links');
	links.append(
		actionButton(
			'审查当前文件',
			'审查当前编辑器里的文件',
			() => post({ type: 'runCommand', command: 'reviewFile' }),
			'link-button',
		),
		actionButton(
			'审查改动',
			'审查工作区未提交的改动',
			() => post({ type: 'runCommand', command: 'reviewChanges' }),
			'link-button',
		),
		actionButton(
			'解释选区',
			'解释当前选中的代码',
			() => post({ type: 'runCommand', command: 'explainSelection' }),
			'link-button',
		),
		actionButton('新建会话', '新建一个 DSH 会话', () => post({ type: 'newSession' }), 'link-button'),
	);
	launch.append(links);
	empty.append(launch);
}

function updateLaunchStatus(): void {
	if (!launchStatusNode) return;
	launchStatusNode.textContent = emptyStatusText(state.ui.runtime.phase, state.ui.runtime.error);
}

/** 淡入启动页；已显示时只刷新状态行，避免每次 state 推送都重播动画。 */
function showLaunch(): void {
	const empty = refs.emptyState;
	if (launchHideTimer !== undefined) {
		window.clearTimeout(launchHideTimer);
		launchHideTimer = undefined;
	}
	empty.classList.remove('is-leaving');
	if (launchVisible) {
		empty.classList.add('is-visible');
		updateLaunchStatus();
		return;
	}
	buildLaunchContent();
	empty.hidden = false;
	// 强制 reflow，让刚取消隐藏的节点从初始 opacity/transform 开始过渡。
	void empty.offsetWidth;
	empty.classList.add('is-visible');
	launchVisible = true;
}

/** 淡出启动页后隐藏；重复调用不会重启计时，避免快速切换时闪烁。 */
function hideLaunch(): void {
	if (!launchVisible || launchHideTimer !== undefined) return;
	const empty = refs.emptyState;
	empty.classList.remove('is-visible');
	empty.classList.add('is-leaving');
	launchHideTimer = window.setTimeout(() => {
		launchHideTimer = undefined;
		empty.hidden = true;
		empty.replaceChildren();
		empty.classList.remove('is-leaving');
		launchStatusNode = undefined;
		launchVisible = false;
	}, LAUNCH_EXIT_MS);
}

/**
 * 空会话才显示启动页。只含 notice 的会话（如「已新建会话。」或运行时报错）
 * 仍算空会话，否则新建会话后鲸鱼启动页会被提示条挤掉。
 */
function renderEmptyState(): void {
	if (shouldShowLaunch(state.ui.transcript)) showLaunch();
	else hideLaunch();
}

// ---------------------------------------------------------------------------
// findings：可折叠 + severity 筛选 + 单条修复
// ---------------------------------------------------------------------------

const FINDING_FILTERS: readonly FindingFilter[] = ['all', 'error', 'warning', 'info'];

function renderFindings(): void {
	const findings = state.ui.findings;
	refs.findingsSection.hidden = findings.length === 0;
	const counts = severityCounts(findings);
	refs.findingsCount.textContent = counts.total > 0 ? `（${counts.total}）` : '';
	refs.findingsToggle.setAttribute('aria-expanded', findingsCollapsed ? 'false' : 'true');
	refs.findingsChevron.textContent = findingsCollapsed ? '▸' : '▾';
	refs.findingsToggle.title = findingsCollapsed ? '展开审查结果' : '折叠审查结果';
	refs.findingsFilters.hidden = findingsCollapsed;
	refs.findingsList.hidden = findingsCollapsed;

	refs.findingsFilters.replaceChildren();
	for (const filter of FINDING_FILTERS) {
		const count = filter === 'all' ? counts.total : counts[filter];
		const filterName = filter === 'all' ? '全部' : SEVERITY_LABELS[filter];
		const chip = button(findingFilterLabel(filter, count), `只看${filterName}`, 'filter-chip');
		const active = findingsFilter === filter;
		chip.classList.toggle('is-active', active);
		chip.setAttribute('aria-pressed', active ? 'true' : 'false');
		chip.addEventListener('click', () => {
			findingsFilter = filter;
			renderFindings();
		});
		refs.findingsFilters.append(chip);
	}

	refs.findingsList.replaceChildren();
	const visible = filterFindings(findings, findingsFilter);
	if (visible.length === 0) {
		refs.findingsList.append(el('div', 'findings-empty', '该严重级别暂无发现'));
		return;
	}
	for (const finding of visible) {
		const row = el('div', 'finding');
		const main = el('button', 'finding-main');
		main.type = 'button';
		main.title = finding.detail ? `${finding.title}\n${finding.detail}` : finding.title;
		const severity = el(
			'span',
			`finding-severity finding-${finding.severity}`,
			SEVERITY_LABELS[finding.severity] ?? finding.severity,
		);
		const end = finding.endLine && finding.endLine !== finding.line ? `-${finding.endLine}` : '';
		const location = el('span', 'finding-location', `${finding.file}:${finding.line}${end}`);
		main.append(severity, el('span', 'finding-title', finding.title), location);
		main.addEventListener('click', () => {
			post({ type: 'openFile', path: finding.file, line: finding.line });
		});
		const fix = button('修复', '让 DSH 修复这条发现', 'finding-fix');
		fix.addEventListener('click', () => {
			post({ type: 'fixFinding', finding });
		});
		row.append(main, fix);
		refs.findingsList.append(row);
	}
}

// ---------------------------------------------------------------------------
// 输入区 chips / 统一菜单入口
// ---------------------------------------------------------------------------

function reasoningOption(): ConfigOption | undefined {
	return findConfigOption(state.ui.configOptions, 'reasoning');
}

function reasoningIndex(option: ConfigOption): number {
	const current = currentConfigValue(option);
	const index = option.values.findIndex((value) => value.value === current);
	return index < 0 ? 0 : index;
}

function renderComposerHint(): void {
	const base = composerHintText({
		mode: state.ui.mode,
		autoReview: state.ui.autoReview,
		permissionMode: state.ui.permissionMode,
	});
	const busyHint = state.ui.busy ? '正在回复：Enter 排队，Ctrl+Enter 引导（不打断当前回复）' : '';
	const text = [base, busyHint].filter((part) => part.length > 0).join(' · ');
	refs.composerHint.textContent = text;
	refs.composerHint.hidden = text.length === 0;
}

/** 模式徽标：只在计划/目标模式显示，点击打开「+」菜单。 */
function renderModeBadge(): void {
	const mode = state.ui.mode;
	refs.modeBadge.hidden = mode === 'agent';
	refs.modeBadge.textContent = modeLabel(mode);
	refs.modeBadge.classList.add('is-warning');
	refs.modeBadge.title =
		mode === 'plan'
			? '计划模式：只读分析，不修改文件（点击切换模式）'
			: '目标模式：跨轮次追踪完成目标（点击切换模式）';
	refs.modeBadge.setAttribute('aria-label', `协作模式：${modeLabel(mode)}`);
}

/** 权限 chip：当前预设 + ⌄；完全权限用 danger 色，计划模式用 warning 色。 */
function renderPermissionChip(): void {
	const mode = state.ui.permissionMode;
	const plan = state.ui.mode === 'plan';
	refs.permissionChip.textContent = `${permissionLabel(mode)} ⌄`;
	refs.permissionChip.classList.toggle('is-danger', mode === 'danger-full-access');
	refs.permissionChip.classList.toggle('is-warning', plan);
	refs.permissionChip.title = plan
		? '计划模式下写入请求会被拒绝（点击查看权限菜单）'
		: `${permissionDescription(mode)}（${permissionHint(mode)}）`;
	refs.permissionChip.setAttribute('aria-label', `权限：${permissionLabel(mode)}`);
	refs.composerShell.classList.toggle('mode-plan', plan);
}

/**
 * 合并 chip：模型名 + 上下文用量（环/百分比，缺 size 时退回 token 数）+ 推理档位 + ⌄。
 * 未就绪时显示占位文案，仍可打开菜单看空状态。
 */
function renderModelChip(): void {
	const option = findConfigOption(state.ui.configOptions, 'model');
	const current = currentConfigValue(option);
	const ready = option !== undefined && option.values.length > 0;
	const currentName = ready ? option?.values.find((value) => value.value === current)?.name : undefined;
	const modelLabel = ready ? (currentName ?? current) : '模型…';
	const children: HTMLElement[] = [el('span', 'chip-label', modelLabel)];

	const usage = state.ui.usage;
	const percent = contextUsagePercent(usage);
	if (percent !== undefined) {
		const indicator = el('span', 'usage-indicator');
		indicator.classList.toggle('is-high', percent > 90);
		const ring = el('span', 'usage-ring');
		ring.style.setProperty('--usage-percent', String(percent));
		indicator.append(ring, el('span', 'usage-percent', `${percent}%`));
		const detail = formatUsageText(usage);
		indicator.title = detail ? `${detail} · 上下文 ${percent}%` : `上下文用量 ${percent}%`;
		indicator.setAttribute('aria-label', `上下文用量 ${percent}%`);
		children.push(indicator);
	} else {
		const tokenText = usageBadgeText(usage);
		if (tokenText.length > 0) {
			const badge = el('span', 'usage-badge', tokenText);
			badge.title = formatUsageText(usage) || '上下文用量';
			children.push(badge);
		}
	}

	const reasoning = reasoningOption();
	const effortVisible = reasoning !== undefined && reasoning.values.length > 1;
	const effortValue = effortVisible && reasoning ? reasoning.values[reasoningIndex(reasoning)] : undefined;
	if (effortValue) children.push(el('span', 'chip-effort', reasoningChipLabel(effortValue.name, effortValue.value)));

	children.push(el('span', 'chip-caret', '⌄'));
	refs.modelChip.replaceChildren(...children);
	refs.modelChip.classList.toggle('is-muted', !ready);

	const effortLabel = effortValue ? reasoningChipLabel(effortValue.name, effortValue.value) : undefined;
	refs.modelChip.title = !ready
		? '模型列表尚未就绪'
		: effortLabel
			? `模型：${modelLabel} · 推理：${effortLabel}（点击调整）`
			: `模型：${modelLabel}（点击切换）`;
	refs.modelChip.setAttribute(
		'aria-label',
		ready ? `模型与推理：${modelLabel}${effortLabel ? `，推理 ${effortLabel}` : ''}` : '模型列表尚未就绪',
	);
}

// ---------------------------------------------------------------------------
// 统一菜单：+ / 权限 / 模型 / 推理 / 顶部 ⋯（都走 menu.ts 的单例 popover）
// ---------------------------------------------------------------------------

/** 打开普通菜单前先收起斜杠面板，保证 `slashPaletteOpen` 与真实 DOM 一致。 */
function openComposerMenu(
	anchor: HTMLElement,
	entries: MenuEntry[],
	options: {
		title?: string;
		align?: 'left' | 'right';
		keyboard?: 'menu' | 'anchor';
		onPick?: (id: string) => void;
	} = {},
): void {
	slashPaletteOpen = false;
	openPopoverMenu(anchor, entries, options);
}

/** 切换协作模式（与当前相同则只提示，不发消息）。 */
function setSessionMode(target: SessionMode): void {
	if (state.ui.mode === target) {
		showToast('info', target === 'agent' ? '已在自动模式' : `已在${modeLabel(target)}模式`);
		return;
	}
	state.ui.mode = target;
	post({ type: 'setMode', mode: target });
	renderModeBadge();
	renderPermissionChip();
	renderComposerHint();
	showToast('info', target === 'agent' ? '已回到自动模式' : `已进入${modeLabel(target)}模式`);
}

/** 「+」菜单：添加上下文 / 模式 / 审查 / 会话 / 更多。 */
function openPlusMenu(anchor: HTMLElement = refs.btnPickContext): void {
	const entries: MenuEntry[] = [
		{
			kind: 'section',
			label: '添加上下文',
			items: [{ id: 'attach', label: '选择文件或文件夹…', hint: 'file', description: '加入下一条消息' }],
		},
		{
			kind: 'section',
			label: '模式',
			items: modeMenuItems(state.ui.mode).map((item) => ({ ...item, id: `mode:${item.id}` })),
		},
		{
			kind: 'section',
			label: '审查',
			items: [
				{ id: 'review-file', label: '审查当前文件', hint: 'review', description: '检查当前编辑器里的文件' },
				{ id: 'review-changes', label: '审查改动', hint: 'diff', description: '审查工作区未提交的改动' },
				{ id: 'explain-selection', label: '解释选区', hint: 'explain', description: '解释当前选中的代码' },
			],
		},
		{
			kind: 'section',
			label: '会话',
			items: [
				{ id: 'new-session', label: '新建会话', hint: 'new' },
				{ id: 'history', label: '会话历史', hint: 'history' },
				{ id: 'turn-changes', label: '本轮改动', hint: 'diff' },
				{ id: 'clear-findings', label: '清除审查结果', hint: 'clear' },
			],
		},
		{
			kind: 'section',
			label: '更多',
			items: [
				{ id: 'diagnose', label: '兼容性诊断', hint: 'diagnose' },
				{ id: 'settings', label: '打开设置', hint: 'settings' },
				{ id: 'restart', label: '重启运行时', hint: 'restart' },
			],
		},
	];
	openComposerMenu(anchor, entries, {
		title: '添加内容',
		align: 'left',
		onPick: (id) => {
			if (id.startsWith('mode:')) {
				setSessionMode(normalizeMode(id.slice('mode:'.length)));
				return;
			}
			switch (id) {
				case 'attach':
					post({ type: 'pickContext' });
					break;
				case 'review-file':
					post({ type: 'runCommand', command: 'reviewFile' });
					break;
				case 'review-changes':
					post({ type: 'runCommand', command: 'reviewChanges' });
					break;
				case 'explain-selection':
					post({ type: 'runCommand', command: 'explainSelection' });
					break;
				case 'new-session':
					post({ type: 'newSession' });
					break;
				case 'history':
					toggleHistoryPanel();
					break;
				case 'turn-changes':
					post({ type: 'runCommand', command: 'showTurnChanges' });
					break;
				case 'clear-findings':
					post({ type: 'clearFindings' });
					break;
				case 'diagnose':
					post({ type: 'runCommand', command: 'diagnose' });
					break;
				case 'settings':
					post({ type: 'openSettings' });
					break;
				case 'restart':
					post({ type: 'restartRuntime' });
					break;
				default:
					break;
			}
		},
	});
}

/** 权限菜单：三个预设 + 自动审查行；每次打开时按当前 state 重建勾选状态。 */
function openPermissionMenu(): void {
	const entries: MenuEntry[] = [
		{
			kind: 'section',
			label: '权限',
			items: permissionMenuItems(state.ui.permissionMode, {
				planMode: state.ui.mode === 'plan',
				autoReview: state.ui.autoReview,
			}),
		},
	];
	openComposerMenu(refs.permissionChip, entries, {
		title: '权限',
		align: 'left',
		onPick: (id) => {
			if (id === 'auto-review') {
				post({ type: 'setAutoReview', enabled: !state.ui.autoReview });
				return;
			}
			post({ type: 'setPermissionMode', mode: normalizePermissionMode(id) });
		},
	});
}

/**
 * 合并入口的摘要面板：两行「模型 … ›」「推理等级 … ›」，与 DSH Web 的输入区
 * 二级菜单一致；选中后进入模型列表 / 推理滑块，子面板都带「← 返回」。
 */
function openModelPanelMenu(): void {
	const option = findConfigOption(state.ui.configOptions, 'model');
	const current = currentConfigValue(option);
	const ready = option !== undefined && option.values.length > 0;
	const modelName = ready ? (option?.values.find((value) => value.value === current)?.name ?? current) : '尚未就绪';
	const reasoning = reasoningOption();
	const effortVisible = reasoning !== undefined && reasoning.values.length > 1;
	const effortName = effortVisible && reasoning ? reasoning.values[reasoningIndex(reasoning)]?.name : undefined;
	const entries: MenuEntry[] = [
		{
			kind: 'section',
			label: '',
			items: [
				{ id: 'model', label: '模型', hint: 'model', description: `${modelName} ›` },
				{
					id: 'effort',
					label: '推理等级',
					hint: 'reasoning',
					description: effortVisible ? `${effortName ?? '默认'} ›` : '不可用',
					disabled: !effortVisible,
				},
			],
		},
	];
	openComposerMenu(refs.modelChip, entries, {
		align: 'right',
		onPick: (id) => {
			if (id === 'model') openModelListMenu();
			else if (id === 'effort') openReasoningMenu();
		},
	});
}

/** 模型列表子面板：顶部「← 返回」，其余按服务端分组、当前模型勾选。 */
function openModelListMenu(): void {
	const option = findConfigOption(state.ui.configOptions, 'model');
	const current = currentConfigValue(option);
	const entries: MenuEntry[] = [
		{ kind: 'section', label: '', items: [{ id: '__back', label: '← 返回', hint: 'back' }] },
		...modelMenuGroups(option, current).map((group) => ({
			kind: 'section' as const,
			label: group.title ?? '',
			items: group.items,
		})),
	];
	openComposerMenu(refs.modelChip, entries, {
		title: '模型',
		align: 'right',
		onPick: (id) => {
			if (id === '__back') {
				openModelPanelMenu();
				return;
			}
			if (!option || id === '__empty') return;
			post({ type: 'setConfig', configId: option.id, value: id });
		},
	});
}

/** 推理等级子面板：顶部「← 返回」+ 单条 range 滑块，`change` 时提交一次 setConfig。 */
function openReasoningMenu(): void {
	const option = reasoningOption();
	if (!option || option.values.length <= 1) {
		openModelPanelMenu();
		return;
	}
	const entries: MenuEntry[] = [
		{ kind: 'section', label: '', items: [{ id: '__back', label: '← 返回', hint: 'back' }] },
		{
			kind: 'slider',
			id: option.id,
			label: '推理等级',
			ticks: option.values.map((value) => value.name),
			value: reasoningIndex(option),
			onChange: (index) => {
				const value = option.values[index];
				if (!value) return;
				post({ type: 'setConfig', configId: option.id, value: value.value });
			},
		},
	];
	openComposerMenu(refs.modelChip, entries, {
		title: '推理等级',
		align: 'right',
		onPick: (id) => {
			if (id === '__back') openModelPanelMenu();
		},
	});
}

/** 字号子面板：`⋯` 菜单 →「显示 / 字号」，松手即时写设置并应用。 */
function openFontScaleMenu(): void {
	const entries: MenuEntry[] = [
		{ kind: 'section', label: '', items: [{ id: '__back', label: '← 返回', hint: 'back' }] },
		{
			kind: 'slider',
			id: 'font-scale',
			label: '字号',
			ticks: ['80%', '100%', '120%', '140%', '160%', '180%'],
			value: fontScaleIndex(state.ui.fontScale),
			onChange: (index) => {
				const scale = FONT_SCALES[index];
				if (scale === undefined) return;
				state.ui.fontScale = scale;
				applyFontScale(scale);
				post({ type: 'setFontScale', value: scale });
			},
		},
	];
	openComposerMenu(refs.menuButton, entries, {
		title: '字号',
		align: 'right',
		onPick: (id) => {
			if (id === '__back') openTopbarMenu();
		},
	});
}

/** 顶部「⋯」菜单：显示（字号）/ 会话 / 审查 / 更多。 */
function openTopbarMenu(): void {
	const entries: MenuEntry[] = [
		{
			kind: 'section',
			label: '显示',
			items: [
				{
					id: 'font-size',
					label: '字号',
					hint: 'font size',
					description: `${fontScalePercent(state.ui.fontScale)} ›`,
				},
			],
		},
		{
			kind: 'section',
			label: '会话',
			items: [
				{ id: 'new-session', label: '新建会话', hint: 'new' },
				{ id: 'history', label: '会话历史', hint: 'history' },
				{ id: 'turn-changes', label: '本轮改动', hint: 'diff' },
			],
		},
		{
			kind: 'section',
			label: '审查',
			items: [{ id: 'clear-findings', label: '清除审查结果', hint: 'clear' }],
		},
		{
			kind: 'section',
			label: '更多',
			items: [
				{ id: 'diagnose', label: '兼容性诊断', hint: 'diagnose' },
				{ id: 'settings', label: '打开设置', hint: 'settings' },
				{ id: 'restart', label: '重启运行时', hint: 'restart' },
			],
		},
	];
	openComposerMenu(refs.menuButton, entries, {
		align: 'right',
		onPick: (id) => {
			switch (id) {
				case 'font-size':
					openFontScaleMenu();
					break;
				case 'new-session':
					post({ type: 'newSession' });
					break;
				case 'history':
					toggleHistoryPanel();
					break;
				case 'turn-changes':
					post({ type: 'runCommand', command: 'showTurnChanges' });
					break;
				case 'clear-findings':
					post({ type: 'clearFindings' });
					break;
				case 'diagnose':
					post({ type: 'runCommand', command: 'diagnose' });
					break;
				case 'settings':
					post({ type: 'openSettings' });
					break;
				case 'restart':
					post({ type: 'restartRuntime' });
					break;
				default:
					break;
			}
		},
	});
}

// ---------------------------------------------------------------------------
// 斜杠指令面板 + 本地执行
// ---------------------------------------------------------------------------

/** 当前是否有斜杠面板（区别于其他 popover：只有它使用 `keyboard:'anchor'`）。 */
let slashPaletteOpen = false;
let slashPaletteIds: string[] = [];
let slashPaletteIndex = 0;

/** 模式类指令 → 目标模式。 */
const MODE_COMMAND_TARGETS: Readonly<Record<string, SessionMode>> = {
	plan: 'plan',
	'plan-off': 'agent',
	goal: 'goal',
	'goal-off': 'agent',
	auto: 'agent',
};

function slashMenuItems(commands: readonly SlashCommand[]): MenuItemModel[] {
	return commands.map((command) => ({
		id: command.id,
		label: command.usage,
		hint: command.label,
		description: command.description,
	}));
}

/** 打开斜杠面板（anchor 键盘模式：焦点留在 textarea，高亮由 main.ts 控制）。 */
function openSlashPalette(matches: SlashCommand[]): void {
	if (matches.length === 0) {
		closeSlashPalette();
		return;
	}
	slashPaletteIds = matches.map((command) => command.id);
	slashPaletteIndex = 0;
	openPopoverMenu(
		refs.input,
		[{ kind: 'section', label: '指令', items: slashMenuItems(matches) }],
		{
			keyboard: 'anchor',
			align: 'left',
			onPick: (id) => runSlashCommand(id),
			onClose: () => {
				slashPaletteOpen = false;
			},
		},
	);
	slashPaletteOpen = true;
	highlightPopoverItem(slashPaletteIds[0] ?? '');
}

function closeSlashPalette(): void {
	if (!slashPaletteOpen) return;
	slashPaletteOpen = false;
	closePopoverMenu();
}

/** 输入变化：`/` 开头且还没构成完整指令时重建面板，否则关闭。 */
function syncSlashPalette(): void {
	const value = refs.input.value;
	if (!shouldShowSlashPalette(value)) {
		closeSlashPalette();
		return;
	}
	const matches = matchSlashCommands(value);
	if (matches.length === 0) {
		closeSlashPalette();
		return;
	}
	openSlashPalette(matches);
}

function moveSlashHighlight(direction: 1 | -1): void {
	const count = slashPaletteIds.length;
	if (count === 0) return;
	slashPaletteIndex = (slashPaletteIndex + direction + count) % count;
	highlightPopoverItem(slashPaletteIds[slashPaletteIndex] ?? '');
}

/** 只读指令帮助：选中后把 usage 填回输入框，不执行。 */
function openHelpMenu(): void {
	openComposerMenu(
		refs.input,
		[{ kind: 'section', label: '全部指令', items: slashMenuItems(SLASH_COMMANDS) }],
		{
			title: '斜杠指令',
			keyboard: 'menu',
			align: 'left',
			onPick: (id) => {
				const command = SLASH_COMMANDS.find((item) => item.id === id);
				if (!command) return;
				refs.input.value = command.usage;
				autoSizeInput();
				refs.input.focus();
			},
		},
	);
}

/** 执行一条斜杠指令：先清空输入/关闭面板，再按 id 分派到 post(...) 或本地动作。 */
function runSlashCommand(id: string): void {
	closeSlashPalette();
	closePopoverMenu();
	refs.input.value = '';
	autoSizeInput();

	const targetMode = MODE_COMMAND_TARGETS[id];
	if (targetMode) {
		setSessionMode(targetMode);
		refs.input.focus();
		return;
	}

	switch (id) {
		case 'new':
			post({ type: 'newSession' });
			showToast('info', '已新建会话');
			break;
		case 'history':
			toggleHistoryPanel();
			break;
		case 'review':
			post({ type: 'runCommand', command: 'reviewFile' });
			showToast('info', '正在审查当前文件…');
			break;
		case 'clear':
			post({ type: 'clearFindings' });
			showToast('info', '已清除审查结果');
			break;
		case 'permission':
			openPermissionMenu();
			return;
		case 'model':
			openModelPanelMenu();
			return;
		case 'diagnose':
			post({ type: 'runCommand', command: 'diagnose' });
			showToast('info', '正在生成兼容性诊断…');
			break;
		case 'settings':
			post({ type: 'openSettings' });
			break;
		case 'help':
			openHelpMenu();
			return;
		default:
			showToast('warn', `未知指令：/${id}`);
			return;
	}
	refs.input.focus();
}

function renderContextChips(): void {
	refs.chips.replaceChildren();
	if (state.draftRefs.length === 0) {
		refs.chips.hidden = true;
		return;
	}
	refs.chips.hidden = false;
	for (const [index, ref] of state.draftRefs.entries()) {
		const chip = el('span', 'context-chip');
		if (ref.kind === 'image') chip.append(el('span', 'context-chip-kind', '图'));
		chip.append(el('span', 'context-chip-name', ref.name));
		chip.title = ref.kind === 'image' ? `图片 · ${ref.uri}` : ref.uri;
		const remove = button('×', `移除上下文 ${ref.name}`);
		remove.className = 'context-chip-remove';
		remove.addEventListener('click', () => {
			state.draftRefs.splice(index, 1);
			renderContextChips();
			updateSendButton();
		});
		chip.append(remove);
		refs.chips.append(chip);
	}
	const clear = button('清空', '清空全部上下文');
	clear.className = 'link-button';
	clear.addEventListener('click', () => {
		state.draftRefs = [];
		renderContextChips();
		updateSendButton();
	});
	refs.chips.append(clear);
}

function normalizeAutoContext(value: unknown): AutoContextInfo | undefined {
	if (!value || typeof value !== 'object') return undefined;
	const raw = value as Partial<AutoContextInfo>;
	if (raw.kind !== 'file' && raw.kind !== 'selection' && raw.kind !== 'none') return undefined;
	const info: AutoContextInfo = { kind: raw.kind };
	if (typeof raw.path === 'string') info.path = raw.path;
	if (typeof raw.uri === 'string') info.uri = raw.uri;
	if (typeof raw.languageId === 'string') info.languageId = raw.languageId;
	if (typeof raw.startLine === 'number') info.startLine = raw.startLine;
	if (typeof raw.endLine === 'number') info.endLine = raw.endLine;
	if (typeof raw.chars === 'number') info.chars = raw.chars;
	if (typeof raw.note === 'string') info.note = raw.note;
	return info;
}

/** 「自动上下文：<path>（选区 Lx-Ly / 全文）」文案。 */
function autoContextText(info: AutoContextInfo): string {
	if (info.kind === 'none') return '自动上下文：无';
	const path = info.path ?? info.uri ?? '当前文件';
	if (info.kind === 'selection') {
		const range =
			typeof info.startLine === 'number'
				? `选区 L${info.startLine}${typeof info.endLine === 'number' ? `-${info.endLine}` : ''}`
				: '选区';
		return `自动上下文：${path}（${range}）`;
	}
	return `自动上下文：${path}（全文）`;
}

/**
 * composer 上方的自动上下文 chip：展示扩展当前会附带的文件/选区，并带一个开关。
 * 关闭后仍保留一行「已关闭」，否则 chip 消失后就没法再打开。
 */
function renderAutoContext(): void {
	const bar = refs.autoContextBar;
	const info = state.ui.autoContext;
	bar.replaceChildren();
	bar.classList.toggle('is-disabled', !autoContextEnabled);
	const visible = !autoContextEnabled || (info !== undefined && info.kind !== 'none');
	if (!visible) {
		bar.hidden = true;
		return;
	}
	bar.hidden = false;
	const text = autoContextEnabled && info ? autoContextText(info) : '自动上下文：已关闭';
	const label = el('span', 'auto-context-label', text);
	if (autoContextEnabled && info) {
		const hint = [info.uri, typeof info.chars === 'number' ? `${info.chars} 字符` : undefined]
			.filter((item): item is string => typeof item === 'string' && item.length > 0)
			.join(' · ');
		if (hint) label.title = hint;
	}
	bar.append(label);
	if (autoContextEnabled && info?.note) bar.append(el('span', 'auto-context-note', info.note));
	const toggle = button(
		autoContextEnabled ? '开' : '关',
		autoContextEnabled ? '点击关闭自动附带上下文' : '点击开启自动附带上下文',
		'auto-context-toggle',
	);
	toggle.setAttribute('role', 'switch');
	toggle.setAttribute('aria-checked', autoContextEnabled ? 'true' : 'false');
	toggle.addEventListener('click', () => {
		autoContextEnabled = !autoContextEnabled;
		persistAutoContextEnabled();
		post({ type: 'setAutoContext', enabled: autoContextEnabled });
		renderAutoContext();
	});
	bar.append(toggle);
}

// ---------------------------------------------------------------------------
// 输入 / 发送
// ---------------------------------------------------------------------------

function canSend(): boolean {
	return refs.input.value.trim().length > 0;
}

function updateSendButton(): void {
	const busy = state.ui.busy;
	const hasDraft = canSend();
	refs.btnSend.textContent = '↑';
	refs.btnSend.title = busy ? '排队发送（Enter）：当前回复结束后自动发送' : '发送（Enter）';
	refs.btnSend.setAttribute('aria-label', refs.btnSend.title);
	refs.btnSend.disabled = !hasDraft;
	refs.btnStop.hidden = !busy;
	refs.btnStop.disabled = !busy;
	refs.btnSteer.hidden = !busy;
	refs.btnSteer.disabled = !hasDraft;
}

/** 排队插话列表：每行显示模式（排队 / 引导）、正文与「引导 / 取消」操作。 */
function renderPending(): void {
	const list = state.ui.pending;
	const bar = refs.pendingBar;
	bar.replaceChildren();
	bar.hidden = list.length === 0;
	for (const item of list) {
		const row = el('div', item.mode === 'steer' ? 'pending-item is-steer' : 'pending-item');
		row.setAttribute('role', 'listitem');
		row.dataset.pendingId = item.id;
		row.append(el('span', 'pending-badge', item.mode === 'steer' ? '引导' : '排队'));
		const text = el('span', 'pending-text', item.text.replace(/\s+/g, ' '));
		text.title = item.text;
		row.append(text);
		if (item.mode !== 'steer') {
			const steer = button('引导', '不打断当前回复，转为插队优先发送', 'pending-action');
			steer.addEventListener('click', (event: MouseEvent) => {
				event.stopPropagation();
				post({ type: 'pendingAction', id: item.id, action: 'steer' });
			});
			row.append(steer);
		}
		const cancel = button('×', '取消这条排队消息', 'pending-action pending-cancel');
		cancel.addEventListener('click', (event: MouseEvent) => {
			event.stopPropagation();
			post({ type: 'pendingAction', id: item.id, action: 'cancel' });
		});
		row.append(cancel);
		bar.append(row);
	}
}

// ---------------------------------------------------------------------------
// 头部状态 / 菜单 / 历史
// ---------------------------------------------------------------------------

function renderStatus(): void {
	const { runtime, busy, session, usage } = state.ui;
	const phase = runtime.phase;
	refs.statusDot.className = `status-dot status-dot-${phase}${busy ? ' is-busy' : ''}`;
	const title = headerTitle(session?.title, phase, busy);
	refs.sessionTitle.textContent = title;
	refs.sessionTitle.title = session?.title || session?.sessionId || title;

	const detail: string[] = [];
	detail.push(
		phase === 'ready'
			? busy
				? '已连接 · 处理中'
				: '已连接'
			: phase === 'starting'
				? '正在启动 DSH 运行时'
				: phase === 'error'
					? '运行连接失败'
					: '未连接',
	);
	if (runtime.dshVersion) detail.push(`DSH ${runtime.dshVersion}`);
	if (runtime.protocolVersion !== undefined) detail.push(`ACP v${runtime.protocolVersion}`);
	if (session) detail.push(session.title || session.sessionId);
	const usageText = formatUsageText(usage);
	if (usageText) detail.push(usageText);
	if (runtime.error) detail.push(runtime.error);
	refs.statusDot.title = detail.join('\n');
	refs.statusDot.setAttribute('aria-label', detail[0]);
	updateSendButton();
}

function formatHistoryMeta(info: { cwd: string; updatedAt?: string }): string {
	const relative = formatRelativeTime(info.updatedAt);
	const parts = [relative, info.cwd].filter((part) => part.length > 0);
	return parts.join(' · ');
}

function renderHistoryPanel(): void {
	if (refs.historyPanel.hidden) return;
	refs.historyPanel.replaceChildren();
	const history = state.ui.history;
	if (history.length === 0) {
		refs.historyPanel.append(el('div', 'history-empty', '暂无历史会话'));
		return;
	}
	for (const info of history) {
		const item = button('', `恢复会话 ${info.sessionId}`, 'history-item');
		item.append(el('span', 'history-title', truncateTitle(info.title || info.sessionId, 40)));
		item.append(el('span', 'history-meta', formatHistoryMeta(info)));
		item.addEventListener('click', () => {
			post({ type: 'resumeSession', sessionId: info.sessionId });
			hideHistoryPanel();
		});
		refs.historyPanel.append(item);
	}
}

function hideHistoryPanel(): void {
	refs.historyPanel.hidden = true;
	refs.historyPanel.replaceChildren();
}

function toggleHistoryPanel(): void {
	if (!refs.historyPanel.hidden) {
		hideHistoryPanel();
		return;
	}
	refs.historyPanel.hidden = false;
	renderHistoryPanel();
	// 让扩展刷新历史（扩展可能同时弹出 QuickPick，两者都可选择会话）。
	post({ type: 'runCommand', command: 'history' });
}

// ---------------------------------------------------------------------------
// 权限卡片
// ---------------------------------------------------------------------------

function renderPermission(): void {
	const request = state.permissionQueue[0];
	refs.permission.hidden = !request;
	refs.permissionTitle.textContent = '';
	refs.permissionMeta.textContent = '';
	refs.permissionBody.replaceChildren();
	refs.permissionActions.replaceChildren();
	if (!request) return;

	refs.permissionTitle.textContent = request.title || '工具需要你的批准';
	const metaParts: string[] = [];
	if (request.toolKind) metaParts.push(`工具：${request.toolKind}`);
	if (request.locations.length > 0) {
		const preview = request.locations
			.slice(0, 2)
			.map((location) => (location.line ? `${location.path}:${location.line}` : location.path))
			.join('、');
		metaParts.push(`位置：${preview}`);
	}
	refs.permissionMeta.textContent = metaParts.join(' · ');

	if (request.command) {
		refs.permissionBody.append(el('pre', 'permission-command', request.command));
	}
	if (request.locations.length > 0) {
		const locationRow = el('div', 'permission-locations');
		for (const location of request.locations.slice(0, 5)) {
			const label = location.line ? `${location.path}:${location.line}` : location.path;
			const link = button(label, `打开 ${location.path}`, 'link-button');
			link.addEventListener('click', () => {
				post({ type: 'openFile', path: location.path, line: location.line });
			});
			locationRow.append(link);
		}
		refs.permissionBody.append(locationRow);
	}

	const allowOptions = request.options.filter(
		(option: PermissionOptionInfo) => option.kind.startsWith('allow'),
	);
	const rejectOptions = request.options.filter(
		(option: PermissionOptionInfo) => !option.kind.startsWith('allow'),
	);
	const respond = (optionId?: string): void => {
		post({ type: 'permissionResponse', requestId: request.id, optionId });
		state.permissionQueue = state.permissionQueue.filter((item) => item.id !== request.id);
		renderPermission();
	};

	const once = allowOptions.find((option) => option.kind === 'allow_once') ?? allowOptions[0];
	const always = allowOptions.find((option) => option.kind === 'allow_always');
	// 主按钮：允许本次；次按钮：始终允许 / 拒绝。
	if (once) {
		refs.permissionActions.append(
			actionButton(
				once.name || '允许',
				once.name || '允许本次操作',
				() => respond(once.optionId),
				'primary-button',
			),
		);
	}
	if (always && always !== once) {
		refs.permissionActions.append(
			actionButton(
				always.name || '始终允许',
				always.name || '本次会话始终允许',
				() => respond(always.optionId),
				'ghost-button',
			),
		);
	}
	// 拒绝/取消按协议回传缺省 optionId（扩展侧映射为 cancelled）。
	refs.permissionActions.append(
		actionButton('拒绝', '拒绝本次操作', () => respond(undefined), 'ghost-button permission-reject'),
	);
	if (allowOptions.length === 0) {
		for (const option of rejectOptions) {
			refs.permissionActions.append(
				actionButton(option.name, option.name, () => respond(option.optionId), 'ghost-button'),
			);
		}
	}

	if (!refs.permission.hidden) refs.permission.scrollIntoView({ block: 'nearest' });
}

// ---------------------------------------------------------------------------
// 提示 / 错误
// ---------------------------------------------------------------------------

let toastTimer: number | undefined;

function showToast(level: 'info' | 'warn' | 'error', message: string): void {
	refs.toast.textContent = message;
	refs.toast.className = `toast toast-${level}`;
	refs.toast.hidden = false;
	if (toastTimer !== undefined) window.clearTimeout(toastTimer);
	toastTimer = window.setTimeout(
		() => {
			refs.toast.hidden = true;
			toastTimer = undefined;
		},
		level === 'error' ? 6000 : 3500,
	);
}

function showBanner(message: string): void {
	refs.bannerText.textContent = message;
	refs.banner.hidden = false;
	// 错误横幅出现时把消息区滚到底部，避免被遮挡。
	if (isNearBottom()) scrollToBottom();
}

function hideBanner(): void {
	refs.banner.hidden = true;
	refs.bannerText.textContent = '';
}

// ---------------------------------------------------------------------------
// 状态应用
// ---------------------------------------------------------------------------

function normalizeUiState(next: UiState): UiState {
	const fallback = createInitialState();
	if (!next || typeof next !== 'object') return fallback;
	return {
		runtime: next.runtime && typeof next.runtime === 'object' ? next.runtime : fallback.runtime,
		session: next.session,
		busy: Boolean(next.busy),
		configOptions: Array.isArray(next.configOptions) ? next.configOptions : [],
		transcript: Array.isArray(next.transcript) ? next.transcript : [],
		findings: Array.isArray(next.findings) ? next.findings : [],
		history: Array.isArray(next.history) ? next.history : [],
		usage: next.usage,
		autoContext: normalizeAutoContext(next.autoContext),
		mode: normalizeMode(next.mode),
		autoReview: next.autoReview === true,
		permissionMode: normalizePermissionMode(next.permissionMode),
		fontScale: normalizeFontScale(next.fontScale),
		pending: normalizePending(next.pending),
	};
}

function renderAll(): void {
	const stick = isNearBottom();
	applyFontScale(state.ui.fontScale);
	rebuildTranscript();
	renderStatus();
	renderFindings();
	renderModeBadge();
	renderPermissionChip();
	renderModelChip();
	renderPending();
	renderComposerHint();
	renderContextChips();
	renderAutoContext();
	renderEmptyState();
	renderPermission();
	renderHistoryPanel();
	updateSendButton();
	renderJumpButton();
	if (stick) scrollToBottom();
}

function applyState(next: UiState): void {
	const previousSessionId = state.ui.session?.sessionId;
	state.ui = normalizeUiState(next);
	if (previousSessionId !== state.ui.session?.sessionId) {
		// 切换会话后旧的权限请求已失效。
		state.permissionQueue = [];
		pendingNewCount = 0;
	}
	renderAll();
}

function applyAppend(entries: TranscriptEntry[] | undefined): void {
	if (!Array.isArray(entries) || entries.length === 0) return;
	for (const entry of entries) {
		if (!isTranscriptEntry(entry)) continue;
		const index = state.ui.transcript.findIndex((item) => item.id === entry.id);
		const fresh = index < 0;
		if (fresh) state.ui.transcript.push(entry);
		else state.ui.transcript[index] = entry;
		upsertEntry(entry, fresh);
	}
	renderEmptyState();
}

function applyPatch(id: string, patch: Partial<TranscriptEntry> | undefined): void {
	if (typeof id !== 'string' || !patch || typeof patch !== 'object') return;
	const index = state.ui.transcript.findIndex((item) => item.id === id);
	if (index < 0) return;
	const merged = { ...state.ui.transcript[index], ...patch } as TranscriptEntry;
	state.ui.transcript[index] = merged;
	upsertEntry(merged);
}

function enqueuePermission(request: PermissionRequest | undefined): void {
	if (!request || typeof request !== 'object' || typeof request.id !== 'string') return;
	state.permissionQueue = state.permissionQueue.filter((item) => item.id !== request.id);
	state.permissionQueue.push(request);
	renderPermission();
}

function handleMessage(raw: unknown): void {
	if (typeof raw !== 'object' || raw === null) return;
	const message = raw as ExtToWeb;
	switch (message.type) {
		case 'state':
			applyState(message.state);
			return;
		case 'append':
			applyAppend(message.entries);
			return;
		case 'patch':
			applyPatch(message.id, message.patch);
			return;
		case 'permission':
			enqueuePermission(message.request);
			return;
		case 'findings':
			state.ui.findings = Array.isArray(message.findings) ? message.findings : [];
			renderFindings();
			return;
		case 'error':
			if (typeof message.message === 'string' && message.message.length > 0) showBanner(message.message);
			return;
		case 'toast':
			showToast(message.level, message.message);
			return;
		case 'busy':
			state.ui.busy = Boolean(message.busy);
			renderStatus();
			renderEmptyState();
			renderComposerHint();
			updateSendButton();
			return;
		case 'usage':
			state.ui.usage = message.usage;
			renderStatus();
			renderModelChip();
			return;
		case 'history':
			state.ui.history = Array.isArray(message.history) ? message.history : [];
			renderHistoryPanel();
			renderEmptyState();
			return;
		case 'configOptions':
			state.ui.configOptions = Array.isArray(message.configOptions) ? message.configOptions : [];
			renderModelChip();
			renderStatus();
			return;
		case 'contextRefs':
			state.draftRefs = normalizeRefs(message.refs);
			renderContextChips();
			updateSendButton();
			refs.input.focus();
			return;
		case 'autoContext':
			state.ui.autoContext = normalizeAutoContext(message.info);
			renderAutoContext();
			return;
		case 'prefs':
			// 轻量回显：只更新输入区 chip / 提示与字号，不重建 transcript。
			state.ui.mode = normalizeMode(message.mode);
			state.ui.autoReview = message.autoReview === true;
			state.ui.permissionMode = normalizePermissionMode(message.permissionMode);
			state.ui.fontScale = normalizeFontScale(message.fontScale);
			applyFontScale(state.ui.fontScale);
			renderModeBadge();
			renderPermissionChip();
			renderModelChip();
			renderComposerHint();
			return;
		case 'runtime':
			if (message.runtime && typeof message.runtime === 'object') {
				state.ui.runtime = message.runtime;
				if (state.ui.runtime.phase !== 'ready') state.permissionQueue = [];
				renderStatus();
				renderEmptyState();
				renderPermission();
			}
			return;
		case 'focusInput':
			refs.input.focus();
			return;
		default:
			return;
	}
}

// ---------------------------------------------------------------------------
// 输入与操作
// ---------------------------------------------------------------------------

function autoSizeInput(): void {
	const input = refs.input;
	input.style.height = 'auto';
	const height = Math.min(input.scrollHeight, 180);
	input.style.height = height > 0 ? `${height}px` : '';
	updateSendButton();
}

function sendDraft(pendingMode?: 'queue' | 'steer'): void {
	const text = refs.input.value.trim();
	if (text.length === 0) {
		refs.input.focus();
		return;
	}
	// 斜杠指令在本地执行，不进入对话流。
	const slash = parseSlashCommand(text);
	if (slash) {
		runSlashCommand(slash.command.id);
		return;
	}
	closeSlashPalette();
	// 运行时未就绪也允许发送：扩展侧会先 bootstrap 再发 prompt。
	if (state.ui.runtime.phase !== 'ready' && !state.ui.busy) {
		showToast('info', '正在启动 DSH 运行时，消息会在就绪后自动发送。');
	}
	// 正在回复（或已有排队）时提交 = 排队插话，不打断当前运行。
	const queued = state.ui.busy || state.ui.pending.length > 0 ? (pendingMode ?? 'queue') : undefined;
	const refsPayload = state.draftRefs.length > 0 ? [...state.draftRefs] : undefined;
	post({ type: 'send', text, refs: refsPayload, pendingMode: queued });
	refs.input.value = '';
	state.draftRefs = [];
	renderContextChips();
	autoSizeInput();
	updateSendButton();
}

function wireUi(): void {
	refs.menuButton.addEventListener('click', (event: MouseEvent) => {
		event.stopPropagation();
		openTopbarMenu();
	});
	refs.btnPickContext.addEventListener('click', (event: MouseEvent) => {
		event.stopPropagation();
		openPlusMenu();
	});
	refs.modeBadge.addEventListener('click', (event: MouseEvent) => {
		event.stopPropagation();
		openPlusMenu(refs.modeBadge);
	});
	refs.permissionChip.addEventListener('click', (event: MouseEvent) => {
		event.stopPropagation();
		openPermissionMenu();
	});
	refs.modelChip.addEventListener('click', (event: MouseEvent) => {
		event.stopPropagation();
		openModelPanelMenu();
	});
	refs.btnFindingsFix.addEventListener('click', () => post({ type: 'runCommand', command: 'fixFindings' }));
	refs.btnFindingsClear.addEventListener('click', () => post({ type: 'clearFindings' }));
	refs.findingsToggle.addEventListener('click', () => {
		findingsCollapsed = !findingsCollapsed;
		renderFindings();
	});
	refs.jumpButton.addEventListener('click', jumpToBottom);
	refs.btnSend.addEventListener('click', () => sendDraft());
	refs.btnStop.addEventListener('click', () => post({ type: 'cancel' }));
	refs.btnSteer.addEventListener('click', () => sendDraft('steer'));
	refs.bannerClose.addEventListener('click', hideBanner);

	refs.scroll.addEventListener('scroll', () => {
		if (isNearBottom()) pendingNewCount = 0;
		renderJumpButton();
	});

	refs.input.addEventListener('keydown', (event: KeyboardEvent) => {
		// 斜杠面板打开时：方向键移动高亮、Enter/Tab 执行、Esc 只关面板。
		if (slashPaletteOpen) {
			if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
				event.preventDefault();
				moveSlashHighlight(event.key === 'ArrowDown' ? 1 : -1);
				return;
			}
			if (event.key === 'Enter' || event.key === 'Tab') {
				if (event.isComposing || event.keyCode === 229) return;
				event.preventDefault();
				const id = slashPaletteIds[slashPaletteIndex];
				if (id) runSlashCommand(id);
				return;
			}
			if (event.key === 'Escape') {
				event.preventDefault();
				// 斜杠面板的 Esc 不能继续触发「停止生成」。
				event.stopPropagation();
				closeSlashPalette();
				return;
			}
		}
		if (event.key !== 'Enter' || event.shiftKey) return;
		// 输入法组词时的 Enter 不能当成发送。
		if (event.isComposing || event.keyCode === 229) return;
		event.preventDefault();
		// Ctrl+Enter = 引导（插队优先发送，不打断当前回复）。
		sendDraft(event.ctrlKey || event.metaKey ? 'steer' : undefined);
	});
	refs.input.addEventListener('input', () => {
		autoSizeInput();
		syncSlashPalette();
	});

	// 拖入附件：资源管理器的文件拖到输入卡片上（图片走 image 内容块）。
	const shell = refs.composerShell;
	shell.addEventListener('dragover', (event: DragEvent) => {
		const types = event.dataTransfer?.types ?? [];
		if (!types.includes('text/uri-list') && !types.includes('Files')) return;
		event.preventDefault();
		shell.classList.add('is-drop-target');
	});
	shell.addEventListener('dragleave', () => shell.classList.remove('is-drop-target'));
	shell.addEventListener('drop', (event: DragEvent) => {
		shell.classList.remove('is-drop-target');
		if (!event.dataTransfer) return;
		const uris = event.dataTransfer
			.getData('text/uri-list')
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter((line) => line.length > 0 && !line.startsWith('#'));
		if (uris.length === 0) return;
		event.preventDefault();
		let added = 0;
		let unsupported = 0;
		for (const uri of uris) {
			if (!uri.startsWith('file:')) continue;
			if (isUnsupportedMediaPath(uri)) {
				unsupported += 1;
				continue;
			}
			if (state.draftRefs.some((ref) => ref.uri === uri)) continue;
			const mime = imageMimeType(uri);
			state.draftRefs.push({
				name: refNameFromUri(uri),
				uri,
				kind: mime ? 'image' : 'file',
				mimeType: mime,
			});
			added += 1;
		}
		renderContextChips();
		updateSendButton();
		if (added > 0) showToast('info', `已添加 ${added} 个附件`);
		else if (unsupported > 0) showToast('warn', '暂不支持音频/视频，仅支持 PNG/JPEG/WebP/GIF 图片');
	});

	// 点击外部关闭历史下拉（popover 的外部点击由 menu.ts 处理）。
	document.addEventListener('click', (event: MouseEvent) => {
		const target = event.target as Node | null;
		if (!target) return;
		if (!refs.historyPanel.hidden && !refs.historyPanel.contains(target)) hideHistoryPanel();
	});
	window.addEventListener('keydown', (event: KeyboardEvent) => {
		// 输入法组词时的 Esc 只取消候选，不能当成「停止回复」。
		if (event.isComposing) return;
		if (event.key !== 'Escape') return;
		// 顺序：斜杠面板 → popover 菜单 → 历史面板 → 取消生成。
		if (slashPaletteOpen) {
			closeSlashPalette();
			return;
		}
		if (isPopoverMenuOpen()) {
			closePopoverMenu();
			return;
		}
		if (!refs.historyPanel.hidden) {
			hideHistoryPanel();
			return;
		}
		if (state.ui.busy) post({ type: 'cancel' });
	});
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

window.addEventListener('message', (event: MessageEvent) => {
	handleMessage(event.data);
});

wireUi();
renderAll();
autoSizeInput();
post({ type: 'ready' });
refs.input.focus();
