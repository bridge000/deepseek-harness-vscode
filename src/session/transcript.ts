/**
 * 本地 transcript 持久化：每个会话一个 JSON 文件，schemaVersion=1。
 *
 * 写入采用“临时文件 + rename”的原子替换，避免 VS Code 崩溃/断电时留下半截
 * JSON；prune 按文件 mtime 只保留最近 N 个会话记录。
 */
import { readFileSync } from 'node:fs';
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { TranscriptStore } from '../acp/contracts';
import type { TranscriptEntry } from '../types';

const SCHEMA_VERSION = 1;

interface StoredTranscript {
	schemaVersion: number;
	sessionId: string;
	updatedAt: number;
	entries: TranscriptEntry[];
}

function isTranscriptEntry(value: unknown): value is TranscriptEntry {
	if (typeof value !== 'object' || value === null) return false;
	const record = value as { id?: unknown; kind?: unknown };
	if (typeof record.id !== 'string' || record.id.length === 0) return false;
	return (
		record.kind === 'user' ||
		record.kind === 'assistant' ||
		record.kind === 'thought' ||
		record.kind === 'tool' ||
		record.kind === 'notice'
	);
}

/** 会话 id 来自 ACP，可能含 `/` 等字符，转义后再当文件名。 */
function fileNameFor(sessionId: string): string {
	return `${encodeURIComponent(sessionId)}.json`;
}

export function createTranscriptStore(dir: string, log: (line: string) => void): TranscriptStore {
	const fileFor = (sessionId: string): string => path.join(dir, fileNameFor(sessionId));

	return {
		load(sessionId: string): TranscriptEntry[] {
			const file = fileFor(sessionId);
			let raw: string;
			try {
				raw = readFileSync(file, 'utf8');
			} catch {
				return [];
			}
			try {
				const parsed = JSON.parse(raw) as Partial<StoredTranscript>;
				if (!parsed || typeof parsed !== 'object') return [];
				if (parsed.schemaVersion !== SCHEMA_VERSION) {
					log(`[transcript] ${path.basename(file)} 的 schemaVersion=${String(parsed.schemaVersion)} 不受支持，已忽略`);
					return [];
				}
				if (!Array.isArray(parsed.entries)) return [];
				return parsed.entries.filter(isTranscriptEntry);
			} catch (error) {
				log(`[transcript] 读取 ${path.basename(file)} 失败：${String(error)}`);
				return [];
			}
		},

		async save(sessionId: string, entries: readonly TranscriptEntry[]): Promise<void> {
			await mkdir(dir, { recursive: true });
			const file = fileFor(sessionId);
			const payload: StoredTranscript = {
				schemaVersion: SCHEMA_VERSION,
				sessionId,
				updatedAt: Date.now(),
				entries: [...entries],
			};
			const temp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
			try {
				await writeFile(temp, `${JSON.stringify(payload, null, '\t')}\n`, 'utf8');
				await rename(temp, file);
			} catch (error) {
				await rm(temp, { force: true }).catch(() => undefined);
				log(`[transcript] 保存 ${path.basename(file)} 失败：${String(error)}`);
				throw error;
			}
		},

		async prune(keep: number): Promise<void> {
			const limit = Math.max(1, Math.floor(keep));
			let names: string[];
			try {
				names = await readdir(dir);
			} catch {
				return;
			}
			const files = names.filter((name) => name.endsWith('.json')).map((name) => path.join(dir, name));
			const stamped: { file: string; mtimeMs: number }[] = [];
			for (const file of files) {
				try {
					const info = await stat(file);
					stamped.push({ file, mtimeMs: info.mtimeMs });
				} catch {
					// 并发删除/改名时文件可能已不存在，跳过即可。
				}
			}
			stamped.sort((left, right) => right.mtimeMs - left.mtimeMs);
			for (const entry of stamped.slice(limit)) {
				try {
					await rm(entry.file, { force: true });
					log(`[transcript] 已清理旧记录 ${path.basename(entry.file)}`);
				} catch (error) {
					log(`[transcript] 清理 ${path.basename(entry.file)} 失败：${String(error)}`);
				}
			}
		},
	};
}
