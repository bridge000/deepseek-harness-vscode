/**
 * 斜杠指令表与解析的纯逻辑用例。
 *
 * `src/webview/slashCommands.ts` 不依赖 DOM / vscode，这里直接覆盖三件事：
 * - 指令表是否覆盖 0.6.0 承诺的全部指令；
 * - `parseSlashCommand` 的精确匹配（发送前拦截本地指令）；
 * - `matchSlashCommands` / `shouldShowSlashPalette` 的面板过滤与弹出时机。
 */
import { describe, expect, it } from 'vitest';
import {
	SLASH_COMMANDS,
	matchSlashCommands,
	parseSlashCommand,
	shouldShowSlashPalette,
} from '../src/webview/slashCommands';

function ids(list: readonly { id: string }[]): string[] {
	return list.map((item) => item.id);
}

describe('SLASH_COMMANDS', () => {
	it('覆盖 0.6.0 的 14 条指令', () => {
		expect(SLASH_COMMANDS).toHaveLength(14);
		expect(ids(SLASH_COMMANDS)).toEqual([
			'plan',
			'plan-off',
			'goal',
			'goal-off',
			'auto',
			'new',
			'history',
			'review',
			'clear',
			'permission',
			'model',
			'diagnose',
			'settings',
			'help',
		]);
	});

	it('id 唯一、usage 以 / 开头、每条都有中文 label 与说明', () => {
		expect(new Set(ids(SLASH_COMMANDS)).size).toBe(SLASH_COMMANDS.length);
		for (const command of SLASH_COMMANDS) {
			expect(command.usage.startsWith('/')).toBe(true);
			expect(command.label.length).toBeGreaterThan(0);
			expect(command.description.length).toBeGreaterThan(0);
		}
	});

	it('包含带参数的用法（/plan off、/goal off）', () => {
		expect(SLASH_COMMANDS.find((command) => command.id === 'plan-off')?.usage).toBe('/plan off');
		expect(SLASH_COMMANDS.find((command) => command.id === 'goal-off')?.usage).toBe('/goal off');
	});
});

describe('parseSlashCommand', () => {
	it('精确命中的指令', () => {
		expect(parseSlashCommand('/plan')?.command.id).toBe('plan');
		expect(parseSlashCommand('/PLAN')?.command.id).toBe('plan');
		expect(parseSlashCommand(' /plan off ')?.command.id).toBe('plan-off');
		expect(parseSlashCommand('/goal off')?.command.id).toBe('goal-off');
		expect(parseSlashCommand('/help')?.command.id).toBe('help');
		expect(parseSlashCommand('/auto')?.command.id).toBe('auto');
	});

	it('大小写与连续空白不敏感', () => {
		expect(parseSlashCommand('/Plan   Off')?.command.id).toBe('plan-off');
		expect(parseSlashCommand('\t/AUTO\n')?.command.id).toBe('auto');
	});

	it('带正文、未知指令、普通文本、空串都不命中', () => {
		expect(parseSlashCommand('/plan 多写正文')).toBeUndefined();
		expect(parseSlashCommand('/unknown')).toBeUndefined();
		expect(parseSlashCommand('hello')).toBeUndefined();
		expect(parseSlashCommand('')).toBeUndefined();
		expect(parseSlashCommand('   ')).toBeUndefined();
	});

	it('返回的 command 是表里的同一对象', () => {
		const parsed = parseSlashCommand('/help');
		expect(parsed?.command).toBe(SLASH_COMMANDS.find((command) => command.id === 'help'));
	});
});

describe('matchSlashCommands', () => {
	it('`/` 返回全部指令', () => {
		expect(ids(matchSlashCommands('/'))).toEqual(ids(SLASH_COMMANDS));
	});

	it('`/pl` 命中 /plan 与 /plan off（前缀匹配主命令）', () => {
		const matched = ids(matchSlashCommands('/pl'));
		expect(matched).toContain('plan');
		expect(matched).toContain('plan-off');
		expect(matched).not.toContain('goal');
	});

	it('`/go` 命中 goal 系列但不含其它指令', () => {
		const matched = ids(matchSlashCommands('/go'));
		expect(matched).toEqual(['goal', 'goal-off']);
	});

	it('大小写不敏感', () => {
		expect(ids(matchSlashCommands('/HELP'))).toEqual(['help']);
	});

	it('含换行、纯文本、空串返回空数组', () => {
		expect(matchSlashCommands('/pl\n')).toEqual([]);
		expect(matchSlashCommands('hello')).toEqual([]);
		expect(matchSlashCommands('')).toEqual([]);
	});

	it('`/` 后面的正文不匹配任何指令', () => {
		expect(matchSlashCommands('/plan 帮我分析')).toEqual([]);
	});
});

describe('shouldShowSlashPalette', () => {
	it('输入单个 / 或不完整 token 时弹出面板', () => {
		expect(shouldShowSlashPalette('/')).toBe(true);
		expect(shouldShowSlashPalette('/pl')).toBe(true);
		expect(shouldShowSlashPalette('/go')).toBe(true);
		expect(shouldShowSlashPalette('/unknown')).toBe(true);
	});

	it('完整指令、带空格正文、空串时不弹出', () => {
		expect(shouldShowSlashPalette('/plan')).toBe(false);
		expect(shouldShowSlashPalette('/plan ')).toBe(false);
		expect(shouldShowSlashPalette('/plan 多写正文')).toBe(false);
		expect(shouldShowSlashPalette('')).toBe(false);
		expect(shouldShowSlashPalette('hello')).toBe(false);
	});

	it('含换行不弹出', () => {
		expect(shouldShowSlashPalette('/pl\n')).toBe(false);
	});
});
