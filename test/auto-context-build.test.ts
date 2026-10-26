import { describe, expect, it } from 'vitest';
import type { ContentBlock } from '../src/acp/protocol';
import {
	buildAutoContextBlocks,
	SELECTION_CONTEXT_LINES,
	type AutoContextInput,
} from '../src/context/autoContextBuild';

const MAX = 2000;

function textOf(blocks: readonly ContentBlock[]): string {
	return blocks
		.filter((block) => block.type === 'text')
		.map((block) => (block as { text: string }).text)
		.join('\n');
}

function numberedText(first: number, last: number): string {
	return Array.from({ length: last - first + 1 }, (_, index) => `line ${first + index}`).join('\n');
}

function fileInput(overrides: Partial<AutoContextInput> = {}): AutoContextInput {
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

/**
 * Selection on real lines 101-102 of a 400-line file; the embedded text is the
 * selection plus `SELECTION_CONTEXT_LINES` lines of context on both sides, so
 * it starts at real line 81.
 */
function selectionInput(overrides: Partial<AutoContextInput> = {}): AutoContextInput {
	const start = 101;
	const end = 102;
	const contextStart = start - SELECTION_CONTEXT_LINES;
	const contextEnd = end + SELECTION_CONTEXT_LINES;
	return {
		kind: 'selection',
		path: 'src/a.ts',
		uri: 'file:///c%3A/ws/src/a.ts',
		languageId: 'typescript',
		text: numberedText(contextStart, contextEnd),
		startLine: start,
		endLine: end,
		totalLines: 400,
		...overrides,
	};
}

function expectNoResourceLinks(blocks: readonly ContentBlock[]): void {
	expect(blocks.every((block) => block.type !== 'resource_link')).toBe(true);
}

function expectWithinMax(text: string, maxChars: number): void {
	expect(text.length).toBeLessThanOrEqual(maxChars);
}

describe('buildAutoContextBlocks: file', () => {
	it('embeds the whole file with real line numbers and no resource link', () => {
		const { info, blocks } = buildAutoContextBlocks(fileInput(), { maxChars: MAX });
		expect(info.kind).toBe('file');
		expect(info.path).toBe('src/a.ts');
		expect(info.uri).toBe('file:///c%3A/ws/src/a.ts');
		expect(info.languageId).toBe('typescript');
		expect(info.note).toBeUndefined();
		expect(info.startLine).toBeUndefined();
		expect(info.endLine).toBeUndefined();
		expect(blocks).toHaveLength(1);
		expect(blocks[0].type).toBe('text');
		expectNoResourceLinks(blocks);

		const text = textOf(blocks);
		expect(info.chars).toBe(text.length);
		expect(text).toContain('自动附带的焦点上下文');
		expect(text).toContain('文件：src/a.ts');
		expect(text).toContain('范围：整个文件（共 2 行）');
		expect(text).toContain('不要读取或遍历项目中的其它文件');
		expect(text).toContain('```typescript');
		expect(text).toContain('1| const a = 1;');
		expect(text).toContain('2| console.log(a);');
		expectWithinMax(text, MAX);
	});

	it('omits the language fence when no language id is known', () => {
		const { info, blocks } = buildAutoContextBlocks(fileInput({ languageId: undefined }), { maxChars: MAX });
		expect(info.languageId).toBeUndefined();
		expect(textOf(blocks)).not.toContain('```typescript');
	});
});

describe('buildAutoContextBlocks: selection', () => {
	it('reports the real selection lines and numbers the context with real lines', () => {
		const { info, blocks } = buildAutoContextBlocks(selectionInput(), { maxChars: MAX });
		expect(info.kind).toBe('selection');
		expect(info.startLine).toBe(101);
		expect(info.endLine).toBe(102);
		expectNoResourceLinks(blocks);

		const text = textOf(blocks);
		expect(info.chars).toBe(text.length);
		expect(text).toContain('选中范围：第 101-102 行（文件共 400 行）');
		expect(text).toContain(`第 ${101 - SELECTION_CONTEXT_LINES}-${102 + SELECTION_CONTEXT_LINES} 行`);
		expect(text).toContain('只分析选中范围内的代码');
		expect(text).toContain('81| line 81');
		expect(text).toContain('101| line 101');
		expect(text).toContain('122| line 122');
		expectWithinMax(text, MAX);
	});

	it('clamps the context start to line 1 for a selection near the top', () => {
		const { info, blocks } = buildAutoContextBlocks(
			selectionInput({ text: numberedText(1, 3), startLine: 2, endLine: 3, totalLines: 400 }),
			{ maxChars: MAX },
		);
		expect(info.startLine).toBe(2);
		expect(info.endLine).toBe(3);
		const text = textOf(blocks);
		expect(text).toContain('1| line 1');
		expect(text).toContain('2| line 2');
		expect(text).not.toContain('\n1| line 0');
	});
});

describe('buildAutoContextBlocks: truncation', () => {
	it('keeps the whole block within maxChars, marks the note and keeps real line numbers', () => {
		const huge = Array.from({ length: 4000 }, (_, index) => `const value${index} = ${index};`).join('\n');
		const { info, blocks } = buildAutoContextBlocks(fileInput({ text: huge, totalLines: 4000 }), { maxChars: MAX });
		const text = textOf(blocks);
		expect(info.note).toContain('已截断');
		expect(info.chars).toBe(text.length);
		expect(text).toContain('已截断');
		expect(text).toContain('1| const value0 = 0;');
		expectWithinMax(text, MAX);
	});

	it('keeps numbering anchored to real lines after truncating a selection', () => {
		const startLine = 1000;
		const huge = numberedText(startLine - SELECTION_CONTEXT_LINES, 3000);
		const { info, blocks } = buildAutoContextBlocks(
			selectionInput({ text: huge, startLine, endLine: startLine + 2, totalLines: 5000 }),
			{ maxChars: MAX },
		);
		const text = textOf(blocks);
		expect(info.note).toContain('已截断');
		expect(text).toContain('980| line 980');
		expect(text).not.toContain('\n1| line 1');
		expectWithinMax(text, MAX);
	});
});

describe('buildAutoContextBlocks: document states', () => {
	it('marks an untitled document without inventing a uri', () => {
		const { info, blocks } = buildAutoContextBlocks(
			fileInput({ path: 'Untitled-1', uri: undefined, untitled: true }),
			{ maxChars: MAX },
		);
		expect(info.uri).toBeUndefined();
		expect(info.path).toBe('Untitled-1');
		expect(info.note).toContain('未保存文件');
		expect(textOf(blocks)).toContain('未保存文件');
	});

	it('marks files outside the workspace', () => {
		const { info } = buildAutoContextBlocks(
			fileInput({ path: 'D:/other/b.ts', uri: 'file:///d%3A/other/b.ts', outsideWorkspace: true }),
			{ maxChars: MAX },
		);
		expect(info.path).toBe('D:/other/b.ts');
		expect(info.note).toContain('工作区外');
	});

	it('joins several notes instead of dropping them', () => {
		const { info } = buildAutoContextBlocks(
			fileInput({ uri: undefined, untitled: true, outsideWorkspace: true }),
			{ maxChars: MAX },
		);
		expect(info.note).toBe('未保存文件；工作区外');
	});

	it('returns none without blocks for an empty document', () => {
		const { info, blocks } = buildAutoContextBlocks(fileInput({ text: '  \n\t\n', totalLines: 3 }), {
			maxChars: MAX,
		});
		expect(info.kind).toBe('none');
		expect(info.note).toContain('空');
		expect(blocks).toEqual([]);
	});
});
