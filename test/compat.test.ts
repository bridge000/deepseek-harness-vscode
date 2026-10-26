import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	capabilitiesFromInitialize,
	discoverAcpProfiles,
	parseVersionOutput,
	probeRuntime,
	resolveExecutable,
} from '../src/acp/compat';
import { emptyCapabilities } from '../src/acp/runtime';

const dirs: string[] = [];

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), 'dsh-compat-'));
	dirs.push(dir);
	return dir;
}

afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function writeProfile(profilesDir: string, name: string, bundles: string[]): Promise<void> {
	await mkdir(path.join(profilesDir, name), { recursive: true });
	await writeFile(
		path.join(profilesDir, name, 'package.json'),
		JSON.stringify({ name: `dsh-profile-${name}`, dsh: { profile: { bundles } } }, null, 2),
		'utf8',
	);
}

describe('parseVersionOutput', () => {
	it('解析裸版本号', () => {
		expect(parseVersionOutput('0.2.1-rc.2\n')).toBe('0.2.1-rc.2');
		expect(parseVersionOutput('1.2.3')).toBe('1.2.3');
	});

	it('解析带前缀/后缀的版本号', () => {
		expect(parseVersionOutput('dsh/1.2.3 (win32)')).toBe('1.2.3');
		expect(parseVersionOutput('hello 1.0.0+build.5 world')).toBe('1.0.0+build.5');
	});

	it('没有版本号时返回 undefined', () => {
		expect(parseVersionOutput('')).toBeUndefined();
		expect(parseVersionOutput('no version here')).toBeUndefined();
	});
});

describe('discoverAcpProfiles', () => {
	it('只返回 bundle 含 @deepseek-ai/dsh-acp-app 的 profile，acp 优先', async () => {
		const dir = await tempDir();
		await writeProfile(dir, 'desktop', ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']);
		await writeProfile(dir, 'acp', ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app']);
		await writeProfile(dir, 'zeta', ['@deepseek-ai/dsh-acp-app']);
		await writeProfile(dir, 'web', ['@deepseek-ai/dsh-base']);
		await mkdir(path.join(dir, 'node_modules'), { recursive: true });
		await writeFile(path.join(dir, 'not-a-profile.txt'), 'x', 'utf8');
		await expect(discoverAcpProfiles(dir)).resolves.toEqual(['acp', 'zeta']);
	});

	it('目录不存在或没有 package.json 时返回空数组', async () => {
		const dir = await tempDir();
		await expect(discoverAcpProfiles(path.join(dir, 'missing'))).resolves.toEqual([]);
		await mkdir(path.join(dir, 'empty-profile'), { recursive: true });
		await expect(discoverAcpProfiles(dir)).resolves.toEqual([]);
	});
});

describe('capabilitiesFromInitialize', () => {
	it('按 agentCapabilities 映射能力', () => {
		const result = {
			protocolVersion: 1,
			agentCapabilities: {
				promptCapabilities: { image: true, audio: false },
				sessionCapabilities: { close: {}, list: {}, resume: {} },
			},
		};
		expect(capabilitiesFromInitialize(result)).toMatchObject({
			sessionList: true,
			sessionResume: true,
			sessionClose: true,
			imagePrompts: true,
			modelConfig: false,
			reasoningConfig: false,
		});
	});

	it('缺失能力时全部为 false，且不因畸形输入抛错', () => {
		expect(capabilitiesFromInitialize(undefined)).toEqual(emptyCapabilities());
		expect(capabilitiesFromInitialize({ protocolVersion: 1 })).toEqual(emptyCapabilities());
		expect(
			capabilitiesFromInitialize({
				protocolVersion: 1,
				agentCapabilities: { sessionCapabilities: { list: false, resume: null, close: undefined } },
			}),
		).toEqual(emptyCapabilities());
	});
});

describe('resolveExecutable', () => {
	it('配置了存在的文件时使用配置值；.cmd 需要 shell', async () => {
		const dir = await tempDir();
		const file = path.join(dir, 'dsh.cmd');
		await writeFile(file, '@echo off\n', 'utf8');
		const launcher = await resolveExecutable(file);
		expect(launcher).toMatchObject({ file, source: 'config', shell: true, argsPrefix: [] });
		expect(launcher.candidates).toContain(file);
	});

	it('配置为空时总能返回一个可用的 launcher（PATH/桌面端/npx 兜底）', async () => {
		const launcher = await resolveExecutable('');
		expect(typeof launcher.file).toBe('string');
		expect(launcher.file.length).toBeGreaterThan(0);
		expect(['config', 'path', 'desktop', 'npx']).toContain(launcher.source);
		expect(Array.isArray(launcher.argsPrefix)).toBe(true);
		expect(typeof launcher.shell).toBe('boolean');
		expect(launcher.candidates.length).toBeGreaterThan(0);
	});
});

describe('probeRuntime', () => {
	it('可执行文件不存在时返回 ok=false 与错误信息，不抛异常', async () => {
		const dir = await tempDir();
		const missing = path.join(dir, 'missing-dsh.exe');
		const result = await probeRuntime({
			launcher: { file: missing, argsPrefix: [], shell: false, source: 'config', candidates: [missing] },
			profile: 'acp',
			cwd: dir,
			log: () => undefined,
			timeoutMs: 3000,
		});
		expect(result.ok).toBe(false);
		expect(result.executable).toBe(missing);
		expect(result.executableCandidates).toEqual([missing]);
		expect(result.profile).toBe('acp');
		expect(result.error).toBeTruthy();
		expect(result.checkedAt).toBeTypeOf('number');
		expect(result.warnings.length).toBeGreaterThan(0);
	});
});
