import { describe, expect, it } from 'vitest';
import type { Finding } from '../src/types';
import {
	filterFindings,
	findingFilterLabel,
	formatRelativeTime,
	formatTimestamp,
	formatToolDuration,
	formatUsageText,
	headerTitle,
	severityCounts,
	toolKindIcon,
	toolStatusGlyph,
	toolStatusLabel,
	truncateTitle,
} from '../src/webview/format';

function finding(severity: Finding['severity'], title = '问题'): Finding {
	return { file: 'src/a.ts', line: 3, severity, title };
}

describe('formatTimestamp', () => {
	it('当天只显示时分', () => {
		const now = new Date(2026, 2, 5, 14, 30, 0).getTime();
		expect(formatTimestamp(new Date(2026, 2, 5, 9, 5, 0).getTime(), now)).toBe('09:05');
	});

	it('跨天显示日期与时分', () => {
		const now = new Date(2026, 2, 5, 14, 30, 0).getTime();
		expect(formatTimestamp(new Date(2026, 2, 3, 23, 59, 0).getTime(), now)).toBe('3/3 23:59');
	});

	it('非法时间返回空串', () => {
		expect(formatTimestamp(Number.NaN)).toBe('');
	});
});

describe('formatRelativeTime', () => {
	const now = new Date(2026, 2, 5, 14, 30, 0).getTime();

	it('一分钟内显示「刚刚」', () => {
		expect(formatRelativeTime(now - 30_000, now)).toBe('刚刚');
	});

	it('分钟 / 小时级', () => {
		expect(formatRelativeTime(now - 5 * 60_000, now)).toBe('5 分钟前');
		expect(formatRelativeTime(now - 3 * 3_600_000, now)).toBe('3 小时前');
	});

	it('昨天显示「昨天 HH:MM」', () => {
		expect(formatRelativeTime(new Date(2026, 2, 4, 10, 0, 0).getTime(), now)).toBe('昨天 10:00');
	});

	it('一周内显示「N 天前」，更早显示日期', () => {
		expect(formatRelativeTime(now - 4 * 86_400_000 - 3_600_000, now)).toBe('4 天前');
		expect(formatRelativeTime(new Date(2026, 1, 20, 9, 0, 0).getTime(), now)).toBe('2/20');
	});

	it('跨年显示带年份日期', () => {
		const january = new Date(2026, 0, 2, 9, 0, 0).getTime();
		expect(formatRelativeTime(new Date(2025, 11, 20, 9, 0, 0).getTime(), january)).toBe('2025/12/20');
	});

	it('缺失或非法值返回空串', () => {
		expect(formatRelativeTime(undefined, now)).toBe('');
		expect(formatRelativeTime('not-a-date', now)).toBe('');
	});
});

describe('truncateTitle', () => {
	it('压缩空白并截断加省略号', () => {
		expect(truncateTitle('  修复   bug  ', 20)).toBe('修复 bug');
		expect(truncateTitle('abcdefghij', 6)).toBe('abcde…');
		expect(truncateTitle(undefined)).toBe('');
	});
});

describe('headerTitle', () => {
	it('优先本地会话标题', () => {
		expect(headerTitle('重构  设置面板', 'ready', false)).toBe('重构 设置面板');
	});

	it('无标题时按状态回退', () => {
		expect(headerTitle(undefined, 'ready', false)).toBe('新会话');
		expect(headerTitle(undefined, 'starting', false)).toBe('正在启动…');
		expect(headerTitle(undefined, 'error', false)).toBe('连接失败');
		expect(headerTitle(undefined, 'stopped', false)).toBe('未连接');
		expect(headerTitle(undefined, 'ready', true)).toBe('处理中…');
	});

	it('超长标题截断', () => {
		const title = headerTitle('x'.repeat(60), 'ready', false);
		expect(title.length).toBe(40);
		expect(title.endsWith('…')).toBe(true);
	});
});

describe('findings 计数与筛选', () => {
	const findings = [finding('error'), finding('warning'), finding('warning'), finding('info')];

	it('按严重级别计数', () => {
		expect(severityCounts(findings)).toEqual({ error: 1, warning: 2, info: 1, total: 4 });
		expect(severityCounts([])).toEqual({ error: 0, warning: 0, info: 0, total: 0 });
	});

	it('按级别筛选并保持顺序', () => {
		expect(filterFindings(findings, 'all')).toHaveLength(4);
		expect(filterFindings(findings, 'warning').map((item) => item.severity)).toEqual([
			'warning',
			'warning',
		]);
		expect(filterFindings(findings, 'error')).toHaveLength(1);
		expect(filterFindings(findings, 'all')).not.toBe(findings);
	});

	it('筛选 label 带计数', () => {
		expect(findingFilterLabel('all', 4)).toBe('全部 4');
		expect(findingFilterLabel('error', 1)).toBe('错误 1');
		expect(findingFilterLabel('warning', 2)).toBe('警告 2');
		expect(findingFilterLabel('info', 0)).toBe('提示 0');
	});
});

describe('工具状态与耗时', () => {
	it('状态文案与图标', () => {
		expect(toolStatusLabel('pending')).toBe('等待');
		expect(toolStatusLabel('in_progress')).toBe('执行中');
		expect(toolStatusLabel('completed')).toBe('完成');
		expect(toolStatusLabel('failed')).toBe('失败');
		expect(toolStatusGlyph('completed')).toBe('✓');
		expect(toolStatusGlyph('failed')).toBe('✕');
		expect(toolStatusGlyph('in_progress')).toBe('◐');
		expect(toolStatusGlyph('pending')).toBe('○');
	});

	it('工具类型图标', () => {
		expect(toolKindIcon('read_file')).toBe('▤');
		expect(toolKindIcon('apply_patch')).toBe('✎');
		expect(toolKindIcon('bash')).toBe('$');
		expect(toolKindIcon('grep')).toBe('⌕');
		expect(toolKindIcon(undefined)).toBe('⚙');
	});

	it('耗时格式化', () => {
		expect(formatToolDuration(0)).toBe('0.0 秒');
		expect(formatToolDuration(800)).toBe('0.8 秒');
		expect(formatToolDuration(1200)).toBe('1.2 秒');
		expect(formatToolDuration(15_000)).toBe('15 秒');
		expect(formatToolDuration(65_000)).toBe('1 分 05 秒');
		expect(formatToolDuration(Number.NaN)).toBe('0.0 秒');
	});
});

describe('formatUsageText', () => {
	it('token 摘要压缩大数', () => {
		expect(
			formatUsageText({ inputTokens: 1200, outputTokens: 340, totalTokens: 1540 }),
		).toBe('tokens ↑1.2k ↓340 共 1.5k');
		expect(formatUsageText({ inputTokens: 12 })).toBe('tokens ↑12');
		expect(formatUsageText(undefined)).toBe('');
	});
});
