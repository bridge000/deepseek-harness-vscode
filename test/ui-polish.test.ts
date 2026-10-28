import { describe, expect, it } from 'vitest';
import type { ConfigOption, Finding, PermissionMode, TranscriptEntry } from '../src/types';
import {
	composerHintText,
	contextUsagePercent,
	contextUsageText,
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
	reasoningShortLabel,
	severityCounts,
	shouldShowLaunch,
	stripFindingsBlock,
	toolKindIcon,
	toolStatusGlyph,
	toolStatusLabel,
	truncateTitle,
	usageBadgeText,
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

describe('stripFindingsBlock', () => {
	const findingsPayload = '{"findings":[{"file":"src/a.ts","line":3,"severity":"error","title":"空指针"}]}';

	it('剥离末尾闭合的 findings 块并返回条数', () => {
		const source = `已完成审查。\n\n\`\`\`json\n${findingsPayload}\n\`\`\`\n`;
		const result = stripFindingsBlock(source);
		expect(result.stripped).toBe(true);
		expect(result.findings).toBe(1);
		expect(result.text).toBe('已完成审查。');
	});

	it('块在正文中间时保留前后文本', () => {
		const source = `前文\n\n\`\`\`json\n${findingsPayload}\n\`\`\`\n\n后文`;
		const result = stripFindingsBlock(source);
		expect(result.stripped).toBe(true);
		expect(result.findings).toBe(1);
		expect(result.text).toBe('前文\n\n后文');
	});

	it('无关 JSON 块与正文原样保留', () => {
		const source = '示例配置：\n\n```json\n{"foo":1}\n```\n';
		expect(stripFindingsBlock(source)).toEqual({ text: source, stripped: false });
	});

	it('findings 不是数组时不变', () => {
		const source = '```json\n{"findings":{}}\n```';
		expect(stripFindingsBlock(source)).toEqual({ text: source, stripped: false });
	});

	it('流式未闭合的 findings 围栏整段丢弃', () => {
		const source = '正在分析…\n\n```json\n{"findings":[{"file":"src/a.ts",';
		const result = stripFindingsBlock(source);
		expect(result.stripped).toBe(true);
		expect(result.findings).toBeUndefined();
		expect(result.text).toBe('正在分析…');
	});

	it('普通代码块与纯正文不动', () => {
		const code = '看这段：\n\n```ts\nconst a = 1;\n```\n';
		expect(stripFindingsBlock(code)).toEqual({ text: code, stripped: false });
		const plain = '只是普通回答，没有 JSON。';
		expect(stripFindingsBlock(plain)).toEqual({ text: plain, stripped: false });
	});
});

describe('modeLabel', () => {
	it('三种协作模式的中文短文案', () => {
		expect(modeLabel('agent')).toBe('自动');
		expect(modeLabel('plan')).toBe('计划');
		expect(modeLabel('goal')).toBe('目标');
	});
});

describe('reasoningShortLabel', () => {
	it('已知档位用固定短文案', () => {
		expect(reasoningShortLabel('off')).toBe('关');
		expect(reasoningShortLabel('low')).toBe('低');
		expect(reasoningShortLabel('high')).toBe('高');
		expect(reasoningShortLabel('max')).toBe('最高');
	});

	it('未知档位回退 display name，无 name 时回退原始值', () => {
		expect(reasoningShortLabel('medium', '中')).toBe('中');
		expect(reasoningShortLabel('custom')).toBe('custom');
		expect(reasoningShortLabel('medium', '  ')).toBe('medium');
	});
});

describe('composerHintText', () => {
	it('默认没有任何状态提醒（hint 行隐藏）', () => {
		expect(
			composerHintText({ mode: 'agent', autoReview: false, permissionMode: 'workspace-write' }),
		).toBe('');
	});

	it('计划模式 / 只读 / 完全权限各自成为状态提醒', () => {
		expect(
			composerHintText({ mode: 'plan', autoReview: false, permissionMode: 'workspace-write' }),
		).toBe('计划模式：只读分析，不修改文件');
		expect(composerHintText({ mode: 'agent', autoReview: false, permissionMode: 'read-only' })).toBe(
			'只读权限：写操作与命令需要批准',
		);
		expect(
			composerHintText({ mode: 'agent', autoReview: false, permissionMode: 'danger-full-access' }),
		).toBe('完全权限已开启');
	});

	it('自动审查作为尾注，计划模式下不再出现', () => {
		expect(
			composerHintText({ mode: 'agent', autoReview: true, permissionMode: 'workspace-write' }),
		).toBe('每轮结束自动审查');
		// 计划模式不跑自动审查，提示里不能再宣称「每轮结束自动审查」。
		expect(
			composerHintText({ mode: 'plan', autoReview: true, permissionMode: 'danger-full-access' }),
		).toBe('计划模式：只读分析，不修改文件 · 完全权限已开启');
	});

	it('多个提醒按固定顺序用 · 连接', () => {
		expect(composerHintText({ mode: 'agent', autoReview: true, permissionMode: 'read-only' })).toBe(
			'只读权限：写操作与命令需要批准 · 每轮结束自动审查',
		);
	});
});

describe('权限文案', () => {
	it('permissionLabel 三档预设的中文名', () => {
		expect(permissionLabel('workspace-write')).toBe('工作区内');
		expect(permissionLabel('read-only')).toBe('只读');
		expect(permissionLabel('danger-full-access')).toBe('完全权限');
	});

	it('permissionHint 直接返回英文标识（也是 setPermissionMode 的取值）', () => {
		const modes: PermissionMode[] = ['workspace-write', 'read-only', 'danger-full-access'];
		for (const mode of modes) expect(permissionHint(mode)).toBe(mode);
	});

	it('permissionDescription 给出中文说明', () => {
		expect(permissionDescription('workspace-write')).toContain('允许修改工作区文件');
		expect(permissionDescription('read-only')).toContain('写文件与执行命令都需要批准');
		expect(permissionDescription('danger-full-access')).toContain('跳过审批');
		expect(permissionDescription('danger-full-access')).toContain('沙箱不再限制');
	});
});

describe('modeMenuItems', () => {
	it('三个模式项：自动 / 计划 / 目标，当前项勾选', () => {
		const items = modeMenuItems('agent');
		expect(items.map((item) => item.id)).toEqual(['agent', 'plan', 'goal']);
		expect(items.map((item) => item.label)).toEqual(['自动', '计划', '目标']);
		expect(items.map((item) => item.hint)).toEqual(['auto', 'plan', 'goal']);
		expect(items.map((item) => item.checked)).toEqual([true, false, false]);
		expect(items.every((item) => item.disabled !== true)).toBe(true);
		expect(items[1]?.description).toContain('只读分析');
	});

	it('勾选跟随当前模式', () => {
		expect(modeMenuItems('plan').map((item) => item.checked)).toEqual([false, true, false]);
		expect(modeMenuItems('goal').map((item) => item.checked)).toEqual([false, false, true]);
	});
});

describe('permissionMenuItems', () => {
	it('三个预设 + 自动审查行，当前预设勾选、完全权限标 danger', () => {
		const items = permissionMenuItems('workspace-write', { planMode: false, autoReview: false });
		expect(items.map((item) => item.id)).toEqual([
			'workspace-write',
			'read-only',
			'danger-full-access',
			'auto-review',
		]);
		expect(items.map((item) => item.label)).toEqual(['工作区内', '只读', '完全权限', '自动审查本轮改动']);
		expect(items.map((item) => item.checked)).toEqual([true, false, false, false]);
		expect(items.map((item) => item.danger === true)).toEqual([false, false, true, false]);
		expect(items[3]).toMatchObject({
			hint: 'auto review',
			disabled: false,
			description: '每轮结束后审查本轮改动',
		});
	});

	it('勾选跟随当前权限；autoReview 透传到自动审查行', () => {
		const items = permissionMenuItems('read-only', { planMode: false, autoReview: true });
		expect(items.map((item) => item.checked)).toEqual([false, true, false, true]);
	});

	it('计划模式下自动审查行禁用并说明原因', () => {
		const items = permissionMenuItems('danger-full-access', { planMode: true, autoReview: true });
		const autoReview = items[3];
		expect(autoReview?.disabled).toBe(true);
		expect(autoReview?.description).toBe('计划模式下不可用');
		expect(autoReview?.checked).toBe(true);
	});
});

describe('modelMenuGroups', () => {
	const option: ConfigOption = {
		id: 'model',
		name: '模型',
		category: 'model',
		type: 'select',
		currentValue: '["deepseek","deepseek-flash"]',
		values: [
			{
				value: '["deepseek","deepseek-flash"]',
				name: 'DeepSeek-V4.1-Flash',
				description: '默认模型',
				group: 'deepseek',
				groupName: 'DeepSeek',
			},
			{
				value: '["deepseek","deepseek-pro"]',
				name: 'DeepSeek-V4.1-Pro',
				group: 'deepseek',
				groupName: 'DeepSeek',
			},
			{
				value: '["anthropic","claude-sonnet"]',
				name: 'Claude Sonnet',
				group: 'anthropic',
				groupName: 'Anthropic',
			},
		],
	};

	it('按 provider 分组、保持服务端顺序，当前模型勾选', () => {
		const groups = modelMenuGroups(option, '["deepseek","deepseek-flash"]');
		expect(groups.map((group) => group.title)).toEqual(['DeepSeek', 'Anthropic']);
		expect(groups.map((group) => group.items.length)).toEqual([2, 1]);
		expect(groups[0]?.items.map((item) => item.label)).toEqual([
			'DeepSeek-V4.1-Flash',
			'DeepSeek-V4.1-Pro',
		]);
		expect(groups[0]?.items.map((item) => item.checked)).toEqual([true, false]);
		expect(groups[1]?.items[0]).toMatchObject({
			id: '["anthropic","claude-sonnet"]',
			label: 'Claude Sonnet',
			hint: 'claude-sonnet',
			checked: false,
		});
	});

	it('hint 是解析出的 model id，description 透传', () => {
		const groups = modelMenuGroups(option, '');
		expect(groups[0]?.items[0]?.hint).toBe('deepseek-flash');
		expect(groups[0]?.items[0]?.description).toBe('默认模型');
		expect(groups[0]?.items.map((item) => item.checked)).toEqual([false, false]);
	});

	it('option 为空或没有可选值时给出禁用占位', () => {
		for (const groups of [
			modelMenuGroups(undefined, ''),
			modelMenuGroups({ ...option, values: [] }, ''),
		]) {
			expect(groups).toHaveLength(1);
			expect(groups[0]?.title).toBeUndefined();
			expect(groups[0]?.items).toEqual([
				{ id: '__empty', label: '模型列表尚未就绪', disabled: true },
			]);
		}
	});

	it('没有 groupName 的组不显示标题', () => {
		const groups = modelMenuGroups(
			{
				...option,
				values: [{ value: '["solo","m"]', name: 'Solo', group: 'solo' }],
			},
			'["solo","m"]',
		);
		expect(groups[0]?.title).toBeUndefined();
		expect(groups[0]?.items[0]?.checked).toBe(true);
	});
});

describe('reasoningChipLabel', () => {
	it('优先显示服务端档位名（与 DSH Web 的 High 一致），缺失时回退短文案', () => {
		expect(reasoningChipLabel('High', 'high')).toBe('High');
		expect(reasoningChipLabel('Medium', 'medium')).toBe('Medium');
		expect(reasoningChipLabel(undefined, 'off')).toBe('关');
		expect(reasoningChipLabel('   ', 'max')).toBe('最高');
		expect(reasoningChipLabel(undefined, 'custom')).toBe('custom');
	});
});

describe('usageBadgeText', () => {
	it('无 usage 或全 0 时返回空串', () => {
		expect(usageBadgeText(undefined)).toBe('');
		expect(usageBadgeText({})).toBe('');
		expect(usageBadgeText({ inputTokens: 0, outputTokens: 0 })).toBe('');
	});

	it('优先用 totalTokens，缺省时用输入+输出', () => {
		expect(usageBadgeText({ totalTokens: 1017 })).toBe('1017');
		expect(usageBadgeText({ inputTokens: 900, outputTokens: 117 })).toBe('1017');
	});

	it('按 k 压缩大数字', () => {
		expect(usageBadgeText({ totalTokens: 12345 })).toBe('12.3k');
		expect(usageBadgeText({ totalTokens: 120000 })).toBe('120k');
	});
});

describe('shouldShowLaunch', () => {
	function entry(kind: TranscriptEntry['kind']): TranscriptEntry {
		const at = Date.now();
		if (kind === 'notice') return { id: 'n', kind, level: 'info', text: '已新建会话。', at };
		if (kind === 'user') return { id: 'u', kind, text: '你好', at };
		if (kind === 'assistant') return { id: 'a', kind, text: '收到', at };
		if (kind === 'thought') return { id: 't', kind, text: '思考', at };
		return { id: 'tool', kind: 'tool', toolCallId: 'call-1', title: 'read', status: 'completed', at };
	}

	it('空会话显示启动页', () => {
		expect(shouldShowLaunch([])).toBe(true);
	});

	it('只有 notice（如「已新建会话。」）仍算空会话', () => {
		expect(shouldShowLaunch([entry('notice')])).toBe(true);
		expect(shouldShowLaunch([entry('notice'), entry('notice')])).toBe(true);
	});

	it('任意对话类条目都隐藏启动页', () => {
		for (const kind of ['user', 'assistant', 'thought', 'tool'] as const) {
			expect(shouldShowLaunch([entry(kind)]), kind).toBe(false);
			expect(shouldShowLaunch([entry('notice'), entry(kind)]), kind).toBe(false);
		}
	});
});

describe('字号缩放', () => {
	it('档位固定且递增', () => {
		expect(FONT_SCALES).toEqual([0.8, 1, 1.2, 1.4, 1.6, 1.8]);
	});

	it('fontScaleIndex 取最近档位并 clamp', () => {
		expect(fontScaleIndex(1)).toBe(1);
		expect(fontScaleIndex(0.8)).toBe(0);
		expect(fontScaleIndex(1.8)).toBe(5);
		expect(fontScaleIndex(0.1)).toBe(0);
		expect(fontScaleIndex(9)).toBe(5);
		expect(fontScaleIndex(1.19)).toBe(2);
		expect(fontScaleIndex(Number.NaN)).toBe(1);
	});

	it('fontScalePercent 输出百分比', () => {
		expect(fontScalePercent(1)).toBe('100%');
		expect(fontScalePercent(1.2)).toBe('120%');
		expect(fontScalePercent(0.8)).toBe('80%');
	});
});

describe('上下文窗口用量', () => {
	it('used/size 计算百分比（四舍五入）', () => {
		expect(contextUsagePercent({ totalTokens: 1200, contextSize: 16000 })).toBe(8);
		expect(contextUsagePercent({ totalTokens: 64, contextSize: 100 })).toBe(64);
		expect(contextUsagePercent({ totalTokens: 7.5, contextSize: 100 })).toBe(8);
	});

	it('缺 size/非法值返回 undefined', () => {
		expect(contextUsagePercent(undefined)).toBeUndefined();
		expect(contextUsagePercent({ totalTokens: 1200 })).toBeUndefined();
		expect(contextUsagePercent({ totalTokens: 10, contextSize: 0 })).toBeUndefined();
		expect(contextUsagePercent({ contextSize: 100 })).toBeUndefined();
	});

	it('占比超界被 clamp，文本优先用百分比', () => {
		expect(contextUsagePercent({ totalTokens: 5000, contextSize: 100 })).toBe(100);
		expect(contextUsagePercent({ totalTokens: 0, contextSize: 100 })).toBe(0);
		expect(contextUsageText({ totalTokens: 64, contextSize: 100 })).toBe('64%');
		expect(contextUsageText({ totalTokens: 1200 })).toBe('1200');
		expect(contextUsageText(undefined)).toBe('');
	});
});
