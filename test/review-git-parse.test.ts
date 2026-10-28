import { describe, expect, it } from 'vitest';
import {
	createGitClient,
	normalizeRepoPath,
	parseDiffFiles,
	parseLogOneline,
	parseStatusPorcelain,
	truncateAtLine,
	type GitRunner,
	type GitRunnerResult,
} from '../src/review/git';

interface RecordedCall {
	args: string[];
	cwd: string;
}

interface HandlerResult {
	code: number;
	stdout?: string;
	stderr?: string;
}

function fakeRunner(handler: (args: readonly string[], cwd: string) => HandlerResult): {
	runner: GitRunner;
	calls: RecordedCall[];
} {
	const calls: RecordedCall[] = [];
	return {
		calls,
		runner: {
			async run(args, cwd): Promise<GitRunnerResult> {
				calls.push({ args: [...args], cwd });
				const result = handler(args, cwd);
				return { code: result.code, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
			},
		},
	};
}

const STATUS_OUTPUT = [' M src/a.ts', '?? src/new file.ts', 'R  src/b.ts', 'src/old.ts', ' D src/c.ts'].join('\0') + '\0';

describe('parseStatusPorcelain', () => {
	it('parses modified, untracked, renamed and deleted entries', () => {
		const status = parseStatusPorcelain(STATUS_OUTPUT);
		expect(status.get('src/a.ts')?.code).toBe(' M');
		expect(status.get('src/new file.ts')?.code).toBe('??');
		expect(status.get('src/b.ts')).toEqual({ code: 'R ', originalPath: 'src/old.ts' });
		expect(status.get('src/c.ts')?.code).toBe(' D');
	});

	it('handles empty and truncated output', () => {
		expect(parseStatusPorcelain('').size).toBe(0);
		expect(parseStatusPorcelain('\0\0').size).toBe(0);
		// A token shorter than `XY path` is ignored instead of crashing.
		expect(parseStatusPorcelain(' M\0').size).toBe(0);
	});
});

describe('parseLogOneline', () => {
	it('parses the %H%x09%s format and tolerates --oneline output', () => {
		const output = [
			'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\t修复空指针',
			'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb 缺少换行的旧格式',
			'',
		].join('\n');
		expect(parseLogOneline(output)).toEqual([
			{ sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', subject: '修复空指针' },
			{ sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', subject: '缺少换行的旧格式' },
		]);
		expect(parseLogOneline('')).toEqual([]);
	});
});

describe('parseDiffFiles', () => {
	it('extracts unique new-side paths from diff headers', () => {
		const diff = [
			'diff --git a/src/a.ts b/src/a.ts',
			'index 1..2 100644',
			'diff --git a/src/dir/with space.ts b/src/dir/with space.ts',
			'diff --git "a/src/quoted name.ts" "b/src/quoted name.ts"',
			'diff --git a/src/a.ts b/src/a.ts',
		].join('\n');
		expect(parseDiffFiles(diff)).toEqual(['src/a.ts', 'src/dir/with space.ts', 'src/quoted name.ts']);
	});
});

describe('truncateAtLine', () => {
	it('returns short text unchanged', () => {
		expect(truncateAtLine('short', 100)).toEqual({ text: 'short', truncated: false });
	});

	it('cuts at the previous line boundary and appends a Chinese marker', () => {
		const text = ['first line', 'second line', 'third line'].join('\n');
		const result = truncateAtLine(text, 15);
		expect(result.truncated).toBe(true);
		expect(result.text.startsWith('first line')).toBe(true);
		expect(result.text).not.toContain('third line');
		expect(result.text).toContain('已截断');
	});

	it('uses a custom note when provided', () => {
		const result = truncateAtLine('aaaa\nbbbb', 4, '\n[custom]');
		expect(result.text).toBe('aaaa\n[custom]');
		expect(result.truncated).toBe(true);
	});

	it('never truncates with a non-positive budget', () => {
		expect(truncateAtLine('abc', 0)).toEqual({ text: 'abc', truncated: false });
		expect(truncateAtLine('abc', Number.NaN)).toEqual({ text: 'abc', truncated: false });
	});
});

describe('normalizeRepoPath', () => {
	it('normalizes separators and strips ./', () => {
		expect(normalizeRepoPath('src\\dir\\a.ts')).toBe('src/dir/a.ts');
		expect(normalizeRepoPath('./src/a.ts')).toBe('src/a.ts');
	});
});

describe('createGitClient (injected runner)', () => {
	it('isGitRepo returns true only for a clean work-tree check', async () => {
		const yes = fakeRunner(() => ({ code: 0, stdout: 'true\n' }));
		expect(await createGitClient(yes.runner).isGitRepo('C:/ws')).toBe(true);
		expect(yes.calls[0]).toEqual({ args: ['rev-parse', '--is-inside-work-tree'], cwd: 'C:/ws' });

		const no = fakeRunner(() => ({ code: 128, stderr: 'fatal: not a git repository' }));
		expect(await createGitClient(no.runner).isGitRepo('C:/ws')).toBe(false);
		expect(await createGitClient(no.runner).isGitRepo('')).toBe(false);
	});

	it('repoPrefix trims the trailing slash and degrades to empty', async () => {
		const runner = fakeRunner(() => ({ code: 0, stdout: 'packages/app/\n' }));
		expect(await createGitClient(runner.runner).repoPrefix('C:/ws')).toBe('packages/app/');
		const failing = fakeRunner(() => ({ code: 128 }));
		expect(await createGitClient(failing.runner).repoPrefix('C:/ws')).toBe('');
	});

	it('statusPorcelain asks for NUL separated porcelain v1 with all untracked files', async () => {
		const runner = fakeRunner(() => ({ code: 0, stdout: STATUS_OUTPUT }));
		const status = await createGitClient(runner.runner).statusPorcelain('C:/ws');
		expect(status.get('src/a.ts')?.code).toBe(' M');
		expect(runner.calls[0].args).toEqual([
			'status',
			'--porcelain=v1',
			'-z',
			'--untracked-files=all',
		]);
	});

	it('statusPorcelain returns an empty map when git fails', async () => {
		const runner = fakeRunner(() => ({ code: 128, stderr: 'fatal' }));
		expect((await createGitClient(runner.runner).statusPorcelain('C:/ws')).size).toBe(0);
	});

	it('diff selects --cached only for the staged kind', async () => {
		const working = fakeRunner(() => ({ code: 0, stdout: 'diff --git a/src/a.ts b/src/a.ts' }));
		await createGitClient(working.runner).diff('C:/ws', 'working', 10_000);
		expect(working.calls[0].args).not.toContain('--cached');

		const staged = fakeRunner(() => ({ code: 0, stdout: 'diff --git a/src/a.ts b/src/a.ts' }));
		await createGitClient(staged.runner).diff('C:/ws', 'staged', 10_000);
		expect(staged.calls[0].args).toContain('--cached');
	});

	it('diff parses files and truncates oversized output', async () => {
		const body = Array.from({ length: 200 }, (_, index) => `+line ${index}`).join('\n');
		const diff = `diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,200 @@\n${body}`;
		const runner = fakeRunner(() => ({ code: 0, stdout: diff }));
		const result = await createGitClient(runner.runner).diff('C:/ws', 'working', 500);
		expect(result.truncated).toBe(true);
		expect(result.files).toEqual(['src/a.ts']);
		expect(result.text).toContain('已截断');
	});

	it('diff degrades to an empty result when git errors', async () => {
		const runner = fakeRunner(() => ({ code: 128, stderr: 'fatal: bad revision' }));
		const result = await createGitClient(runner.runner).diff('C:/ws', 'working', 1000);
		expect(result).toEqual({ text: '', files: [], truncated: false });
	});

	it('diffPaths scopes the diff to the given pathspecs with a HEAD base', async () => {
		const runner = fakeRunner(() => ({ code: 0, stdout: 'diff --git a/src/a.ts b/src/a.ts' }));
		const result = await createGitClient(runner.runner).diffPaths('C:/ws', ['src/a.ts'], 10_000);
		expect(runner.calls).toHaveLength(1);
		expect(runner.calls[0]).toEqual({
			args: ['diff', '--no-color', '--no-ext-diff', '--unified=3', 'HEAD', '--', 'src/a.ts'],
			cwd: 'C:/ws',
		});
		expect(result.files).toEqual(['src/a.ts']);
		expect(result.truncated).toBe(false);
	});

	it('diffPaths retries without HEAD when the repository has no commit yet', async () => {
		const runner = fakeRunner((args) =>
			args.includes('HEAD')
				? { code: 128, stderr: 'fatal: bad revision HEAD' }
				: { code: 0, stdout: 'diff --git a/src/a.ts b/src/a.ts' },
		);
		const result = await createGitClient(runner.runner).diffPaths('C:/ws', ['src/a.ts'], 10_000);
		expect(runner.calls).toHaveLength(2);
		expect(runner.calls[1].args).not.toContain('HEAD');
		expect(runner.calls[1].args).toEqual([
			'diff',
			'--no-color',
			'--no-ext-diff',
			'--unified=3',
			'--',
			'src/a.ts',
		]);
		expect(result.files).toEqual(['src/a.ts']);
	});

	it('diffPaths drops unsafe paths and never spawns git when none remain', async () => {
		const runner = fakeRunner(() => ({ code: 0, stdout: 'diff --git a/src/a.ts b/src/a.ts' }));
		const client = createGitClient(runner.runner);

		expect(await client.diffPaths('C:/ws', ['-x', '/etc/passwd', 'src/../evil.ts', ''], 1000)).toEqual({
			text: '',
			files: [],
			truncated: false,
		});
		expect(runner.calls).toHaveLength(0);

		// Mixed input keeps only the safe path; `../../x` and absolute paths are dropped.
		await client.diffPaths('C:/ws', ['-x', 'src/a.ts', 'src/../b.ts', '..\\evil.ts', '/abs/c.ts'], 1000);
		expect(runner.calls).toHaveLength(1);
		expect(runner.calls[0].args.slice(-2)).toEqual(['--', 'src/a.ts']);
	});

	it('diffPaths degrades to an empty result when the fallback also fails', async () => {
		const runner = fakeRunner(() => ({ code: 128, stderr: 'fatal' }));
		expect(await createGitClient(runner.runner).diffPaths('C:/ws', ['src/a.ts'], 1000)).toEqual({
			text: '',
			files: [],
			truncated: false,
		});
	});

	it('swallows runner exceptions', async () => {
		const runner: GitRunner = {
			run: async () => {
				throw new Error('spawn git ENOENT');
			},
		};
		const client = createGitClient(runner);
		expect(await client.isGitRepo('C:/ws')).toBe(false);
		expect(await client.diff('C:/ws', 'working', 100)).toEqual({ text: '', files: [], truncated: false });
	});

	it('showCommit validates the sha before spawning git', async () => {
		const invalid = fakeRunner(() => ({ code: 0, stdout: 'should not be called' }));
		const invalidResult = await createGitClient(invalid.runner).showCommit('C:/ws', '--upload-pack=evil', 1000);
		expect(invalid.calls).toHaveLength(0);
		expect(invalidResult).toEqual({ text: '', files: [], truncated: false });

		const valid = fakeRunner(() => ({ code: 0, stdout: 'diff --git a/src/a.ts b/src/a.ts' }));
		const result = await createGitClient(valid.runner).showCommit('C:/ws', 'abcdef1', 1000);
		expect(valid.calls[0].args).toContain('abcdef1');
		expect(result.files).toEqual(['src/a.ts']);
	});

	it('logOneline clamps the requested count', async () => {
		const runner = fakeRunner(() => ({ code: 0, stdout: 'abc1234\t提交说明' }));
		await createGitClient(runner.runner).logOneline('C:/ws', 500);
		expect(runner.calls[0].args.slice(-2)).toEqual(['-n', '200']);

		const low = fakeRunner(() => ({ code: 0, stdout: '' }));
		await createGitClient(low.runner).logOneline('C:/ws', 0);
		expect(low.calls[0].args.slice(-2)).toEqual(['-n', '1']);
	});

	it('showFileAtHead normalizes the path and returns undefined on failure', async () => {
		const runner = fakeRunner(() => ({ code: 0, stdout: 'content at head' }));
		expect(await createGitClient(runner.runner).showFileAtHead('C:/ws', 'src\\a.ts')).toBe('content at head');
		expect(runner.calls[0].args).toEqual(['show', 'HEAD:src/a.ts']);

		const missing = fakeRunner(() => ({ code: 128, stderr: 'fatal: path does not exist' }));
		expect(await createGitClient(missing.runner).showFileAtHead('C:/ws', 'src/new.ts')).toBeUndefined();

		const rejected = fakeRunner(() => ({ code: 0, stdout: 'nope' }));
		expect(await createGitClient(rejected.runner).showFileAtHead('C:/ws', '-p')).toBeUndefined();
		expect(rejected.calls).toHaveLength(0);
	});
});
