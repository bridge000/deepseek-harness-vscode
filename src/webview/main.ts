/**
 * DSH Review 侧边栏聊天前端（原生 TypeScript + DOM，无框架）。
 *
 * 只依赖 DOM 与纯模块（`../acp/protocol` 的 `findConfigOption`、`./markdown`），
 * 不 import vscode。与扩展的通信全部走 `acquireVsCodeApi().postMessage`，
 * 消息形状见 `../ui/protocol.ts`；扩展推送的增量消息（append/patch/busy/...）
 * 与全量 state 都能渲染。
 */
import type {
	AcpCapabilities,
	ConfigOption,
	ConfigOptionValue,
	ContextRef,
	Finding,
	PermissionOptionInfo,
	PermissionRequest,
	ToolStatus,
	TranscriptEntry,
	UiState,
	UsageInfo,
} from '../types';
import { findConfigOption } from '../acp/protocol';
import type { ExtToWeb, WebviewToExt } from '../ui/protocol';
import { renderMarkdown } from './markdown';

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
	if (!node) throw new Error(`[DSH Review] 缺少界面节点 #${id}`);
	return node;
}

function shorten(value: string, max: number): string {
	return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
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
	};
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

const ENTRY_KINDS = new Set(['user', 'assistant', 'thought', 'tool', 'notice']);

function isTranscriptEntry(value: unknown): value is TranscriptEntry {
	if (typeof value !== 'object' || value === null) return false;
	const entry = value as { id?: unknown; kind?: unknown };
	return typeof entry.id === 'string' && typeof entry.kind === 'string' && ENTRY_KINDS.has(entry.kind);
}

const TOOL_STATUS_LABELS: Record<ToolStatus, string> = {
	pending: '等待',
	in_progress: '执行中',
	completed: '完成',
	failed: '失败',
};

function formatTimestamp(at: number): string {
	const date = new Date(at);
	if (Number.isNaN(date.getTime())) return '';
	const pad = (value: number): string => String(value).padStart(2, '0');
	const now = new Date();
	const sameDay =
		date.getFullYear() === now.getFullYear() &&
		date.getMonth() === now.getMonth() &&
		date.getDate() === now.getDate();
	const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
	return sameDay ? clock : `${date.getMonth() + 1}/${date.getDate()} ${clock}`;
}

function formatUsage(usage: UsageInfo): string {
	const parts: string[] = [];
	if (typeof usage.inputTokens === 'number') parts.push(`↑${usage.inputTokens}`);
	if (typeof usage.outputTokens === 'number') parts.push(`↓${usage.outputTokens}`);
	if (typeof usage.totalTokens === 'number') parts.push(`共 ${usage.totalTokens}`);
	return parts.length > 0 ? `tokens ${parts.join(' ')}` : '';
}

function currentConfigValue(option: ConfigOption): string {
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
	statusText: HTMLSpanElement;
	statusMeta: HTMLDivElement;
	btnNew: HTMLButtonElement;
	btnHistory: HTMLButtonElement;
	btnRestart: HTMLButtonElement;
	btnSettings: HTMLButtonElement;
	historyPanel: HTMLDivElement;
	banner: HTMLDivElement;
	bannerText: HTMLSpanElement;
	bannerClose: HTMLButtonElement;
	scroll: HTMLElement;
	transcript: HTMLDivElement;
	emptyState: HTMLDivElement;
	findingsSection: HTMLElement;
	findingsCount: HTMLSpanElement;
	findingsList: HTMLDivElement;
	btnFindingsFix: HTMLButtonElement;
	btnFindingsClear: HTMLButtonElement;
	permission: HTMLElement;
	permissionTitle: HTMLDivElement;
	permissionMeta: HTMLDivElement;
	permissionBody: HTMLDivElement;
	permissionActions: HTMLDivElement;
	chips: HTMLDivElement;
	input: HTMLTextAreaElement;
	btnPickContext: HTMLButtonElement;
	btnSend: HTMLButtonElement;
	modelWrap: HTMLLabelElement;
	modelSelect: HTMLSelectElement;
	reasoningWrap: HTMLLabelElement;
	reasoningSelect: HTMLSelectElement;
	toast: HTMLDivElement;
}

function buildUi(root: HTMLElement): UiRefs {
	root.classList.add('app');

	// 顶部：状态 + 操作按钮
	const topbar = el('header', 'topbar');
	const statusRow = el('div', 'status-row');
	const statusDot = el('span', 'status-dot');
	statusDot.setAttribute('aria-hidden', 'true');
	const statusText = el('span', 'status-text', '未连接');
	statusRow.append(statusDot, statusText);
	const statusMeta = el('div', 'status-meta');
	statusMeta.hidden = true;
	const actions = el('div', 'topbar-actions');
	const btnNew = button('新建', '新建会话');
	const btnHistory = button('历史', '会话历史');
	const btnRestart = button('重启', '重启 DSH 运行时');
	const btnSettings = button('设置', '打开 DSH Review 设置');
	actions.append(btnNew, btnHistory, btnRestart, btnSettings);
	topbar.append(statusRow, statusMeta, actions);

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

	// 滚动区：消息流 + 空状态 + findings
	const scroll = el('main', 'scroll-area');
	const transcript = el('div', 'transcript');
	transcript.setAttribute('role', 'log');
	transcript.setAttribute('aria-live', 'polite');
	const emptyState = el('div', 'empty-state');
	emptyState.hidden = true;

	const findingsSection = el('section', 'findings');
	findingsSection.hidden = true;
	const findingsHeader = el('div', 'findings-header');
	const findingsTitle = el('span', 'findings-title', '审查结果');
	const findingsCount = el('span', 'findings-count');
	findingsHeader.append(findingsTitle, findingsCount);
	const findingsSpacer = el('span', 'spacer');
	findingsHeader.append(findingsSpacer);
	const btnFindingsFix = button('修复', '让 DSH 修复这些发现');
	const btnFindingsClear = button('清除', '清除审查结果');
	findingsHeader.append(btnFindingsFix, btnFindingsClear);
	const findingsList = el('div', 'findings-list');
	findingsSection.append(findingsHeader, findingsList);

	scroll.append(transcript, emptyState, findingsSection);

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

	// 输入区
	const composer = el('div', 'composer');
	const chips = el('div', 'context-chips');
	chips.hidden = true;
	const input = el('textarea', 'composer-input');
	input.rows = 2;
	input.placeholder = '给 DSH 发消息…';
	input.setAttribute('aria-label', '消息输入框');
	const composerBar = el('div', 'composer-bar');
	const btnPickContext = button('＋ 上下文', '把文件/文件夹加入上下文');
	const selectors = el('div', 'composer-selectors');
	const modelWrap = el('label', 'select-wrap');
	modelWrap.hidden = true;
	const modelSelect = el('select', 'select-input');
	modelSelect.setAttribute('aria-label', '选择模型');
	modelWrap.append(el('span', 'select-label', '模型'), modelSelect);
	const reasoningWrap = el('label', 'select-wrap');
	reasoningWrap.hidden = true;
	const reasoningSelect = el('select', 'select-input');
	reasoningSelect.setAttribute('aria-label', '选择推理强度');
	reasoningWrap.append(el('span', 'select-label', '推理'), reasoningSelect);
	selectors.append(modelWrap, reasoningWrap);
	const btnSend = button('发送', '发送（Enter）', 'primary-button');
	composerBar.append(btnPickContext, selectors, btnSend);
	composer.append(chips, input, composerBar);

	// 临时提示
	const toast = el('div', 'toast');
	toast.hidden = true;
	toast.setAttribute('role', 'status');
	toast.setAttribute('aria-live', 'polite');

	root.append(topbar, historyPanel, banner, scroll, permission, composer, toast);

	return {
		statusDot,
		statusText,
		statusMeta,
		btnNew,
		btnHistory,
		btnRestart,
		btnSettings,
		historyPanel,
		banner,
		bannerText,
		bannerClose,
		scroll,
		transcript,
		emptyState,
		findingsSection,
		findingsCount,
		findingsList,
		btnFindingsFix,
		btnFindingsClear,
		permission,
		permissionTitle,
		permissionMeta,
		permissionBody,
		permissionActions,
		chips,
		input,
		btnPickContext,
		btnSend,
		modelWrap,
		modelSelect,
		reasoningWrap,
		reasoningSelect,
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

function decorateMarkdown(container: HTMLElement): void {
	for (const code of Array.from(container.querySelectorAll('pre > code'))) {
		const pre = code.parentElement;
		if (!pre) continue;
		const wrapper = el('div', 'code-block');
		pre.replaceWith(wrapper);
		wrapper.append(pre);
		const copyButton = button('复制', '复制代码');
		copyButton.className = 'copy-button';
		copyButton.addEventListener('click', () => {
			void copyText(code.textContent ?? '').then(() => {
				copyButton.textContent = '已复制';
				window.setTimeout(() => {
					copyButton.textContent = '复制';
				}, 1200);
			});
		});
		wrapper.append(copyButton);
	}
}

function markdownBody(text: string, streaming = false): HTMLElement {
	const body = el('div', streaming ? 'md streaming' : 'md');
	body.innerHTML = renderMarkdown(text);
	decorateMarkdown(body);
	return body;
}

// ---------------------------------------------------------------------------
// 单条消息渲染
// ---------------------------------------------------------------------------

function refsRow(refsList: readonly ContextRef[]): HTMLElement {
	const row = el('div', 'ref-row');
	for (const ref of refsList) row.append(el('span', 'ref-chip', ref.name));
	return row;
}

function createEntryNode(entry: TranscriptEntry): HTMLElement {
	const node = el('div', `entry entry-${entry.kind}`);
	node.dataset.entryId = entry.id;
	const time = formatTimestamp(entry.at);
	if (time) node.title = time;

	switch (entry.kind) {
		case 'user': {
			node.append(el('div', 'entry-label', '你'));
			const bubble = el('div', 'user-bubble', entry.text);
			node.append(bubble);
			if (entry.refs && entry.refs.length > 0) node.append(refsRow(entry.refs));
			break;
		}
		case 'assistant': {
			node.append(el('div', 'entry-label', 'DSH'));
			node.append(markdownBody(entry.text, entry.streaming === true));
			break;
		}
		case 'thought': {
			const details = el('details', 'thought');
			details.append(
				el('summary', 'thought-summary', entry.streaming === true ? '思考过程（生成中…）' : '思考过程'),
				markdownBody(entry.text, entry.streaming === true),
			);
			node.append(details);
			break;
		}
		case 'tool': {
			const head = el('div', 'tool-head');
			head.append(el('span', 'tool-title', entry.title || '工具调用'));
			head.append(
				el('span', `status-badge status-${entry.status}`, TOOL_STATUS_LABELS[entry.status] ?? entry.status),
			);
			node.append(head);
			const meta = el('div', 'tool-meta');
			if (entry.toolKind) meta.append(el('span', 'tool-kind', entry.toolKind));
			for (const location of entry.locations ?? []) {
				const label = location.line ? `${location.path}:${location.line}` : location.path;
				const link = button(label, `打开 ${location.path}`);
				link.className = 'link-button';
				link.addEventListener('click', () => {
					post({ type: 'openFile', path: location.path, line: location.line });
				});
				meta.append(link);
			}
			if (meta.childElementCount > 0) node.append(meta);
			if (entry.detail) {
				const detail = el('details', 'tool-detail');
				const pre = el('pre', 'tool-detail-text', entry.detail);
				detail.append(el('summary', '', '详情'), pre);
				node.append(detail);
			}
			break;
		}
		case 'notice': {
			node.classList.add(`notice-${entry.level}`);
			node.textContent = entry.text;
			break;
		}
		default: {
			node.textContent = JSON.stringify(entry);
		}
	}

	return node;
}

function rebuildTranscript(): void {
	entryNodes.clear();
	refs.transcript.replaceChildren();
	for (const entry of state.ui.transcript) {
		const node = createEntryNode(entry);
		entryNodes.set(entry.id, node);
		refs.transcript.append(node);
	}
}

function upsertEntry(entry: TranscriptEntry): void {
	const stick = isNearBottom();
	const node = createEntryNode(entry);
	const existing = entryNodes.get(entry.id);
	if (existing) existing.replaceWith(node);
	else refs.transcript.append(node);
	entryNodes.set(entry.id, node);
	if (stick) scrollToBottom();
}

// ---------------------------------------------------------------------------
// 各区域渲染
// ---------------------------------------------------------------------------

function renderEmptyState(): void {
	const empty = refs.emptyState;
	if (state.ui.transcript.length > 0) {
		empty.hidden = true;
		empty.replaceChildren();
		return;
	}
	empty.hidden = false;
	empty.replaceChildren();
	const runtime = state.ui.runtime;
	const title = el('div', 'empty-title');
	const body = el('div', 'empty-body');
	const actions = el('div', 'empty-actions');

	switch (runtime.phase) {
		case 'ready': {
			title.textContent = '开始与 DSH 对话';
			body.textContent = 'Enter 发送，Shift+Enter 换行；点「＋ 上下文」附加文件。';
			break;
		}
		case 'starting': {
			title.textContent = '正在启动 DSH 运行时…';
			body.textContent = '首次启动需要几秒钟，请稍候。';
			break;
		}
		case 'error': {
			title.textContent = 'DSH 运行时连接失败';
			body.textContent = runtime.error || '请检查可执行文件路径与权限模式设置。';
			actions.append(
				actionButton('重启运行时', '重新启动 DSH 运行时', () => post({ type: 'restartRuntime' })),
				actionButton('打开设置', '打开 DSH Review 设置', () => post({ type: 'openSettings' })),
				actionButton('运行诊断', '生成兼容性诊断报告', () =>
					post({ type: 'runCommand', command: 'diagnose' }),
				),
			);
			break;
		}
		default: {
			title.textContent = 'DSH 运行时未连接';
			body.textContent = '点击下方按钮启动 DSH（ACP 子进程），或先检查设置。';
			actions.append(
				actionButton('启动运行时', '启动 DSH 运行时', () => post({ type: 'restartRuntime' })),
				actionButton('打开设置', '打开 DSH Review 设置', () => post({ type: 'openSettings' })),
				actionButton('运行诊断', '生成兼容性诊断报告', () =>
					post({ type: 'runCommand', command: 'diagnose' }),
				),
			);
			break;
		}
	}

	empty.append(title, body);
	if (actions.childElementCount > 0) empty.append(actions);
}

const SEVERITY_LABELS: Record<Finding['severity'], string> = {
	error: '错误',
	warning: '警告',
	info: '提示',
};

function renderFindings(): void {
	const findings = state.ui.findings;
	refs.findingsSection.hidden = findings.length === 0;
	refs.findingsCount.textContent = findings.length > 0 ? `（${findings.length}）` : '';
	refs.findingsList.replaceChildren();
	for (const finding of findings) {
		const item = el('button', 'finding');
		item.type = 'button';
		item.title = finding.detail ? `${finding.title}\n${finding.detail}` : finding.title;
		const icon = el('span', `finding-icon finding-${finding.severity}`, SEVERITY_LABELS[finding.severity] ?? '');
		const title = el('span', 'finding-title', finding.title);
		const end = finding.endLine && finding.endLine !== finding.line ? `-${finding.endLine}` : '';
		const location = el('span', 'finding-location', `${finding.file}:${finding.line}${end}`);
		item.append(icon, title, location);
		item.addEventListener('click', () => {
			post({ type: 'openFile', path: finding.file, line: finding.line });
		});
		refs.findingsList.append(item);
	}
}

function optionElement(value: ConfigOptionValue, current: string): HTMLOptionElement {
	const option = el('option', undefined, value.name);
	option.value = value.value;
	if (value.value === current) option.selected = true;
	if (value.description) option.title = value.description;
	return option;
}

function renderSelect(
	wrapper: HTMLLabelElement,
	select: HTMLSelectElement,
	option: ConfigOption | undefined,
): void {
	select.replaceChildren();
	if (!option || option.values.length === 0) {
		wrapper.hidden = true;
		delete select.dataset.configId;
		return;
	}
	wrapper.hidden = false;
	wrapper.title = option.name;
	select.dataset.configId = option.id;
	const current = currentConfigValue(option);
	const groups = new Map<string, { label: string; values: ConfigOptionValue[] }>();
	for (const value of option.values) {
		const key = value.group ?? '';
		const group = groups.get(key) ?? { label: value.groupName ?? '', values: [] };
		group.values.push(value);
		groups.set(key, group);
	}
	for (const group of groups.values()) {
		if (group.label) {
			const optgroup = el('optgroup');
			optgroup.label = group.label;
			for (const value of group.values) optgroup.append(optionElement(value, current));
			select.append(optgroup);
		} else {
			for (const value of group.values) select.append(optionElement(value, current));
		}
	}
	select.value = current;
	if (select.selectedIndex < 0 && select.options.length > 0) select.selectedIndex = 0;
}

function renderConfigOptions(): void {
	const options = state.ui.configOptions;
	renderSelect(refs.modelWrap, refs.modelSelect, findConfigOption(options, 'model'));
	renderSelect(refs.reasoningWrap, refs.reasoningSelect, findConfigOption(options, 'reasoning'));
}

function handleConfigChange(select: HTMLSelectElement): void {
	const configId = select.dataset.configId;
	const value = select.value;
	if (!configId || value.length === 0) return;
	// 不直接改 configOptions.currentValue：那是扩展侧对象，等扩展回传 configOptions 再刷新。
	post({ type: 'setConfig', configId, value });
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
		chip.append(el('span', 'context-chip-name', ref.name));
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

function canSend(): boolean {
	return refs.input.value.trim().length > 0 && state.ui.runtime.phase === 'ready';
}

function updateSendButton(): void {
	const busy = state.ui.busy;
	refs.btnSend.textContent = busy ? '停止' : '发送';
	refs.btnSend.classList.toggle('is-stop', busy);
	refs.btnSend.disabled = !busy && !canSend();
	refs.btnSend.title = busy ? '停止当前回复' : '发送（Enter）';
	refs.btnSend.setAttribute('aria-label', refs.btnSend.title);
}

function renderStatus(): void {
	const { runtime, busy, session, usage } = state.ui;
	refs.statusDot.className = `status-dot status-dot-${runtime.phase}${busy ? ' is-busy' : ''}`;
	refs.statusDot.title = runtime.error ?? '';
	refs.statusText.textContent =
		runtime.phase === 'ready'
			? busy
				? '已连接 · 处理中…'
				: '已连接'
			: runtime.phase === 'starting'
				? '正在启动…'
				: runtime.phase === 'error'
					? '连接失败'
					: '未连接';

	const parts: string[] = [];
	if (runtime.dshVersion) parts.push(`DSH ${runtime.dshVersion}`);
	if (runtime.protocolVersion !== undefined) parts.push(`ACP v${runtime.protocolVersion}`);
	if (session) parts.push(shorten(session.title || session.sessionId, 24));
	const usageText = usage ? formatUsage(usage) : '';
	if (usageText) parts.push(usageText);
	refs.statusMeta.textContent = parts.join(' · ');
	refs.statusMeta.hidden = parts.length === 0;

	refs.btnNew.disabled = runtime.phase === 'starting';
	refs.btnRestart.disabled = runtime.phase === 'starting';
	updateSendButton();
}

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
			.slice(0, 3)
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
			const link = button(label, `打开 ${location.path}`);
			link.className = 'link-button';
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
	if (once) {
		refs.permissionActions.append(
			actionButton(once.name || '允许', once.name || '允许本次操作', () => respond(once.optionId), 'primary-button'),
		);
	}
	if (always && always !== once) {
		refs.permissionActions.append(
			actionButton(always.name || '始终允许', always.name || '本次会话始终允许', () =>
				respond(always.optionId),
			),
		);
	}
	// 拒绝/取消按协议回传缺省 optionId（扩展侧映射为 cancelled）。
	refs.permissionActions.append(actionButton('拒绝', '拒绝本次操作', () => respond(undefined), 'danger-button'));
	if (allowOptions.length === 0) {
		for (const option of rejectOptions) {
			refs.permissionActions.append(
				actionButton(option.name, option.name, () => respond(option.optionId)),
			);
		}
	}

	if (!refs.permission.hidden) refs.permission.scrollIntoView({ block: 'nearest' });
}

function formatHistoryDate(value: string | undefined): string {
	if (!value) return '';
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	return date.toLocaleString('zh-CN', { hour12: false });
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
		const item = button(info.title || info.sessionId, `恢复会话 ${info.sessionId}`, 'history-item');
		const updated = formatHistoryDate(info.updatedAt);
		const meta = el('span', 'history-meta', updated ? `${updated} · ${info.cwd}` : info.cwd);
		item.append(meta);
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
	};
}

function renderAll(): void {
	const stick = isNearBottom();
	rebuildTranscript();
	renderStatus();
	renderFindings();
	renderConfigOptions();
	renderContextChips();
	renderEmptyState();
	renderPermission();
	renderHistoryPanel();
	updateSendButton();
	if (stick) scrollToBottom();
}

function applyState(next: UiState): void {
	const previousSessionId = state.ui.session?.sessionId;
	state.ui = normalizeUiState(next);
	if (previousSessionId !== state.ui.session?.sessionId) {
		// 切换会话后旧的权限请求已失效。
		state.permissionQueue = [];
	}
	renderAll();
}

function applyAppend(entries: TranscriptEntry[] | undefined): void {
	if (!Array.isArray(entries) || entries.length === 0) return;
	for (const entry of entries) {
		if (!isTranscriptEntry(entry)) continue;
		const index = state.ui.transcript.findIndex((item) => item.id === entry.id);
		if (index >= 0) state.ui.transcript[index] = entry;
		else state.ui.transcript.push(entry);
		upsertEntry(entry);
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
			return;
		case 'usage':
			state.ui.usage = message.usage;
			renderStatus();
			return;
		case 'history':
			state.ui.history = Array.isArray(message.history) ? message.history : [];
			renderHistoryPanel();
			return;
		case 'configOptions':
			state.ui.configOptions = Array.isArray(message.configOptions) ? message.configOptions : [];
			renderConfigOptions();
			return;
		case 'contextRefs':
			state.draftRefs = normalizeRefs(message.refs);
			renderContextChips();
			updateSendButton();
			refs.input.focus();
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

function sendDraft(): void {
	if (state.ui.busy) return;
	const text = refs.input.value.trim();
	if (text.length === 0) {
		refs.input.focus();
		return;
	}
	const refsPayload = state.draftRefs.length > 0 ? [...state.draftRefs] : undefined;
	post({ type: 'send', text, refs: refsPayload });
	refs.input.value = '';
	state.draftRefs = [];
	renderContextChips();
	autoSizeInput();
}

function wireUi(): void {
	refs.btnNew.addEventListener('click', () => post({ type: 'newSession' }));
	refs.btnHistory.addEventListener('click', () => toggleHistoryPanel());
	refs.btnRestart.addEventListener('click', () => post({ type: 'restartRuntime' }));
	refs.btnSettings.addEventListener('click', () => post({ type: 'openSettings' }));
	refs.btnPickContext.addEventListener('click', () => post({ type: 'pickContext' }));
	refs.btnFindingsFix.addEventListener('click', () => post({ type: 'runCommand', command: 'fixFindings' }));
	refs.btnFindingsClear.addEventListener('click', () => post({ type: 'clearFindings' }));
	refs.btnSend.addEventListener('click', () => {
		if (state.ui.busy) post({ type: 'cancel' });
		else sendDraft();
	});
	refs.bannerClose.addEventListener('click', hideBanner);

	refs.input.addEventListener('keydown', (event: KeyboardEvent) => {
		if (event.key !== 'Enter' || event.shiftKey) return;
		// 输入法组词时的 Enter 不能当成发送。
		if (event.isComposing || event.keyCode === 229) return;
		event.preventDefault();
		if (state.ui.busy) {
			showToast('info', '正在处理中，可点击「停止」中断。');
			return;
		}
		sendDraft();
	});
	refs.input.addEventListener('input', autoSizeInput);

	refs.modelSelect.addEventListener('change', () => handleConfigChange(refs.modelSelect));
	refs.reasoningSelect.addEventListener('change', () => handleConfigChange(refs.reasoningSelect));

	// 点击面板外/按 Esc 关闭历史下拉。
	document.addEventListener('click', (event: MouseEvent) => {
		if (refs.historyPanel.hidden) return;
		const target = event.target as Node | null;
		if (!target) return;
		if (refs.historyPanel.contains(target) || refs.btnHistory.contains(target)) return;
		hideHistoryPanel();
	});
	window.addEventListener('keydown', (event: KeyboardEvent) => {
		if (event.key !== 'Escape') return;
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
