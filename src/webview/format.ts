/**
 * UI 纯逻辑：时间/相对时间格式化、标题截断、findings 计数与筛选、工具状态文案，
 * 以及输入区控制台的菜单构建器、权限文案、提示文案与助手正文里的 findings JSON 剥离。
 *
 * 这里不碰 DOM、也不 import vscode，方便 `test/ui-polish.test.ts` 直接覆盖；
 * `main.ts` 只负责把结果渲染成节点。
 */
import type {
	ConfigOption,
	Finding,
	PermissionMode,
	RuntimePhase,
	SessionMode,
	ToolStatus,
	TranscriptEntry,
	UsageInfo,
} from '../types';
import { parseModelValue } from '../model/modelOptions';

export type FindingFilter = 'all' | Finding['severity'];

export interface SeverityCounts {
	error: number;
	warning: number;
	info: number;
	total: number;
}

const pad = (value: number): string => String(value).padStart(2, '0');

/** 消息时间：当天只显示 `14:32`，跨天显示 `3/5 14:32`。 */
export function formatTimestamp(at: number, now: number = Date.now()): string {
	const date = new Date(at);
	if (Number.isNaN(date.getTime())) return '';
	const current = new Date(now);
	const sameDay =
		date.getFullYear() === current.getFullYear() &&
		date.getMonth() === current.getMonth() &&
		date.getDate() === current.getDate();
	const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
	return sameDay ? clock : `${date.getMonth() + 1}/${date.getDate()} ${clock}`;
}

/**
 * 历史会话的相对时间：`刚刚`、`5 分钟前`、`3 小时前`、`昨天 14:32`、
 * `4 天前`；超过一周显示日期（跨年带年份）。无法解析时返回空串。
 */
export function formatRelativeTime(value: string | number | undefined, now: number = Date.now()): string {
	if (value === undefined || value === '') return '';
	const time = typeof value === 'number' ? value : Date.parse(value);
	if (!Number.isFinite(time)) return '';
	const diff = Math.max(0, now - time);
	const minute = 60_000;
	const hour = 3_600_000;
	const day = 86_400_000;
	if (diff < minute) return '刚刚';
	if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
	if (diff < day) return `${Math.floor(diff / hour)} 小时前`;

	const date = new Date(time);
	const current = new Date(now);
	const startOfToday = new Date(current.getFullYear(), current.getMonth(), current.getDate()).getTime();
	if (time < startOfToday && time >= startOfToday - day) {
		return `昨天 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
	}
	if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`;
	if (date.getFullYear() === current.getFullYear()) return `${date.getMonth() + 1}/${date.getDate()}`;
	return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}

/** 头部标题：压缩空白后截断，超长补 `…`。 */
export function truncateTitle(value: string | undefined, max = 36): string {
	const text = (value ?? '').replace(/\s+/g, ' ').trim();
	if (text.length <= max) return text;
	return `${text.slice(0, Math.max(1, max - 1))}…`;
}

/**
 * 头部显示的标题：优先本地会话标题，其次是运行时状态文案。
 * 无标题且未连接时提示「未连接」，避免头部空白。
 */
export function headerTitle(sessionTitle: string | undefined, phase: RuntimePhase, busy: boolean): string {
	const title = truncateTitle(sessionTitle, 40);
	if (title) return title;
	if (busy) return '处理中…';
	switch (phase) {
		case 'ready':
			return '新会话';
		case 'starting':
			return '正在启动…';
		case 'error':
			return '连接失败';
		default:
			return '未连接';
	}
}

export function severityCounts(findings: readonly Finding[]): SeverityCounts {
	const counts: SeverityCounts = { error: 0, warning: 0, info: 0, total: findings.length };
	for (const finding of findings) {
		if (finding.severity === 'error') counts.error += 1;
		else if (finding.severity === 'warning') counts.warning += 1;
		else if (finding.severity === 'info') counts.info += 1;
	}
	return counts;
}

export function filterFindings(findings: readonly Finding[], filter: FindingFilter): Finding[] {
	return filter === 'all' ? [...findings] : findings.filter((finding) => finding.severity === filter);
}

export function findingFilterLabel(filter: FindingFilter, count: number): string {
	const name = filter === 'all' ? '全部' : filter === 'error' ? '错误' : filter === 'warning' ? '警告' : '提示';
	return `${name} ${count}`;
}

const TOOL_STATUS_LABELS: Record<ToolStatus, string> = {
	pending: '等待',
	in_progress: '执行中',
	completed: '完成',
	failed: '失败',
};

export function toolStatusLabel(status: ToolStatus): string {
	return TOOL_STATUS_LABELS[status] ?? status;
}

/** 工具类型图标（纯文本符号，配合 VS Code 主题色）。 */
export function toolKindIcon(toolKind: string | undefined): string {
	const kind = (toolKind ?? '').toLowerCase();
	if (kind.includes('read') || kind.includes('file')) return '▤';
	if (kind.includes('edit') || kind.includes('write') || kind.includes('patch')) return '✎';
	if (kind.includes('execute') || kind.includes('bash') || kind.includes('shell')) return '$';
	if (kind.includes('search') || kind.includes('grep') || kind.includes('find')) return '⌕';
	if (kind.includes('fetch') || kind.includes('web')) return '⇣';
	if (kind.includes('think')) return '✦';
	return '⚙';
}

/** 工具状态圆点字符（配合 CSS 颜色，不依赖图标字体）。 */
export function toolStatusGlyph(status: ToolStatus): string {
	switch (status) {
		case 'completed':
			return '✓';
		case 'failed':
			return '✕';
		case 'in_progress':
			return '◐';
		default:
			return '○';
	}
}

/**
 * 工具耗时：`0.8 秒`、`1.2 秒`、`15 秒`、`1 分 05 秒`。
 * 不足 10 秒保留一位小数，更长时间取整。
 */
export function formatToolDuration(ms: number): string {
	const safe = Number.isFinite(ms) ? Math.max(0, ms) : 0;
	const seconds = safe / 1000;
	if (seconds < 10) return `${seconds.toFixed(1)} 秒`;
	const rounded = Math.round(seconds);
	if (rounded < 60) return `${rounded} 秒`;
	return `${Math.floor(rounded / 60)} 分 ${pad(rounded % 60)} 秒`;
}

function compactNumber(value: number): string {
	if (!Number.isFinite(value)) return '0';
	const abs = Math.abs(value);
	if (abs < 1000) return String(Math.round(value));
	if (abs < 100_000) return `${(value / 1000).toFixed(1)}k`;
	return `${Math.round(value / 1000)}k`;
}

/** token 用量摘要（状态点 tooltip 用）：`tokens ↑1.2k ↓340 共 1.5k`。 */
export function formatUsageText(usage: UsageInfo | undefined): string {
	if (!usage) return '';
	const parts: string[] = [];
	if (typeof usage.inputTokens === 'number') parts.push(`↑${compactNumber(usage.inputTokens)}`);
	if (typeof usage.outputTokens === 'number') parts.push(`↓${compactNumber(usage.outputTokens)}`);
	if (typeof usage.totalTokens === 'number') parts.push(`共 ${compactNumber(usage.totalTokens)}`);
	return parts.length > 0 ? `tokens ${parts.join(' ')}` : '';
}

// ---------------------------------------------------------------------------
// 输入区控制台文案
// ---------------------------------------------------------------------------

/** 模式下拉的短文案：自动 / 计划 / 目标。 */
export function modeLabel(mode: SessionMode): string {
	return mode === 'plan' ? '计划' : mode === 'goal' ? '目标' : '自动';
}

/** 菜单项模型（与 `menu.ts` 的 `MenuItemModel` 同形；这里保持纯逻辑可单测）。 */
export interface MenuItemModel {
	id: string;
	label: string;
	hint?: string;
	description?: string;
	checked?: boolean;
	disabled?: boolean;
	danger?: boolean;
}

const MODE_DESCRIPTIONS: Readonly<Record<SessionMode, string>> = {
	agent: '直接执行，不附加额外约束',
	plan: '只读分析，不修改文件',
	goal: '跨轮次追踪完成目标',
};

const MODE_HINTS: Readonly<Record<SessionMode, string>> = {
	agent: 'auto',
	plan: 'plan',
	goal: 'goal',
};

/** 「+」菜单里的模式分区：自动 / 计划 / 目标，当前模式勾选。 */
export function modeMenuItems(current: SessionMode): MenuItemModel[] {
	return (['agent', 'plan', 'goal'] as const).map((mode) => ({
		id: mode,
		label: modeLabel(mode),
		hint: MODE_HINTS[mode],
		description: MODE_DESCRIPTIONS[mode],
		checked: mode === current,
	}));
}

/** 权限预设的当前值文案：工作区内 / 只读 / 完全权限。 */
export function permissionLabel(mode: PermissionMode): string {
	if (mode === 'read-only') return '只读';
	if (mode === 'danger-full-access') return '完全权限';
	return '工作区内';
}

/** 权限预设的英文标识（面板 hint，也是 `setPermissionMode` 的值）。 */
export function permissionHint(mode: PermissionMode): string {
	return mode;
}

const PERMISSION_DESCRIPTIONS: Readonly<Record<PermissionMode, string>> = {
	'workspace-write': '允许修改工作区文件，越界写入需要批准',
	'read-only': '只读：写文件与执行命令都需要批准',
	'danger-full-access': '跳过审批，DSH 沙箱不再限制在工作区内',
};

/** 权限预设的中文说明。 */
export function permissionDescription(mode: PermissionMode): string {
	return PERMISSION_DESCRIPTIONS[mode];
}

/**
 * 权限菜单：三个预设（工作区内 / 只读 / 完全权限）+ 自动审查行。
 * 完全权限用 danger 色；计划模式只读，自动审查行禁用。
 */
export function permissionMenuItems(
	current: PermissionMode,
	options: { planMode: boolean; autoReview: boolean },
): MenuItemModel[] {
	const presets: readonly PermissionMode[] = ['workspace-write', 'read-only', 'danger-full-access'];
	const items: MenuItemModel[] = presets.map((mode) => ({
		id: mode,
		label: permissionLabel(mode),
		hint: permissionHint(mode),
		description: permissionDescription(mode),
		checked: mode === current,
		danger: mode === 'danger-full-access',
	}));
	items.push({
		id: 'auto-review',
		label: '自动审查本轮改动',
		hint: 'auto review',
		description: options.planMode ? '计划模式下不可用' : '每轮结束后审查本轮改动',
		checked: options.autoReview,
		disabled: options.planMode,
	});
	return items;
}

export interface ModelMenuGroup {
	title?: string;
	items: MenuItemModel[];
}

const EMPTY_MODEL_ITEM: MenuItemModel = { id: '__empty', label: '模型列表尚未就绪', disabled: true };

/**
 * 模型菜单：按 `value.groupName` 分组，组内按服务端顺序排列；
 * 当前值勾选，hint 是解析出的 model id（解析失败则不显示）。
 */
export function modelMenuGroups(
	option: ConfigOption | undefined,
	current: string,
): ModelMenuGroup[] {
	if (!option || option.values.length === 0) return [{ items: [{ ...EMPTY_MODEL_ITEM }] }];

	const groups: ModelMenuGroup[] = [];
	const indexByKey = new Map<string, number>();
	for (const value of option.values) {
		const key = value.group ?? '';
		let index = indexByKey.get(key);
		if (index === undefined) {
			const title = (value.groupName ?? '').trim();
			index = groups.length;
			indexByKey.set(key, index);
			groups.push({ title: title.length > 0 ? title : undefined, items: [] });
		}
		const model = parseModelValue(value.value);
		groups[index]?.items.push({
			id: value.value,
			label: value.name,
			hint: model?.model,
			description: value.description,
			checked: value.value === current,
		});
	}
	return groups;
}

const REASONING_SHORT_LABELS: Readonly<Record<string, string>> = {
	off: '关',
	low: '低',
	high: '高',
	max: '最高',
};

/**
 * 推理强度按钮上的短文案：`off/low/high/max` 用固定单字，其余退回显示名或原始值。
 * 推理档位由 ACP 返回，可能是 `medium` 这类未知值，所以必须保留兜底。
 */
export function reasoningShortLabel(valueId: string, name?: string): string {
	const id = typeof valueId === 'string' ? valueId.trim().toLowerCase() : '';
	const short = REASONING_SHORT_LABELS[id];
	if (short) return short;
	const label = typeof name === 'string' ? name.trim() : '';
	if (label.length > 0) return label;
	return typeof valueId === 'string' ? valueId.trim() : '';
}

export interface ComposerHintInput {
	mode: SessionMode;
	autoReview: boolean;
	permissionMode: PermissionMode;
}

/**
 * 输入框下方的状态提醒：只在「计划模式 / 只读 / 完全权限 / 自动审查」开启时出现，
 * 默认返回空串（调用方据此隐藏整行）。快捷键说明放进 textarea 的 placeholder/title。
 */
export function composerHintText(input: ComposerHintInput): string {
	const parts: string[] = [];
	if (input.mode === 'plan') parts.push('计划模式：只读分析，不修改文件');
	if (input.permissionMode === 'read-only') parts.push('只读权限：写操作与命令需要批准');
	if (input.permissionMode === 'danger-full-access') parts.push('完全权限已开启');
	// Plan mode never runs the auto review, so advertising it there would lie.
	if (input.autoReview && input.mode !== 'plan') parts.push('每轮结束自动审查');
	return parts.join(' · ');
}

/**
 * 推理按钮文案：优先用服务端档位显示名（参考 DSH Web 的 `High`），
 * 缺失时回退到本地短文案（关/低/高/最高）。
 */
export function reasoningChipLabel(name: string | undefined, valueId: string): string {
	const label = typeof name === 'string' ? name.trim() : '';
	if (label.length > 0) return label;
	return reasoningShortLabel(valueId);
}

/** token 徽标：万以下显示原数（如 `1017`），更大按 k 压缩（`1.2k`）；无值返回空串。 */
export function usageBadgeText(usage: UsageInfo | undefined): string {
	if (!usage) return '';
	const sum = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
	const total = typeof usage.totalTokens === 'number' ? usage.totalTokens : sum;
	if (!Number.isFinite(total) || total <= 0) return '';
	if (total < 10_000) return String(Math.round(total));
	return compactNumber(total);
}

// ---------------------------------------------------------------------------
// 字号缩放 / 上下文窗口用量
// ---------------------------------------------------------------------------

/** Selectable sidebar font scales (mirrors the `deepseekHarness.fontScale` range). */
export const FONT_SCALES = [0.8, 1, 1.2, 1.4, 1.6, 1.8] as const;

const DEFAULT_FONT_SCALE = 1;

/** Nearest selectable font-scale index (clamped); invalid input falls back to 100%. */
export function fontScaleIndex(value: number | undefined): number {
	const scale = typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_FONT_SCALE;
	let best = 0;
	for (let index = 1; index < FONT_SCALES.length; index += 1) {
		if (Math.abs(FONT_SCALES[index] - scale) < Math.abs(FONT_SCALES[best] - scale)) best = index;
	}
	return best;
}

/** Current font scale as a percentage label, e.g. `120%`. */
export function fontScalePercent(value: number | undefined): string {
	const scale = typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_FONT_SCALE;
	return `${Math.round(scale * 100)}%`;
}

/** Context-window usage percentage (`used / size`), or `undefined` when unknown. */
export function contextUsagePercent(usage: UsageInfo | undefined): number | undefined {
	if (!usage) return undefined;
	const used = usage.totalTokens;
	const size = usage.contextSize;
	if (typeof used !== 'number' || typeof size !== 'number') return undefined;
	if (!Number.isFinite(used) || !Number.isFinite(size) || size <= 0) return undefined;
	return Math.max(0, Math.min(100, Math.round((used / size) * 100)));
}

/** Compact context-usage label: `64%` when the window size is known, else the token count. */
export function contextUsageText(usage: UsageInfo | undefined): string {
	const percent = contextUsagePercent(usage);
	if (percent !== undefined) return `${percent}%`;
	return usageBadgeText(usage);
}

// ---------------------------------------------------------------------------
// 启动页（空会话）显示判定
// ---------------------------------------------------------------------------

/**
 * Whether the launch screen (whale + wordmark) should be visible.
 *
 * A transcript that only contains `notice` rows is still an empty conversation:
 * "已新建会话。" or a runtime error notice must not hide the launch screen. Any
 * user / assistant / thought / tool entry means the conversation has started.
 */
export function shouldShowLaunch(entries: readonly TranscriptEntry[]): boolean {
	return !entries.some((entry) => entry.kind !== 'notice');
}

// ---------------------------------------------------------------------------
// 助手正文里的 findings JSON 剥离
// ---------------------------------------------------------------------------

export interface StripFindingsBlockResult {
	text: string;
	stripped: boolean;
	/** 被剥离的 findings 数量；流式未闭合块没有可靠的条数。 */
	findings?: number;
}

const CLOSED_FINDINGS_FENCE = /```json[^\n]*\r?\n([\s\S]*?)```/gi;

/** 解析围栏块内容；只有「对象且 findings 是数组」才算审查结果块。 */
function findingsCount(payload: string): number | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(payload);
	} catch {
		return undefined;
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
	const findings = (parsed as { findings?: unknown }).findings;
	if (!Array.isArray(findings)) return undefined;
	return findings.length;
}

/** 移除块后拼回正文：块两侧的空行压实，避免残留一大段空白。 */
function joinAroundBlock(before: string, after: string): string {
	const left = before.replace(/\s+$/, '');
	const right = after.replace(/^\s+/, '');
	if (!left) return right;
	if (!right) return left;
	return `${left}\n\n${right}`;
}

/**
 * 从助手正文里剥离 findings JSON 块（扩展已经把同一条数据解析进「审查结果」面板，
 * 留在正文里只会是一大段用户看不懂的原始 JSON）。
 *
 * - 闭合块：最后一个能解析成 `{ findings: [...] }` 的 ```json 围栏会被移除；
 * - 流式保护：正文末尾还没闭合的 ```json 围栏，只要后面出现过 `"findings"`，
 *   就从围栏开始整段丢弃，避免 JSON 一个字一个字地闪在正文里；
 * - 其它 JSON / 代码块与正文原样保留。
 */
export function stripFindingsBlock(markdown: string): StripFindingsBlockResult {
	const source = typeof markdown === 'string' ? markdown : '';

	let lastBlock: RegExpExecArray | undefined;
	let lastCount: number | undefined;
	for (const match of source.matchAll(CLOSED_FINDINGS_FENCE)) {
		const count = findingsCount(match[1]);
		if (count !== undefined) {
			lastBlock = match;
			lastCount = count;
		}
	}
	if (lastBlock && lastCount !== undefined) {
		const start = lastBlock.index;
		const end = start + lastBlock[0].length;
		return {
			text: joinAroundBlock(source.slice(0, start), source.slice(end)),
			stripped: true,
			findings: lastCount,
		};
	}

	// 流式输出：最后一个 ```json 围栏还没有闭合。
	let openIndex = -1;
	let openEnd = 0;
	for (const match of source.matchAll(/```json[^\n]*/gi)) {
		openIndex = match.index;
		openEnd = match.index + match[0].length;
	}
	if (openIndex >= 0 && source.indexOf('```', openEnd) < 0) {
		const tail = source.slice(openEnd);
		if (tail.includes('"findings"')) {
			return { text: source.slice(0, openIndex).replace(/\s+$/, ''), stripped: true };
		}
	}
	return { text: source, stripped: false };
}
