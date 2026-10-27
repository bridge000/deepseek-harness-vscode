import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { GitRunner } from '../src/review/git';
import {
	MAX_RESTORE_BYTES,
	MAX_UNTRACKED_FILES,
	captureBeginState,
	planRevert,
	recordPostState,
	sha256OfBuffer,
	type RevertPostFileState,
	type RevertPreImage,
} from '../src/review/revert';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const STASH_SHA = 'c'.repeat(40);

const tempDirs: string[] = [];

afterEach(async () => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) await fs.rm(dir, { recursive: true, force: true });
	}
});

async function makeTempDir(): Promise<string> {
	const dir = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'dsh-revert-test-'));
	tempDirs.push(dir);
	return dir;
}

function fakeRunner(
	handler: (args: readonly string[], cwd: string) => { code?: number; stdout?: string; stderr?: string },
): GitRunner {
	return {
		async run(args, cwd) {
			const result = handler(args, cwd);
			return { code: result.code ?? 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
		},
	};
}

function porcelain(entries: readonly string[]): string {
	return entries.map((entry) => `${entry}\0`).join('');
}

function state(sha: string, overrides: Partial<RevertPostFileState> = {}): RevertPostFileState {
	return { exists: true, sha256: sha, bytes: 8, binary: false, ...overrides };
}

interface PlanOptions {
	changed: string[];
	pre: Record<string, RevertPreImage>;
	recorded: Record<string, RevertPostFileState>;
	/** Defaults to `recorded` (nothing changed on disk since the turn ended). */
	current?: Record<string, RevertPostFileState>;
}

function runPlan(options: PlanOptions) {
	const recorded = new Map(Object.entries(options.recorded));
	return planRevert({
		changed: options.changed,
		preImages: new Map(Object.entries(options.pre)),
		recorded,
		current: options.current ? new Map(Object.entries(options.current)) : recorded,
	});
}

describe('planRevert (pure decisions)', () => {
	it('restores a modified tracked file from the begin stash snapshot', () => {
		const plan = runPlan({
			changed: ['src/a.ts'],
			pre: { 'src/a.ts': { exists: true, stashContent: 'before-stash', headContent: 'before-head' } },
			recorded: { 'src/a.ts': state(HASH_A) },
		});
		expect(plan.error).toBeUndefined();
		expect(plan.skipped).toEqual([]);
		expect(plan.actions).toEqual([{ path: 'src/a.ts', kind: 'restore', content: 'before-stash' }]);
	});

	it('falls back to HEAD when no stash snapshot exists', () => {
		const plan = runPlan({
			changed: ['src/a.ts'],
			pre: { 'src/a.ts': { exists: true, headContent: 'head-content' } },
			recorded: { 'src/a.ts': state(HASH_A) },
		});
		expect(plan.error).toBeUndefined();
		expect(plan.actions).toEqual([{ path: 'src/a.ts', kind: 'restore', content: 'head-content' }]);
	});

	it('prefers the begin snapshot for a pre-existing untracked file', () => {
		const plan = runPlan({
			changed: ['docs/notes.md'],
			pre: { 'docs/notes.md': { exists: true, untrackedContent: 'snapshot', stashContent: 'stash', headContent: 'head' } },
			recorded: { 'docs/notes.md': state(HASH_A) },
		});
		expect(plan.actions).toEqual([{ path: 'docs/notes.md', kind: 'restore', content: 'snapshot' }]);
	});

	it('deletes files created by the turn', () => {
		const plan = runPlan({
			changed: ['src/new.ts'],
			pre: { 'src/new.ts': { exists: false } },
			recorded: { 'src/new.ts': state(HASH_A) },
		});
		expect(plan.error).toBeUndefined();
		expect(plan.actions).toEqual([{ path: 'src/new.ts', kind: 'delete' }]);
	});

	it('restores files deleted by the turn', () => {
		const plan = runPlan({
			changed: ['src/gone.ts'],
			pre: { 'src/gone.ts': { exists: true, stashContent: 'was here' } },
			recorded: { 'src/gone.ts': { exists: false } },
		});
		expect(plan.error).toBeUndefined();
		expect(plan.actions).toEqual([{ path: 'src/gone.ts', kind: 'restore', content: 'was here' }]);
	});

	it('refuses when the file was edited again after the turn (hash guard)', () => {
		const plan = runPlan({
			changed: ['src/a.ts'],
			pre: { 'src/a.ts': { exists: true, stashContent: 'before' } },
			recorded: { 'src/a.ts': state(HASH_A) },
			current: { 'src/a.ts': state(HASH_B) },
		});
		expect(plan.actions).toEqual([]);
		expect(plan.error).toContain('已整体拒绝');
		expect(plan.skipped).toHaveLength(1);
		expect(plan.skipped[0].reason).toContain('又被修改');
	});

	it('refuses when a file was created or deleted after the turn', () => {
		const plan = runPlan({
			changed: ['src/new.ts'],
			pre: { 'src/new.ts': { exists: false } },
			recorded: { 'src/new.ts': state(HASH_A) },
			current: { 'src/new.ts': { exists: false } },
		});
		expect(plan.actions).toEqual([]);
		expect(plan.error).toBeDefined();
		expect(plan.skipped[0].reason).toContain('被创建或删除');
	});

	it('refuses binary files', () => {
		const plan = runPlan({
			changed: ['assets/logo.png'],
			pre: { 'assets/logo.png': { exists: true, stashContent: 'binary' } },
			recorded: { 'assets/logo.png': state(HASH_A, { binary: true }) },
		});
		expect(plan.actions).toEqual([]);
		expect(plan.error).toBeDefined();
		expect(plan.skipped[0].reason).toContain('二进制');
	});

	it('refuses files above the restore size limit', () => {
		const plan = runPlan({
			changed: ['data/big.txt'],
			pre: { 'data/big.txt': { exists: true, stashContent: 'x' } },
			recorded: { 'data/big.txt': state(HASH_A, { bytes: MAX_RESTORE_BYTES + 1 }) },
		});
		expect(plan.actions).toEqual([]);
		expect(plan.error).toBeDefined();
		expect(plan.skipped[0].reason).toContain('超过 2MB');
	});

	it('refuses when the begin snapshot content is missing', () => {
		const plan = runPlan({
			changed: ['src/a.ts'],
			pre: { 'src/a.ts': { exists: true } },
			recorded: { 'src/a.ts': state(HASH_A) },
		});
		expect(plan.actions).toEqual([]);
		expect(plan.error).toBeDefined();
		expect(plan.skipped[0].reason).toContain('缺少本轮开始前的文件内容');
	});

	it('refuses when the pre-turn info for a changed path is missing', () => {
		const plan = runPlan({
			changed: ['src/a.ts'],
			pre: {},
			recorded: { 'src/a.ts': state(HASH_A) },
		});
		expect(plan.actions).toEqual([]);
		expect(plan.error).toBeDefined();
		expect(plan.skipped[0].reason).toContain('缺少本轮开始前的文件信息');
	});

	it('refuses when the post-turn record is missing', () => {
		const plan = runPlan({
			changed: ['src/a.ts'],
			pre: { 'src/a.ts': { exists: true, stashContent: 'before' } },
			recorded: {},
		});
		expect(plan.actions).toEqual([]);
		expect(plan.error).toBeDefined();
		expect(plan.skipped[0].reason).toContain('缺少本轮结束时记录的文件状态');
	});

	it('refuses when hashes cannot be verified', () => {
		const plan = runPlan({
			changed: ['src/a.ts'],
			pre: { 'src/a.ts': { exists: true, stashContent: 'before' } },
			recorded: { 'src/a.ts': { exists: true, bytes: 8 } },
		});
		expect(plan.actions).toEqual([]);
		expect(plan.skipped[0].reason).toContain('无法校验');
	});

	it('refuses when the pre-turn content was binary', () => {
		const plan = runPlan({
			changed: ['assets/icon.ico'],
			pre: { 'assets/icon.ico': { exists: true, untrackedContent: 'a\0b' } },
			recorded: { 'assets/icon.ico': state(HASH_A) },
		});
		expect(plan.actions).toEqual([]);
		expect(plan.skipped[0].reason).toContain('二进制内容');
	});

	it('skips files created and deleted within the same turn without refusing', () => {
		const plan = runPlan({
			changed: ['tmp/scratch.txt'],
			pre: { 'tmp/scratch.txt': { exists: false } },
			recorded: { 'tmp/scratch.txt': { exists: false } },
		});
		expect(plan.error).toBeUndefined();
		expect(plan.actions).toEqual([]);
		expect(plan.skipped).toEqual([{ path: 'tmp/scratch.txt', reason: '本轮新建后又删除，无需撤销' }]);
	});

	it('is atomic: one unsafe path refuses the whole turn', () => {
		const plan = runPlan({
			changed: ['src/a.ts', 'src/b.ts'],
			pre: {
				'src/a.ts': { exists: true, stashContent: 'before-a' },
				'src/b.ts': { exists: true, stashContent: 'before-b' },
			},
			recorded: { 'src/a.ts': state(HASH_A), 'src/b.ts': state(HASH_A) },
			current: { 'src/a.ts': state(HASH_A), 'src/b.ts': state(HASH_B) },
		});
		expect(plan.error).toContain('1 处');
		expect(plan.actions).toEqual([]);
		expect(plan.skipped.map((entry) => entry.path)).toEqual(['src/b.ts']);
	});

	it('supports restore + delete in one plan and normalizes Windows separators', () => {
		const plan = runPlan({
			changed: ['src\\a.ts', 'src\\new.ts'],
			pre: {
				'src/a.ts': { exists: true, stashContent: 'before' },
				'src/new.ts': { exists: false },
			},
			recorded: { 'src/a.ts': state(HASH_A), 'src/new.ts': state(HASH_A) },
		});
		expect(plan.error).toBeUndefined();
		expect(plan.actions).toEqual([
			{ path: 'src/a.ts', kind: 'restore', content: 'before' },
			{ path: 'src/new.ts', kind: 'delete' },
		]);
	});
});

describe('captureBeginState (injected runner)', () => {
	it('treats a clean work tree as HEAD-based with no reason', async () => {
		const dir = await makeTempDir();
		const runner = fakeRunner((args) => (args[0] === 'status' ? { stdout: '' } : { stdout: '' }));
		const state = await captureBeginState(dir, runner);
		expect(state.stashRevision).toBeUndefined();
		expect(state.reason).toBeUndefined();
		expect(state.truncated).toBe(false);
		expect(state.untracked.size).toBe(0);
	});

	it('marks the baseline unusable when stash create fails with tracked changes', async () => {
		const dir = await makeTempDir();
		const runner = fakeRunner((args) =>
			args[0] === 'status' ? { stdout: porcelain([' M src/a.ts']) } : { code: 1, stderr: 'fatal: unable to write' },
		);
		const state = await captureBeginState(dir, runner);
		expect(state.stashRevision).toBeUndefined();
		expect(state.reason).toContain('git stash create 失败');
	});

	it('snapshots pre-existing untracked text files and skips binary ones', async () => {
		const dir = await makeTempDir();
		await fs.mkdir(nodePath.join(dir, 'docs'), { recursive: true });
		await fs.writeFile(nodePath.join(dir, 'docs', 'note.md'), 'hello', 'utf8');
		await fs.writeFile(nodePath.join(dir, 'blob.bin'), Buffer.from([0x61, 0x00, 0x62]));

		const runner = fakeRunner((args) => {
			if (args[0] === 'status') {
				return { stdout: porcelain(['?? blob.bin', '?? docs/note.md']) };
			}
			return { stdout: STASH_SHA };
		});
		const state = await captureBeginState(dir, runner);
		expect(state.stashRevision).toBe(STASH_SHA);
		expect(state.untracked.get('docs/note.md')).toEqual({
			content: 'hello',
			sha256: sha256OfBuffer(Buffer.from('hello')),
		});
		expect(state.untracked.has('blob.bin')).toBe(false);
		expect(state.skipped).toEqual([{ path: 'blob.bin', reason: '二进制文件，未记录文本快照' }]);
		expect(state.reason).toBeUndefined();
	});

	it('truncates the baseline when there are too many untracked files', async () => {
		const dir = await makeTempDir();
		const entries = Array.from({ length: MAX_UNTRACKED_FILES + 1 }, (_, index) => `?? f${index}.txt`);
		const runner = fakeRunner((args) => (args[0] === 'status' ? { stdout: porcelain(entries) } : { stdout: '' }));
		const state = await captureBeginState(dir, runner);
		expect(state.truncated).toBe(true);
		expect(state.reason).toContain('超过 200 个');
		expect(state.untracked.size).toBe(0);
	});
});

describe('recordPostState', () => {
	it('records exists/hash/size for text files and absence for missing files', async () => {
		const dir = await makeTempDir();
		await fs.mkdir(nodePath.join(dir, 'src'));
		await fs.writeFile(nodePath.join(dir, 'src', 'a.ts'), 'after\n', 'utf8');
		const state = await recordPostState(dir, ['src/a.ts', 'src/missing.ts']);
		const file = state.get('src/a.ts');
		expect(file?.exists).toBe(true);
		expect(file?.binary).toBe(false);
		expect(file?.bytes).toBe(Buffer.byteLength('after\n'));
		expect(file?.sha256).toBe(sha256OfBuffer(Buffer.from('after\n')));
		expect(state.get('src/missing.ts')).toEqual({ exists: false });
	});

	it('flags binary files and normalizes Windows separators', async () => {
		const dir = await makeTempDir();
		await fs.writeFile(nodePath.join(dir, 'blob.bin'), Buffer.from([0x00, 0x01]));
		const state = await recordPostState(dir, ['blob.bin']);
		expect(state.get('blob.bin')?.binary).toBe(true);
		expect(state.get('blob.bin')?.sha256).toBeDefined();
	});
});
