import { describe, expect, it } from 'vitest';
import type { ContentBlock } from '../src/acp/protocol';
import { buildTurnDiffPrompt, partitionTurnPaths, toPathspecs } from '../src/review/turnDiff';
import type { PromptNewFile } from '../src/review/prompts';

function statusOf(entries: ReadonlyArray<readonly [string, string]>): Map<string, { code: string }> {
	return new Map(entries.map(([path, code]) => [path, { code }]));
}

function promptText(blocks: readonly ContentBlock[]): string {
	return blocks
		.filter((block) => block.type === 'text')
		.map((block) => (block as { text: string }).text)
		.join('\n');
}

function newFile(overrides: Partial<PromptNewFile> = {}): PromptNewFile {
	return { path: 'src/new.ts', text: 'export const a = 1;', languageId: 'typescript', totalLines: 1, ...overrides };
}

describe('toPathspecs', () => {
	it('strips the repo prefix, skips paths outside the workspace and de-duplicates', () => {
		expect(
			toPathspecs('packages/app/', [
				'packages/app/src/a.ts',
				'packages/app/src/a.ts',
				'other/b.ts',
				'packages/app/README.md',
			]),
		).toEqual(['src/a.ts', 'README.md']);
	});

	it('keeps repo-relative paths unchanged at the repository root', () => {
		expect(toPathspecs('', ['src\\a.ts', './src/b.ts', 'src/a.ts', '', 'src/c.ts'])).toEqual([
			'src/a.ts',
			'src/b.ts',
			'src/c.ts',
		]);
	});

	it('tolerates a repo prefix without the trailing slash', () => {
		expect(toPathspecs('packages/app', ['packages/app/src/a.ts', 'packages/app2/b.ts'])).toEqual(['src/a.ts']);
	});
});

describe('partitionTurnPaths', () => {
	it('sends untracked (`??`) paths to untracked and everything else to tracked', () => {
		const status = statusOf([
			['packages/app/src/a.ts', ' M'],
			['packages/app/src/staged.ts', 'M '],
			['packages/app/src/new.ts', '??'],
			['packages/app/src/gone.ts', ' D'],
		]);
		const partition = partitionTurnPaths(
			status,
			['packages/app/src/a.ts', 'packages/app/src/staged.ts', 'packages/app/src/new.ts', 'packages/app/src/gone.ts'],
			'packages/app/',
		);
		expect(partition.tracked).toEqual(['packages/app/src/a.ts', 'packages/app/src/staged.ts', 'packages/app/src/gone.ts']);
		expect(partition.untracked).toEqual(['packages/app/src/new.ts']);
		expect(partition.skipped).toEqual([]);
	});

	it('records paths outside the workspace as skipped and de-duplicates', () => {
		const status = statusOf([['packages/app/src/new.ts', '??']]);
		const partition = partitionTurnPaths(
			status,
			['other/outside.ts', 'packages/app/src/new.ts', 'packages/app/src/new.ts'],
			'packages/app/',
		);
		expect(partition.tracked).toEqual([]);
		expect(partition.untracked).toEqual(['packages/app/src/new.ts']);
		expect(partition.skipped).toEqual([{ path: 'other/outside.ts', reason: '工作区外' }]);
	});

	it('treats every path as inside the workspace at the repository root', () => {
		const partition = partitionTurnPaths(statusOf([['src/new.ts', '??']]), ['src/a.ts', 'src/new.ts'], '');
		expect(partition.tracked).toEqual(['src/a.ts']);
		expect(partition.untracked).toEqual(['src/new.ts']);
		expect(partition.skipped).toEqual([]);
	});
});

describe('buildTurnDiffPrompt', () => {
	it('returns undefined when the turn changed nothing', () => {
		expect(buildTurnDiffPrompt({ diffText: '', files: [], newFiles: [], truncated: false, maxChars: 20_000 })).toBeUndefined();
		expect(
			buildTurnDiffPrompt({ diffText: '  \n', files: [], newFiles: [], truncated: false, maxChars: 20_000 }),
		).toBeUndefined();
	});

	it('embeds untracked new files with real line numbers and the findings contract', () => {
		const input = buildTurnDiffPrompt({
			diffText: [
				'diff --git a/src/a.ts b/src/a.ts',
				'--- a/src/a.ts',
				'+++ b/src/a.ts',
				'@@ -1 +1 @@',
				'-const a = 1;',
				'+const a = 2;',
			].join('\n'),
			files: [{ path: 'src/a.ts', uri: 'file:///c%3A/ws/src/a.ts' }],
			newFiles: [
				newFile({ path: 'src/new.ts', text: 'export const a = 1;\nexport const b = 2;', totalLines: 2 }),
				newFile({ path: 'docs/notes.md', text: '# 说明', totalLines: 1 }),
			],
			truncated: false,
			maxChars: 20_000,
		});
		expect(input).toBeDefined();
		if (!input) return;
		const text = promptText(input.blocks);
		expect(text).toContain('## 待审查改动');
		expect(text).toContain('## 本轮新建文件（内容内嵌）');
		expect(text).toContain('### src/new.ts');
		expect(text).toContain('1| export const a = 1;');
		expect(text).toContain('2| export const b = 2;');
		expect(text).toContain('### docs/notes.md');
		expect(text).toContain('1| # 说明');
		expect(text).toContain('涉及文件：src/a.ts、src/new.ts、docs/notes.md');
		// Contract stays at the end of the prompt.
		expect(text).toContain('{"findings":[]}');
		expect(text).toContain('```json');
	});

	it('works when the turn only created files (no tracked diff)', () => {
		const input = buildTurnDiffPrompt({
			diffText: '',
			files: [],
			newFiles: [newFile()],
			truncated: false,
			maxChars: 20_000,
		});
		expect(input).toBeDefined();
		if (!input) return;
		const text = promptText(input.blocks);
		expect(text).toContain('## 本轮新建文件（内容内嵌）');
		expect(text).toContain('1| export const a = 1;');
		expect(text).toContain('{"findings":[]}');
	});

	it('keeps the total prompt within maxChars and preserves the contract for huge new files', () => {
		const huge = Array.from({ length: 4000 }, (_, index) => `export const value${index} = ${index};`).join('\n');
		const input = buildTurnDiffPrompt({
			diffText: '',
			files: [],
			newFiles: [newFile({ path: 'src/huge.ts', text: huge, totalLines: 4000 })],
			truncated: false,
			maxChars: 4000,
		});
		expect(input).toBeDefined();
		if (!input) return;
		const text = promptText(input.blocks);
		expect(text.length).toBeLessThanOrEqual(4000);
		expect(text).toContain('已截断');
		expect(text).toContain('{"findings":[]}');
	});
});
