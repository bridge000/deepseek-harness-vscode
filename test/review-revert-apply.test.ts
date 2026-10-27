import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { GitRunner } from '../src/review/git';
import { createGitClient } from '../src/review/git';
import {
	applyRevert,
	captureBeginState,
	collectPreImages,
	planRevert,
	recordPostState,
	type RevertBeginState,
} from '../src/review/revert';

const STASH_SHA = 'd'.repeat(40);

const tempDirs: string[] = [];

afterEach(async () => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) await fs.rm(dir, { recursive: true, force: true });
	}
});

async function makeTempDir(): Promise<string> {
	const dir = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'dsh-revert-apply-'));
	tempDirs.push(dir);
	return dir;
}

async function writeFile(dir: string, relative: string, content: string): Promise<void> {
	const absolute = nodePath.join(dir, ...relative.split('/'));
	await fs.mkdir(nodePath.dirname(absolute), { recursive: true });
	await fs.writeFile(absolute, content, 'utf8');
}

async function readFile(dir: string, relative: string): Promise<string> {
	return fs.readFile(nodePath.join(dir, ...relative.split('/')), 'utf8');
}

async function exists(dir: string, relative: string): Promise<boolean> {
	try {
		await fs.stat(nodePath.join(dir, ...relative.split('/')));
		return true;
	} catch {
		return false;
	}
}

/**
 * Fake git runner for the full chain: answers status/stash/show/cat-file from
 * canned data. `files` maps repo-relative paths to the content visible at the
 * begin stash snapshot (mirrors the real `git show <stash>:<path>`).
 */
function fakeGitRunner(options: {
	status: string;
	stashRevision?: string;
	/** Content at the begin stash revision. */
	stash?: Record<string, string>;
	/** Content at HEAD. */
	head?: Record<string, string>;
}): GitRunner {
	return {
		async run(args) {
			const [command, second] = args;
			if (command === 'status') return { code: 0, stdout: options.status, stderr: '' };
			if (command === 'stash') {
				return { code: 0, stdout: options.stashRevision ? `${options.stashRevision}\n` : '', stderr: '' };
			}
			if (command === 'show' && typeof second === 'string') {
				const separator = second.indexOf(':');
				const revision = second.slice(0, separator);
				const repoPath = second.slice(separator + 1);
				const source = /^[0-9a-f]{40}$/.test(revision) ? options.stash : options.head;
				const content = source?.[repoPath];
				return content === undefined
					? { code: 128, stdout: '', stderr: 'fatal: path does not exist' }
					: { code: 0, stdout: content, stderr: '' };
			}
			if (command === 'cat-file') {
				const spec = second ?? '';
				const repoPath = spec.slice(spec.indexOf(':') + 1);
				return options.head?.[repoPath] === undefined
					? { code: 1, stdout: '', stderr: 'missing' }
					: { code: 0, stdout: '', stderr: '' };
			}
			return { code: 1, stdout: '', stderr: 'unexpected git command' };
		},
	};
}

function porcelain(entries: readonly string[]): string {
	return entries.map((entry) => `${entry}\0`).join('');
}

interface ChainResult {
	plan: ReturnType<typeof planRevert>;
	applied: Awaited<ReturnType<typeof applyRevert>>;
	begin: RevertBeginState;
}

/** capture → record → collect pre-images → plan → apply, the production order. */
async function runChain(options: {
	dir: string;
	runner: GitRunner;
	changed: string[];
	beginStatus: Map<string, { code: string }>;
}): Promise<ChainResult> {
	const begin = await captureBeginState(options.dir, options.runner);
	const recorded = await recordPostState(options.dir, options.changed);
	const preImages = await collectPreImages(
		options.dir,
		{ changed: options.changed, begin, beginStatus: options.beginStatus },
		options.runner,
	);
	const plan = planRevert({ changed: options.changed, preImages, recorded, current: recorded });
	const applied = await applyRevert(options.dir, plan.actions);
	return { plan, applied, begin };
}

describe('revert full chain (fake runner + temp dir)', () => {
	it('restores modified/new files and deletes files created by the turn', async () => {
		const dir = await makeTempDir();
		// Work tree after the turn: a.ts edited, new.ts created.
		await writeFile(dir, 'src/a.ts', 'after');
		await writeFile(dir, 'src/new.ts', 'created by agent');

		const runner = fakeGitRunner({
			// At begin() only a.ts was dirty; new.ts did not exist yet.
			status: porcelain([' M src/a.ts']),
			stashRevision: STASH_SHA,
			stash: { 'src/a.ts': 'before' },
			head: { 'src/a.ts': 'before' },
		});

		const result = await runChain({
			dir,
			runner,
			changed: ['src/a.ts', 'src/new.ts'],
			beginStatus: new Map([['src/a.ts', { code: ' M' }]]),
		});

		expect(result.plan.error).toBeUndefined();
		expect(await readFile(dir, 'src/a.ts')).toBe('before');
		expect(await exists(dir, 'src/new.ts')).toBe(false);
		expect(result.applied.errors).toEqual([]);
		expect(result.applied.reverted).toEqual(['src/a.ts', 'src/new.ts']);
	});

	it('restores a pre-existing untracked file from the begin snapshot', async () => {
		const dir = await makeTempDir();
		// The file existed before the turn and the agent edited it.
		await writeFile(dir, 'docs/notes.md', 'original');
		const runner = fakeGitRunner({ status: porcelain(['?? docs/notes.md']) });
		const begin = await captureBeginState(dir, runner);
		expect(begin.untracked.get('docs/notes.md')?.content).toBe('original');

		await writeFile(dir, 'docs/notes.md', 'edited by agent');
		const recorded = await recordPostState(dir, ['docs/notes.md']);
		const preImages = await collectPreImages(
			dir,
			{ changed: ['docs/notes.md'], begin, beginStatus: new Map([['docs/notes.md', { code: '??' }]]) },
			runner,
		);
		const plan = planRevert({ changed: ['docs/notes.md'], preImages, recorded, current: recorded });
		const applied = await applyRevert(dir, plan.actions);

		expect(plan.skipped).toEqual([]);
		expect(applied.errors).toEqual([]);
		expect(await readFile(dir, 'docs/notes.md')).toBe('original');
	});

	it('refuses the whole turn when a file changed after the turn ended', async () => {
		const dir = await makeTempDir();
		await writeFile(dir, 'src/a.ts', 'agent version');
		await writeFile(dir, 'src/c.ts', 'agent version c');
		const runner = fakeGitRunner({
			status: porcelain([' M src/a.ts']),
			stashRevision: STASH_SHA,
			stash: { 'src/a.ts': 'before', 'src/c.ts': 'before c' },
			head: { 'src/a.ts': 'before', 'src/c.ts': 'before c' },
		});
		const begin = await captureBeginState(dir, runner);
		const recorded = await recordPostState(dir, ['src/a.ts', 'src/c.ts']);
		// User hand-edits a.ts after the turn ended.
		await writeFile(dir, 'src/a.ts', 'user edit after turn');
		const current = await recordPostState(dir, ['src/a.ts', 'src/c.ts']);
		const preImages = await collectPreImages(
			dir,
			{
				changed: ['src/a.ts', 'src/c.ts'],
				begin,
				beginStatus: new Map([
					['src/a.ts', { code: ' M' }],
					['src/c.ts', { code: ' M' }],
				]),
			},
			runner,
		);
		const plan = planRevert({ changed: ['src/a.ts', 'src/c.ts'], preImages, recorded, current });

		expect(plan.error).toContain('已整体拒绝');
		expect(plan.actions).toEqual([]);
		expect(await readFile(dir, 'src/a.ts')).toBe('user edit after turn');
		expect(await readFile(dir, 'src/c.ts')).toBe('agent version c');
	});

	it('validates every path before writing anything', async () => {
		const dir = await makeTempDir();
		await writeFile(dir, 'src/a.ts', 'current');
		const applied = await applyRevert(dir, [
			{ path: 'src/a.ts', kind: 'restore', content: 'restored' },
			{ path: '../escape.txt', kind: 'restore', content: 'evil' },
		]);
		expect(applied.errors).toHaveLength(1);
		expect(applied.errors[0]).toContain('路径超出仓库根目录');
		expect(applied.reverted).toEqual([]);
		// The valid action must not have been applied when another one is invalid.
		expect(await readFile(dir, 'src/a.ts')).toBe('current');
		expect(await exists(nodePath.dirname(dir), 'escape.txt')).toBe(false);
	});
});

const gitAvailable = (() => {
	try {
		execFileSync('git', ['--version'], { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
})();

const describeWithGit = gitAvailable ? describe : describe.skip;

describeWithGit('revert full chain (real git repository)', () => {
	it('reverts a real turn: modified, deleted and created files', async () => {
		const dir = await makeTempDir();
		const git = (args: string[]): void => {
			execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
		};
		git(['init', '-q']);
		git(['config', 'user.name', 'DSH Test']);
		git(['config', 'user.email', 'dsh-test@example.com']);

		await writeFile(dir, 'a.txt', 'v1');
		await writeFile(dir, 'd.txt', 'delete me');
		git(['add', '.']);
		git(['commit', '-q', '-m', 'init']);

		// State before the turn: a.txt modified, c.txt untracked, d.txt untouched.
		await writeFile(dir, 'a.txt', 'v2 pre-turn');
		await writeFile(dir, 'c.txt', 'untracked before turn');
		const client = createGitClient();
		const beginStatus = await client.statusPorcelain(dir);
		const begin = await captureBeginState(dir);
		expect(begin.reason).toBeUndefined();
		expect(begin.stashRevision).toBeDefined();
		expect(begin.untracked.get('c.txt')?.content).toBe('untracked before turn');

		// The "agent turn": edit, delete and create files.
		await writeFile(dir, 'a.txt', 'v3 after turn');
		await writeFile(dir, 'c.txt', 'edited by agent');
		await fs.rm(nodePath.join(dir, 'd.txt'));
		await writeFile(dir, 'b.txt', 'created by agent');

		const changed = ['a.txt', 'b.txt', 'c.txt', 'd.txt'];
		const recorded = await recordPostState(dir, changed);
		const preImages = await collectPreImages(dir, { changed, begin, beginStatus });
		const plan = planRevert({ changed, preImages, recorded, current: recorded });
		expect(plan.error).toBeUndefined();
		const applied = await applyRevert(dir, plan.actions);
		expect(applied.errors).toEqual([]);

		expect(await readFile(dir, 'a.txt')).toBe('v2 pre-turn');
		expect(await readFile(dir, 'c.txt')).toBe('untracked before turn');
		expect(await readFile(dir, 'd.txt')).toBe('delete me');
		expect(await exists(dir, 'b.txt')).toBe(false);

		const statusAfter = await client.statusPorcelain(dir);
		expect([...statusAfter.entries()].map(([repoPath, entry]) => `${entry.code} ${repoPath}`)).toEqual([
			' M a.txt',
			'?? c.txt',
		]);
	});
});
