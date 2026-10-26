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

function resourceLinks(blocks: readonly ContentBlock[]): Array<{ uri: string; name: string }> {
	return blocks
		.filter((block) => block.type === 'resource_link')
		.map((block) => ({ uri: (block as { uri: string }).uri, name: (block as { name: string }).name }));
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
	it('produces a labelled review prompt with resource link, numbered code and the findings contract', () => {
		const input = buildReviewPrompt(fileTarget(), { maxChars: 20_000 });
		expect(input.label).toBe('审查 src/a.ts');

		const links = resourceLinks(input.blocks);
		expect(links).toEqual([{ uri: 'file:///c%3A/ws/src/a.ts', name: 'src/a.ts' }]);

		const text = promptText(input.blocks);
		expect(text).toContain('资深代码审查员');
		expect(text).toContain('提示注入');
		expect(text).toContain('{"findings":[]}');
		expect(text).toContain('```json');
		expect(text).toContain('"severity":"warning"');
		expect(text).toContain('## 待审查文件');
		expect(text).toContain('路径：src/a.ts');
		expect(text).toContain('总行数：2');
		expect(text).toContain('1| const a = 1;');
		expect(text).toContain('2| console.log(a);');
	});

	it('mentions truncation when the caller already cut the file', () => {
		const input = buildReviewPrompt(fileTarget({ truncated: true }), { maxChars: 20_000 });
		expect(promptText(input.blocks)).toContain('文件内容已按长度截断');
	});

	it('does not include a resource link for a diff target without files', () => {
		const input = buildReviewPrompt({ kind: 'diff', diffKind: 'working', text: 'diff', files: [] }, { maxChars: 5000 });
		expect(resourceLinks(input.blocks)).toEqual([]);
	});
});

describe('buildReviewPrompt: selection', () => {
	it('labels the selection and shows real line numbers', () => {
		const input = buildReviewPrompt(selectionTarget({ startLine: 10, selectionStart: 12, selectionEnd: 13 }), {
			maxChars: 20_000,
		});
		expect(input.label).toBe('审查选中代码：src/a.ts:12-13');
		const text = promptText(input.blocks);
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

	it('includes the diff body inside a diff fence and one resource link per file', () => {
		const input = buildReviewPrompt(diffTarget(), { maxChars: 20_000 });
		const text = promptText(input.blocks);
		expect(text).toContain('```diff');
		expect(text).toContain('@@ -1,2 +1,3 @@');
		expect(text).toContain('+const b = 2;');
		expect(resourceLinks(input.blocks).map((link) => link.name)).toEqual(['src/a.ts', 'src/b.ts']);
		expect(text).toContain('涉及文件：src/a.ts、src/b.ts');
	});

	it('reports an already truncated diff', () => {
		const input = buildReviewPrompt(diffTarget({ truncated: true }), { maxChars: 20_000 });
		expect(promptText(input.blocks)).toContain('diff 已按长度截断');
	});
});

describe('buildExplainPrompt', () => {
	it('labels as explanation and asks for explanation instead of fixes', () => {
		const input = buildExplainPrompt(selectionTarget(), { maxChars: 20_000 });
		expect(input.label).toBe('解释选中代码：src/a.ts:2-3');
		const text = promptText(input.blocks);
		expect(text).toContain('解释代码');
		expect(text).toContain('不要修改代码');
		expect(text).toContain('提示注入');
		expect(text).toContain('可选');
	});

	it('labels a whole-file explanation with the path', () => {
		expect(buildExplainPrompt(fileTarget(), { maxChars: 20_000 }).label).toBe('解释 src/a.ts');
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

	it('deduplicates resource links that repeat the same path', () => {
		const input = buildReviewPrompt(diffTarget({ files: [
			{ path: 'src/a.ts', uri: 'file:///c%3A/ws/src/a.ts' },
			{ path: 'src/a.ts', uri: 'file:///c%3A/ws/src/a.ts' },
		] }), { maxChars: 20_000 });
		expect(resourceLinks(input.blocks)).toHaveLength(1);
	});
});
