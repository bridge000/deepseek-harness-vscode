import { describe, expect, it } from 'vitest';
import {
	DEFAULT_MAX_FINDINGS,
	extractFindingsPayload,
	normalizeSeverity,
	parseFindings,
	resolveFindingPath,
} from '../src/review/findings';

const ROOT = 'C:/ws';

function jsonFence(payload: unknown, language = 'json'): string {
	return ['```' + language, JSON.stringify(payload, null, 2), '```'].join('\n');
}

function finding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		file: 'src/a.ts',
		line: 3,
		severity: 'warning',
		title: '问题标题',
		...overrides,
	};
}

describe('parseFindings: JSON contract extraction', () => {
	it('parses the final json fence into findings', () => {
		const markdown = [
			'审查完成，发现 1 个问题。',
			jsonFence({ findings: [finding({ line: 12, endLine: 14, detail: '原因与修复建议' })] }),
		].join('\n');
		const findings = parseFindings(markdown, { workspaceRoot: ROOT });
		expect(findings).toHaveLength(1);
		expect(findings[0]).toEqual({
			file: 'src/a.ts',
			line: 12,
			endLine: 14,
			severity: 'warning',
			title: '问题标题',
			detail: '原因与修复建议',
		});
	});

	it('accepts an untagged fence', () => {
		const markdown = ['结论', '```', '{"findings":[{"file":"src/a.ts","line":1,"title":"x"}]}', '```'].join('\n');
		expect(parseFindings(markdown, { workspaceRoot: ROOT })).toHaveLength(1);
	});

	it('uses the last parseable fence, ignoring earlier JSON blocks', () => {
		const markdown = [
			jsonFence({ findings: [finding({ title: '旧问题' })] }),
			'中间说明',
			jsonFence({ findings: [finding({ title: '第一个' }), finding({ title: '第二个', line: 9 })] }),
		].join('\n');
		const findings = parseFindings(markdown, { workspaceRoot: ROOT });
		expect(findings.map((item) => item.title)).toEqual(['第一个', '第二个']);
	});

	it('returns [] for a malformed or missing contract', () => {
		expect(parseFindings('', { workspaceRoot: ROOT })).toEqual([]);
		expect(parseFindings('没有 JSON 的普通回答', { workspaceRoot: ROOT })).toEqual([]);
		expect(parseFindings('```json\n{broken\n```', { workspaceRoot: ROOT })).toEqual([]);
		// Parsed JSON but no findings array -> not a findings reply.
		expect(parseFindings('```json\n{"foo":1}\n```', { workspaceRoot: ROOT })).toEqual([]);
	});

	it('falls back to scanning for an inline findings object', () => {
		const markdown = '结论：有一个问题。 {"findings":[{"file":"src/b.ts","line":9,"title":"内联契约"}]} 结束。';
		const findings = parseFindings(markdown, { workspaceRoot: ROOT });
		expect(findings).toHaveLength(1);
		expect(findings[0]).toMatchObject({ file: 'src/b.ts', line: 9, title: '内联契约' });
	});

	it('falls back to an inline object when the last fence is unrelated JSON', () => {
		const markdown = [
			jsonFence({ findings: [finding({ title: '真实发现' })] }),
			'```json',
			'{"example":true}',
			'```',
		].join('\n');
		const findings = parseFindings(markdown, { workspaceRoot: ROOT });
		expect(findings.map((item) => item.title)).toEqual(['真实发现']);
	});

	it('scans balanced braces even when detail contains braces and brackets', () => {
		const markdown = '{"findings":[{"file":"src/a.ts","line":2,"title":"x","detail":"用 } 和 ] 举例"}]}';
		const findings = parseFindings(markdown, { workspaceRoot: ROOT });
		expect(findings).toHaveLength(1);
		expect(findings[0].detail).toBe('用 } 和 ] 举例');
	});

	it('exposes the raw payload for diagnostics and tests', () => {
		const payload = extractFindingsPayload(jsonFence({ findings: [] }));
		expect(payload).toEqual({ findings: [] });
	});
});

describe('parseFindings: field validation', () => {
	it('drops entries without a usable file or title', () => {
		const markdown = jsonFence({
			findings: [
				{ line: 1, title: '没有文件' },
				{ file: 'src/a.ts', line: 1 },
				finding({ title: '保留' }),
				'not-an-object',
				null,
			],
		});
		const findings = parseFindings(markdown, { workspaceRoot: ROOT });
		expect(findings.map((item) => item.title)).toEqual(['保留']);
	});

	it('normalizes severities including Chinese spellings', () => {
		expect(normalizeSeverity('error')).toBe('error');
		expect(normalizeSeverity('Critical')).toBe('error');
		expect(normalizeSeverity('high')).toBe('error');
		expect(normalizeSeverity('严重')).toBe('error');
		expect(normalizeSeverity('warning')).toBe('warning');
		expect(normalizeSeverity('minor')).toBe('warning');
		expect(normalizeSeverity('警告')).toBe('warning');
		expect(normalizeSeverity('suggestion')).toBe('info');
		expect(normalizeSeverity('low')).toBe('info');
		expect(normalizeSeverity('提示')).toBe('info');
		expect(normalizeSeverity(undefined)).toBe('warning');
		expect(normalizeSeverity('whatever')).toBe('warning');
	});

	it('coerces numeric strings and defaults a missing line to 1', () => {
		const markdown = jsonFence({
			findings: [finding({ line: '7' }), finding({ line: undefined, title: '无行号' })],
		});
		const findings = parseFindings(markdown, { workspaceRoot: ROOT });
		expect(findings.map((item) => item.line)).toEqual([7, 1]);
	});

	it('clamps line numbers to the document line count', () => {
		const lineCount = (): number => 20;
		const markdown = jsonFence({
			findings: [
				finding({ line: 500, endLine: 600 }),
				finding({ line: 3, endLine: 999 }),
				finding({ line: 10, endLine: 5 }),
			],
		});
		const findings = parseFindings(markdown, { workspaceRoot: ROOT, lineCount });
		expect(findings[0]).toMatchObject({ line: 20, endLine: 20 });
		expect(findings[1]).toMatchObject({ line: 3, endLine: 20 });
		expect(findings[2]).toMatchObject({ line: 10, endLine: 10 });
	});

	it('leaves line numbers untouched when the line count is unknown', () => {
		const markdown = jsonFence({ findings: [finding({ line: 500 })] });
		expect(parseFindings(markdown, { workspaceRoot: ROOT })[0].line).toBe(500);
	});

	it('deduplicates identical findings and enforces the 200 entry cap', () => {
		const duplicate = finding();
		const duplicates = parseFindings(jsonFence({ findings: [duplicate, duplicate] }), { workspaceRoot: ROOT });
		expect(duplicates).toHaveLength(1);

		const many = Array.from({ length: 250 }, (_, index) => finding({ line: index + 1, title: `问题 ${index}` }));
		const findings = parseFindings(jsonFence({ findings: many }), { workspaceRoot: ROOT });
		expect(findings).toHaveLength(DEFAULT_MAX_FINDINGS);
		expect(findings[0].title).toBe('问题 0');
	});

	it('honors a custom maxFindings cap', () => {
		const many = Array.from({ length: 10 }, (_, index) => finding({ line: index + 1, title: `问题 ${index}` }));
		const findings = parseFindings(jsonFence({ findings: many }), { workspaceRoot: ROOT, maxFindings: 3 });
		expect(findings).toHaveLength(3);
	});
});

describe('findings path resolution', () => {
	it('keeps workspace-relative paths and normalizes Windows separators', () => {
		expect(resolveFindingPath('src\\a.ts', { workspaceRoot: ROOT })).toBe('src/a.ts');
		expect(resolveFindingPath('./src/a.ts', { workspaceRoot: ROOT })).toBe('src/a.ts');
	});

	it('turns absolute paths inside the workspace into relative ones', () => {
		expect(resolveFindingPath('C:\\ws\\src\\a.ts', { workspaceRoot: ROOT })).toBe('src/a.ts');
		expect(resolveFindingPath('c:/ws/src/a.ts', { workspaceRoot: ROOT })).toBe('src/a.ts');
	});

	it('keeps absolute paths outside the workspace', () => {
		expect(resolveFindingPath('D:/other/src/a.ts', { workspaceRoot: ROOT })).toBe('D:/other/src/a.ts');
	});

	it('resolves a bare basename only when it is unique in the workspace', () => {
		const options = { workspaceRoot: ROOT, workspaceFiles: ['src/a.ts', 'test/b.ts'] };
		expect(resolveFindingPath('a.ts', options)).toBe('src/a.ts');
		const ambiguous = { workspaceRoot: ROOT, workspaceFiles: ['src/a.ts', 'test/a.ts'] };
		expect(resolveFindingPath('a.ts', ambiguous)).toBe('a.ts');
	});

	it('does not escape the workspace through ../', () => {
		expect(resolveFindingPath('../../etc/passwd', { workspaceRoot: ROOT })).toBe('passwd');
	});

	it('strips diff prefixes a/ and b/ only when the stripped path is a known file', () => {
		const options = { workspaceRoot: ROOT, workspaceFiles: ['src/a.ts'] };
		expect(resolveFindingPath('b/src/a.ts', options)).toBe('src/a.ts');
		expect(resolveFindingPath('a/src/a.ts', options)).toBe('src/a.ts');
		// Unknown stripped path: keep the model's path instead of guessing.
		expect(resolveFindingPath('b/src/unknown.ts', options)).toBe('b/src/unknown.ts');

		const realFolder = { workspaceRoot: ROOT, workspaceFiles: ['b/real.ts'] };
		expect(resolveFindingPath('b/real.ts', realFolder)).toBe('b/real.ts');
	});
});
