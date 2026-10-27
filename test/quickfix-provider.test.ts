import { describe, expect, it } from 'vitest';
import type { Finding } from '../src/types';
import {
	buildQuickFixActions,
	FIX_FINDING_COMMAND,
	QUICK_FIX_TITLE_PREFIX,
} from '../src/review/findingMatch';

const ROOT = 'C:\\ws';
const FILE = 'C:\\ws\\src\\a.ts';

function finding(overrides: Partial<Finding> = {}): Finding {
	return { file: 'src/a.ts', line: 3, severity: 'warning', title: '问题', ...overrides };
}

/**
 * `quickFix.ts` is a thin vscode adapter around `buildQuickFixActions`; these
 * tests treat the fake document line count as `document.lineCount` and inspect
 * the plain descriptors the provider wraps into `vscode.CodeAction`s.
 */
describe('buildQuickFixActions: provider core', () => {
	it('creates one Quick Fix per finding of the document', () => {
		const first = finding({ line: 2, title: '缺少错误处理' });
		const second = finding({ line: 8, endLine: 10, severity: 'error', title: '未使用变量' });
		const actions = buildQuickFixActions(FILE, 40, [first, second], ROOT);

		expect(actions).toHaveLength(2);
		expect(actions[0].title).toBe(`${QUICK_FIX_TITLE_PREFIX}缺少错误处理`);
		expect(actions[0].command).toEqual({
			command: FIX_FINDING_COMMAND,
			title: `${QUICK_FIX_TITLE_PREFIX}缺少错误处理`,
			arguments: [first],
		});
		expect(actions[1].title).toBe(`${QUICK_FIX_TITLE_PREFIX}未使用变量`);
	});

	it('passes the original finding as the command argument', () => {
		const target = finding({ detail: '细节', endLine: 5 });
		const actions = buildQuickFixActions(FILE, 40, [target], ROOT);
		expect(actions).toHaveLength(1);
		expect(actions[0].finding).toBe(target);
		expect(actions[0].command.arguments[0]).toBe(target);
	});

	it('computes a 1-based range clamped to the fake document line count', () => {
		const actions = buildQuickFixActions(FILE, 10, [finding({ line: 50, endLine: 60 })], ROOT);
		expect(actions).toHaveLength(1);
		expect(actions[0].startLine).toBe(10);
		expect(actions[0].endLine).toBe(10);
	});

	it('ignores findings of other files and outside the workspace', () => {
		const findings = [
			finding({ file: 'src/b.ts' }),
			finding({ file: '../../etc/passwd' }),
			finding({ file: FILE, title: '保留' }),
		];
		const actions = buildQuickFixActions(FILE, 40, findings, ROOT);
		expect(actions.map((action) => action.finding.title)).toEqual(['保留']);
	});

	it('collapses duplicate findings into a single action', () => {
		const duplicate = finding();
		const actions = buildQuickFixActions(FILE, 40, [duplicate, { ...duplicate }], ROOT);
		expect(actions).toHaveLength(1);
	});

	it('returns [] when there are no findings', () => {
		expect(buildQuickFixActions(FILE, 40, [], ROOT)).toEqual([]);
		expect(buildQuickFixActions(FILE, 40, [finding({ file: 'src/other.ts' })], ROOT)).toEqual([]);
	});

	it('exposes the stable command id and Chinese title prefix', () => {
		expect(FIX_FINDING_COMMAND).toBe('deepseekHarness.fixFinding');
		expect(QUICK_FIX_TITLE_PREFIX).toBe('用 DeepSeek Harness 修复：');
	});
});
