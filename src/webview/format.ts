/**
 * UI 纯逻辑：时间/相对时间格式化、标题截断、findings 计数与筛选、工具状态文案。
 *
 * 这里不碰 DOM、也不 import vscode，方便 `test/ui-polish.test.ts` 直接覆盖；
 * `main.ts` 只负责把结果渲染成节点。
 */
import type { Finding, RuntimePhase, ToolStatus, UsageInfo } from '../types';

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
