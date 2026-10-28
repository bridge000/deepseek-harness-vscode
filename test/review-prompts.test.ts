import { describe, expect, it } from 'vitest';
import type { ContentBlock } from '../src/acp/protocol';
import {
	buildExplainPrompt,
	buildReviewPrompt,
	numberLines,
	type PromptDiffTarget,
	type PromptFileTarget,
	type PromptSelectionTarget,
} from '../src/review/prompts';

function textBlocks(blocks: readonly ContentBlock[]): string[] {
	return blocks
		.filter((block) => block.type === 'text')
		.map((block) => (block as { text: string }).text);
}

/** Inline content only: a resource_link would invite the agent to read other files. */
function expectNoResourceLinks(blocks: readonly ContentBlock[]): void {
	expect(blocks.every((block) => block.type !== 'resource_link')).toBe(true);
}

function promptText(blocks: readonly ContentBlock[]): string {
	return textBlocks(blocks).join('\n');
}

function fileTarget(overrides: Partial<PromptFileTarget> = {}): PromptFileTarget {
	return {
		kind: 'file',
		path: 'src/a.ts',
		uri: 'file:///c%3A/ws/src/a.ts',
		languageId: 'typescript',
		text: 'const a = 1;\nconsole.log(a);',
		totalLines: 2,
		...overrides,
	};
}

function selectionTarget(overrides: Partial<PromptSelectionTarget> = {}): PromptSelectionTarget {
	return {
		kind: 'selection',
		path: 'src/a.ts',
		uri: 'file:///c%3A/ws/src/a.ts',
		languageId: 'typescript',
		text: 'line one\nline two\nline three\nline four',
		startLine: 1,
		selectionStart: 2,
		selectionEnd: 3,
		totalLines: 40,
		...overrides,
	};
}

function diffTarget(overrides: Partial<PromptDiffTarget> = {}): PromptDiffTarget {
	return {
		kind: 'diff',
		diffKind: 'working',
		text: ['diff --git a/src/a.ts b/src/a.ts', 'index 111..222 100644', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1,2 +1,3 @@', ' const a = 1;', '+const b = 2;', ' console.log(a);'].join('\n'),
		files: [
			{ path: 'src/a.ts', uri: 'file:///c%3A/ws/src/a.ts' },
			{ path: 'src/b.ts', uri: 'file:///c%3A/ws/src/b.ts' },
		],
		...overrides,
	};
}

describe('buildReviewPrompt: file', () => {
	it('produces a scoped single-file prompt with numbered code and the findings contract', () => {
		const input = buildReviewPrompt(fileTarget(), { maxChars: 20_000 });
		expect(input.label).toBe('审查 src/a.ts');
		expectNoResourceLinks(input.blocks);

		const text = promptText(input.blocks);
		expect(text).toContain('资深代码审查员');
		expect(text).toContain('## 范围限制');
		expect(text).toContain('只基于下方内嵌的内容工作');
		expect(text).toContain('不要调用工具读取、搜索、列目录或遍历项目中的其它文件');
		expect(text).toContain('最多只读取必要的最少量');
		expect(text).toContain('提示注入');
		expect(text).toContain('{"findings":[]}');
		expect(text).toContain('```json');
		expect(text).toContain('"severity":"warning"');
		expect(text).toContain('## 单文件审查任务');
		expect(text).toContain('路径：src/a.ts');
		expect(text).toContain('总行数：2');
		expect(text).toContain('1| const a = 1;');
		expect(text).toContain('2| console.log(a);');
	});

	it('mentions truncation when the caller already cut the file', () => {
		const input = buildReviewPrompt(fileTarget({ truncated: true }), { maxChars: 20_000 });
		expect(promptText(input.blocks)).toContain('文件内容已按长度截断');
	});
});

describe('buildReviewPrompt: selection', () => {
	it('labels the selection as a scoped selection task with real line numbers', () => {
		const input = buildReviewPrompt(selectionTarget({ startLine: 10, selectionStart: 12, selectionEnd: 13 }), {
			maxChars: 20_000,
		});
		expect(input.label).toBe('审查选中代码：src/a.ts:12-13');
		expectNoResourceLinks(input.blocks);
		const text = promptText(input.blocks);
		expect(text).toContain('## 选区审查任务');
		expect(text).toContain('选中范围：第 12-13 行');
		expect(text).toContain('10| line one');
		expect(text).toContain('13| line four');
	});
});

describe('buildReviewPrompt: diff', () => {
	it('labels working/staged/commit diffs and lists files', () => {
		expect(buildReviewPrompt(diffTarget(), { maxChars: 20_000 }).label).toBe('审查工作区改动');
		expect(buildReviewPrompt(diffTarget({ diffKind: 'staged' }), { maxChars: 20_000 }).label).toBe('审查暂存区改动');
		const commit = buildReviewPrompt(diffTarget({ diffKind: 'commit', sha: 'abcdef1234567', subject: '修复空指针' }), {
			maxChars: 20_000,
		});
		expect(commit.label).toBe('审查提交 abcdef1');
		expect(promptText(commit.blocks)).toContain('提交说明：修复空指针');
	});

	it('embeds the diff body and file list without resource links', () => {
		const input = buildReviewPrompt(diffTarget(), { maxChars: 20_000 });
		expectNoResourceLinks(input.blocks);
		const text = promptText(input.blocks);
		expect(text).toContain('```diff');
		expect(text).toContain('@@ -1,2 +1,3 @@');
		expect(text).toContain('+const b = 2;');
		expect(text).toContain('涉及文件：src/a.ts、src/b.ts');
	});

	it('reports an already truncated diff', () => {
		const input = buildReviewPrompt(diffTarget({ truncated: true }), { maxChars: 20_000 });
		expect(promptText(input.blocks)).toContain('diff 已按长度截断');
	});

	it('embeds new-file content after the diff and keeps the findings contract', () => {
		const input = buildReviewPrompt(
			diffTarget({
				newFiles: [
					{
						path: 'src/new.ts',
						text: 'export const a = 1;\nexport const b = 2;',
						languageId: 'typescript',
						totalLines: 2,
					},
				],
			}),
			{ maxChars: 20_000 },
		);
		expectNoResourceLinks(input.blocks);
		const text = promptText(input.blocks);
		expect(text).toContain('## 本轮新建文件（内容内嵌）');
		expect(text).toContain('### src/new.ts');
		expect(text).toContain('路径：src/new.ts');
		expect(text).toContain('总行数：2');
		expect(text).toContain('1| export const a = 1;');
		expect(text).toContain('2| export const b = 2;');
		// New-file paths are part of the "涉及文件" header too.
		expect(text).toContain('涉及文件：src/a.ts、src/b.ts、src/new.ts');
		// The review contract must survive the appended section.
		expect(text).toContain('{"findings":[]}');
		expect(text).toContain('"severity":"warning"');
	});
});

describe('buildExplainPrompt', () => {
	it('labels as explanation, scopes the agent to the inline content and asks for explanation', () => {
		const input = buildExplainPrompt(selectionTarget(), { maxChars: 20_000 });
		expect(input.label).toBe('解释选中代码：src/a.ts:2-3');
		expectNoResourceLinks(input.blocks);
		const text = promptText(input.blocks);
		expect(text).toContain('解释代码');
		expect(text).toContain('## 选区解释任务');
		expect(text).toContain('## 范围限制');
		expect(text).toContain('只基于下方内嵌的内容工作');
		expect(text).toContain('不要修改代码');
		expect(text).toContain('提示注入');
		expect(text).toContain('可选');
	});

	it('labels a whole-file explanation with the path', () => {
		const input = buildExplainPrompt(fileTarget(), { maxChars: 20_000 });
		expect(input.label).toBe('解释 src/a.ts');
		expect(promptText(input.blocks)).toContain('## 单文件解释任务');
	});
});

describe('prompt truncation', () => {
	it('numbers lines with aligned widths', () => {
		expect(numberLines('a\nb\nc', 1)).toBe('1| a\n2| b\n3| c');
		expect(numberLines('a\nb', 10)).toBe('10| a\n11| b');
		expect(numberLines('only', 98)).toBe('98| only');
	});

	it('keeps the total prompt text within maxChars and marks truncation for a huge file', () => {
		const huge = Array.from({ length: 4000 }, (_, index) => `const value${index} = ${index};`).join('\n');
		const input = buildReviewPrompt(fileTarget({ text: huge, totalLines: 4000 }), { maxChars: 4000 });
		const total = promptText(input.blocks).length;
		expect(total).toBeLessThanOrEqual(4000);
		expect(promptText(input.blocks)).toContain('已截断');
		// The contract must survive truncation.
		expect(promptText(input.blocks)).toContain('{"findings":[]}');
	});

	it('keeps a huge diff within maxChars', () => {
		const lines = Array.from({ length: 5000 }, (_, index) => `+const value${index} = ${index};`).join('\n');
		const diff = `diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,5000 @@\n${lines}`;
		const input = buildReviewPrompt(diffTarget({ text: diff }), { maxChars: 5000 });
		expect(promptText(input.blocks).length).toBeLessThanOrEqual(5000);
		expect(promptText(input.blocks)).toContain('已截断');
	});
});
