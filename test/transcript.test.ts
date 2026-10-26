import { mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTranscriptStore } from '../src/session/transcript';
import type { TranscriptEntry } from '../src/types';

const dirs: string[] = [];

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), 'dsh-transcript-'));
	dirs.push(dir);
	return dir;
}

afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function makeEntries(): TranscriptEntry[] {
	return [
		{ id: 'u1', kind: 'user', text: '看看 a.ts', at: 1000 },
		{ id: 'a1', kind: 'assistant', text: '好的', messageId: 'm1', at: 2000, streaming: false },
		{ id: 'tool:t1', kind: 'tool', toolCallId: 't1', title: '读取文件', status: 'completed', locations: [{ path: 'a.ts', line: 3 }], at: 3000 },
	];
}

describe('transcript store', () => {
	it('save/load 往返保留条目', async () => {
		const dir = await tempDir();
		const logs: string[] = [];
		const store = createTranscriptStore(dir, (line) => logs.push(line));
		const entries = makeEntries();
		await store.save('session-1', entries);
		expect(store.load('session-1')).toEqual(entries);
		// 会话 id 含特殊字符时也要能安全落盘。
		await store.save('C:\\repo/session#2', entries);
		expect(store.load('C:\\repo/session#2')).toEqual(entries);
	});

	it('缺文件或坏 JSON 时返回空数组并记录日志', async () => {
		const dir = await tempDir();
		const logs: string[] = [];
		const store = createTranscriptStore(dir, (line) => logs.push(line));
		expect(store.load('missing')).toEqual([]);
		await writeFile(path.join(dir, 'broken.json'), '{ not json', 'utf8');
		expect(store.load('broken')).toEqual([]);
		expect(logs.some((line) => line.includes('broken.json'))).toBe(true);
	});

	it('schemaVersion 不匹配时忽略文件', async () => {
		const dir = await tempDir();
		const logs: string[] = [];
		const store = createTranscriptStore(dir, (line) => logs.push(line));
		await writeFile(
			path.join(dir, 'old.json'),
			JSON.stringify({ schemaVersion: 0, sessionId: 'old', updatedAt: 1, entries: makeEntries() }),
			'utf8',
		);
		expect(store.load('old')).toEqual([]);
		expect(logs.some((line) => line.includes('schemaVersion'))).toBe(true);
	});

	it('原子写不残留临时文件', async () => {
		const dir = await tempDir();
		const store = createTranscriptStore(dir, () => undefined);
		await store.save('s1', makeEntries());
		const names = await readdir(dir);
		expect(names.filter((name) => name.includes('.tmp-'))).toHaveLength(0);
		expect(names).toContain('s1.json');
	});

	it('prune 按 mtime 保留最新 keep 个', async () => {
		const dir = await tempDir();
		const store = createTranscriptStore(dir, () => undefined);
		await store.save('old', makeEntries());
		await store.save('middle', makeEntries());
		await store.save('newest', makeEntries());
		const base = Date.now() / 1000;
		await utimes(path.join(dir, 'old.json'), base - 300, base - 300);
		await utimes(path.join(dir, 'middle.json'), base - 200, base - 200);
		await utimes(path.join(dir, 'newest.json'), base - 100, base - 100);
		await store.prune(2);
		const names = (await readdir(dir)).sort();
		expect(names).toEqual(['middle.json', 'newest.json']);
		// keep 至少为 1，0 或负数不会清空全部记录。
		await store.prune(0);
		expect(await readdir(dir)).toHaveLength(1);
	});

	it('prune 在目录不存在时静默返回', async () => {
		const dir = path.join(await tempDir(), 'not-created');
		const store = createTranscriptStore(dir, () => undefined);
		await expect(store.prune(3)).resolves.toBeUndefined();
	});
});
