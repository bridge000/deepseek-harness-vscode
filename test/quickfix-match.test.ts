import { describe, expect, it } from 'vitest';
import type { Finding } from '../src/types';
import { findingsForFile, findingRange, normalizeFindingPath } from '../src/review/findingMatch';

const ROOT = 'C:\\ws';
const FILE = 'C:\\ws\\src\\a.ts';
const IS_WINDOWS = process.platform === 'win32';

function finding(overrides: Partial<Finding> = {}): Finding {
	return { file: 'src/a.ts', line: 3, severity: 'warning', title: '问题', ...overrides };
}

describe('normalizeFindingPath', () => {
	it('converts separators, strips ./ and folds duplicate/trailing separators', () => {
		expect(normalizeFindingPath('src\\a.ts')).toBe('src/a.ts');
		expect(normalizeFindingPath('./src/a.ts')).toBe('src/a.ts');
		expect(normalizeFindingPath('./src//a.ts')).toBe('src/a.ts');
		expect(normalizeFindingPath('./src/a.ts/')).toBe('src/a.ts');
		expect(normalizeFindingPath('  ./  ')).toBe('');
	});

	it('normalizes Windows drive and UNC absolute paths without losing the root', () => {
		expect(normalizeFindingPath('C:\\ws\\src\\a.ts')).toBe('C:/ws/src/a.ts');
		expect(normalizeFindingPath('//server/share/a.ts')).toBe('//server/share/a.ts');
		expect(normalizeFindingPath('\\\\server\\share\\a.ts')).toBe('//server/share/a.ts');
	});
});

describe('findingsForFile', () => {
	it('matches workspace-relative and absolute finding paths of the document', () => {
		const relative = finding();
		const absolute = finding({ file: 'C:/ws/src/a.ts', title: '绝对路径' });
		const matched = findingsForFile([relative, absolute], ROOT, FILE);
		expect(matched).toHaveLength(2);
		expect(matched[0]).toBe(relative);
		expect(matched[1]).toBe(absolute);
	});

	it('matches Windows separators and case differences on Windows only', () => {
		const upper = finding({ file: 'SRC/A.TS' });
		if (IS_WINDOWS) {
			expect(findingsForFile([upper], ROOT, FILE)).toHaveLength(1);
			expect(findingsForFile([finding({ file: 'c:/ws/src/a.ts' })], 'C:/WS', FILE)).toHaveLength(1);
		} else {
			expect(findingsForFile([upper], ROOT, FILE)).toEqual([]);
		}
	});

	it('returns [] for other files and for findings escaping the workspace', () => {
		const findings = [
			finding({ file: 'src/b.ts' }),
			finding({ file: '../../etc/passwd' }),
			finding({ file: 'D:/other/src/a.ts' }),
		];
		expect(findingsForFile(findings, ROOT, FILE)).toEqual([]);
	});

	it('returns [] when the workspace root is unknown and the finding is relative', () => {
		expect(findingsForFile([finding()], '', FILE)).toEqual([]);
		expect(findingsForFile([], ROOT, FILE)).toEqual([]);
	});

	it('resolves a relative document path against the workspace root', () => {
		expect(findingsForFile([finding()], ROOT, 'src\\a.ts')).toHaveLength(1);
	});

	it('handles drive-root and POSIX workspace roots', () => {
		expect(findingsForFile([finding({ file: 'src/a.ts' })], 'C:/', 'C:\\src\\a.ts')).toHaveLength(1);
		expect(findingsForFile([finding({ file: 'src/a.ts' })], '/home/ws', '/home/ws/src/a.ts')).toHaveLength(1);
	});

	it('drops duplicate findings for the same line and title', () => {
		const duplicate = finding();
		expect(findingsForFile([duplicate, { ...duplicate }], ROOT, FILE)).toHaveLength(1);
		// Same line/title but a different severity is a distinct finding.
		expect(findingsForFile([duplicate, finding({ severity: 'error' })], ROOT, FILE)).toHaveLength(2);
	});
});

describe('findingRange', () => {
	it('clamps lines into the document and keeps start <= end', () => {
		expect(findingRange(finding({ line: 500, endLine: 600 }), 20)).toEqual({ startLine: 20, endLine: 20 });
		expect(findingRange(finding({ line: 3, endLine: 999 }), 20)).toEqual({ startLine: 3, endLine: 20 });
		expect(findingRange(finding({ line: 10, endLine: 5 }), 20)).toEqual({ startLine: 10, endLine: 10 });
		expect(findingRange(finding({ line: 7 }), 20)).toEqual({ startLine: 7, endLine: 7 });
	});

	it('falls back to line 1 for invalid input', () => {
		expect(findingRange({ line: Number.NaN }, 20)).toEqual({ startLine: 1, endLine: 1 });
		expect(findingRange(finding({ line: -3, endLine: 0 }), 20)).toEqual({ startLine: 1, endLine: 1 });
		expect(findingRange(finding({ line: 9, endLine: 12 }), 0)).toEqual({ startLine: 1, endLine: 1 });
		expect(findingRange(finding({ line: 9 }), Number.NaN)).toEqual({ startLine: 1, endLine: 1 });
	});
});
