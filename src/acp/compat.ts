/**
 * 兼容性层：发现支持 ACP 的 DSH profile、探测运行中的 DSH 版本/协议、
 * 并在 profile 损坏时用官方默认模板重建。
 *
 * 本文件不 import vscode，便于被 dist/compat.cjs（scripts/compat.mjs）直接
 * 在 Node 里执行，也便于 vitest 单测。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ProbeResult } from './contracts';
import { JsonRpcPeer } from './jsonrpc';
import { ACP_METHODS, ACP_PROTOCOL_VERSION, type AcpInitializeResult } from './protocol';
import { capabilitiesFromInitialize, emptyCapabilities, resolveExecutable, type ResolvedLauncher } from './runtime';
import { shellQuote, spawnDshTransport } from './transport';

// 兼容旧入口：任务书要求 compat 也暴露这些符号，便于 extension/compat-entry 从任一模块 import。
export { capabilitiesFromInitialize, emptyCapabilities, resolveExecutable };
export type { ResolvedLauncher };

const ACP_BUNDLE = '@deepseek-ai/dsh-acp-app';
const DEFAULT_TIMEOUT_MS = 20000;

/** DSH profile 目录（`~/.dsh/profiles`）。 */
export function defaultProfilesDir(): string {
	return path.join(os.homedir(), '.dsh', 'profiles');
}

/**
 * 扫描 profiles 目录，返回 bundle 里含 `@deepseek-ai/dsh-acp-app` 的 profile 名。
 * `acp` 优先，其余按字母序，保证调用方拿到的第一个就是最合适的。
 */
export async function discoverAcpProfiles(profilesDir: string): Promise<string[]> {
	let entries: { name: string; isDirectory(): boolean }[];
	try {
		entries = await readdir(profilesDir, { withFileTypes: true });
	} catch {
		return [];
	}
	const profiles: string[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		try {
			const raw = await readFile(path.join(profilesDir, entry.name, 'package.json'), 'utf8');
			const pkg = JSON.parse(raw) as { dsh?: { profile?: { bundles?: unknown } } };
			const bundles = pkg?.dsh?.profile?.bundles;
			if (Array.isArray(bundles) && bundles.some((bundle) => bundle === ACP_BUNDLE)) profiles.push(entry.name);
		} catch {
			// 不是 profile 目录（或缺 package.json），跳过即可。
		}
	}
	profiles.sort((left, right) => {
		if (left === 'acp') return -1;
		if (right === 'acp') return 1;
		return left.localeCompare(right);
	});
	return profiles;
}

/** 从 `dsh --version` 之类的输岀里提取版本号；解析失败返回 undefined。 */
export function parseVersionOutput(output: string): string | undefined {
	if (typeof output !== 'string') return undefined;
	const match = output.match(/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)/);
	return match ? match[1] : undefined;
}

interface CaptureResult {
	code: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

/**
 * 执行一次性 CLI 命令并收集输出。与 transport 一致：shell 模式用带引号的
 * 单条命令串，避免 Node 在 Windows 上拼参时丢失引号。
 */
function capture(launcher: ResolvedLauncher, args: string[], cwd: string, timeoutMs: number): Promise<CaptureResult> {
	return new Promise<CaptureResult>((resolve) => {
		let child: ChildProcess;
		try {
			if (launcher.shell) {
				const commandLine = [launcher.file, ...args].map(shellQuote).join(' ');
				child = spawn(commandLine, [], { shell: true, cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
			} else {
				child = spawn(launcher.file, args, { shell: false, cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
			}
		} catch (error) {
			resolve({ code: null, stdout: '', stderr: error instanceof Error ? error.message : String(error), timedOut: false });
			return;
		}
		let stdout = '';
		let stderr = '';
		let finished = false;
		let timedOut = false;
		const finish = (code: number | null): void => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			resolve({ code, stdout, stderr, timedOut });
		};
		const timer = setTimeout(() => {
			timedOut = true;
			try {
				child.kill();
			} catch {
				/* 忽略 */
			}
			finish(null);
		}, timeoutMs);
		child.stdout?.setEncoding('utf8');
		child.stdout?.on('data', (chunk: string) => {
			stdout += chunk;
		});
		child.stderr?.setEncoding('utf8');
		child.stderr?.on('data', (chunk: string) => {
			stderr += chunk;
		});
		child.on('error', (error) => {
			stderr += error.message;
			finish(null);
		});
		child.on('exit', (code) => finish(code));
	});
}

export interface ProbeOptions {
	launcher: ResolvedLauncher;
	profile: string;
	cwd: string;
	log: (line: string) => void;
	timeoutMs?: number;
}

function tail(text: string, max = 400): string {
	const trimmed = text.trim();
	return trimmed.length > max ? `…${trimmed.slice(-max)}` : trimmed;
}

/**
 * 真实探测：`--version` 拿 DSH 版本、`--profile <p> --help` 验证 profile 可启动、
 * ACP initialize 验证协议版本与能力声明。任一步失败都写进 error/warnings 而不抛出。
 */
export async function probeRuntime(opts: ProbeOptions): Promise<ProbeResult> {
	const timeoutMs = Math.max(3000, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
	const warnings: string[] = [];
	const base: ProbeResult = {
		ok: false,
		executable: opts.launcher.file,
		profile: opts.profile,
		executableCandidates: [...opts.launcher.candidates],
		capabilities: emptyCapabilities(),
		warnings,
		checkedAt: Date.now(),
	};
	opts.log(`[compat] 探测 ${opts.launcher.file}（source=${opts.launcher.source}）profile=${opts.profile}`);

	const version = await capture(opts.launcher, [...opts.launcher.argsPrefix, '--version'], opts.cwd, timeoutMs);
	const dshVersion = parseVersionOutput(`${version.stdout}\n${version.stderr}`);
	if (!dshVersion) {
		warnings.push(`无法从 dsh --version 解析版本号（exit=${String(version.code)}${version.timedOut ? '，超时' : ''}）`);
	}
	if (version.code !== 0) {
		warnings.push(`dsh --version 退出码为 ${String(version.code)}${version.timedOut ? '（超时）' : ''}`);
	}

	const help = await capture(opts.launcher, [...opts.launcher.argsPrefix, '--profile', opts.profile, '--help'], opts.cwd, timeoutMs);
	if (help.code !== 0) {
		const detail = tail(help.stderr || help.stdout);
		const reason = help.timedOut ? '超时' : `退出码 ${String(help.code)}`;
		const error = `profile「${opts.profile}」无法启动（${reason}）${detail ? `：${detail}` : ''}`;
		opts.log(`[compat] ${error}`);
		return { ...base, dshVersion, warnings, error, checkedAt: Date.now() };
	}

	let protocolVersion: number | undefined;
	let capabilities = emptyCapabilities();
	let transport: ReturnType<typeof spawnDshTransport> | undefined;
	let peer: JsonRpcPeer | undefined;
	try {
		transport = spawnDshTransport({
			file: opts.launcher.file,
			args: [...opts.launcher.argsPrefix, '--profile', opts.profile],
			shell: opts.launcher.shell,
			cwd: opts.cwd,
			env: { ...process.env },
			log: opts.log,
			onStderr: (text) => opts.log(`[compat] stderr：${text.trim()}`),
		});
		peer = new JsonRpcPeer(transport, opts.log);
		const result = await peer.request<AcpInitializeResult>(
			ACP_METHODS.initialize,
			{ protocolVersion: ACP_PROTOCOL_VERSION, clientCapabilities: {} },
			{ timeoutMs },
		);
		protocolVersion = typeof result?.protocolVersion === 'number' ? result.protocolVersion : undefined;
		capabilities = capabilitiesFromInitialize(result);
		if (protocolVersion !== ACP_PROTOCOL_VERSION) {
			warnings.push(`ACP 协议版本不匹配：期望 ${ACP_PROTOCOL_VERSION}，DSH 返回 ${String(protocolVersion)}`);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		opts.log(`[compat] ACP 握手失败：${message}`);
		return { ...base, dshVersion, warnings, error: `ACP 握手失败：${message}`, checkedAt: Date.now() };
	} finally {
		if (peer) {
			try {
				peer.dispose();
			} catch {
				/* 忽略 */
			}
		}
		if (transport) {
			try {
				transport.close();
				await transport.kill();
			} catch {
				/* 忽略 */
			}
		}
	}

	return {
		...base,
		ok: protocolVersion === ACP_PROTOCOL_VERSION,
		dshVersion,
		protocolVersion,
		capabilities,
		warnings,
		checkedAt: Date.now(),
	};
}

function timestamp(): string {
	const now = new Date();
	const pad = (value: number, length = 2): string => String(value).padStart(length, '0');
	return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

/**
 * 用官方默认模板重建 profile：先备份 `~/.dsh/profiles/<profile>`，再执行
 * `dsh --profile <p> --from-default-profile <p> --help`，exit 0 视为成功。
 */
export async function repairAcpProfile(launcher: ResolvedLauncher, profile: string, log: (line: string) => void): Promise<boolean> {
	const target = path.join(defaultProfilesDir(), profile);
	const backup = `${target}.bak-${timestamp()}`;
	try {
		if (existsSync(target)) {
			await cp(target, backup, { recursive: true, force: true });
			log(`[compat] 已备份 profile「${profile}」到 ${backup}`);
		} else {
			log(`[compat] profile「${profile}」目录不存在，直接按默认模板重建`);
		}
	} catch (error) {
		log(`[compat] 备份 profile 失败：${String(error)}`);
		return false;
	}
	const result = await capture(
		launcher,
		[...launcher.argsPrefix, '--profile', profile, '--from-default-profile', profile, '--help'],
		process.cwd(),
		30000,
	);
	if (result.code === 0) {
		log(`[compat] profile「${profile}」已按默认模板重建`);
		return true;
	}
	const detail = tail(result.stderr || result.stdout);
	log(`[compat] profile 重建失败（${result.timedOut ? '超时' : `退出码 ${String(result.code)}`}）${detail ? `：${detail}` : ''}`);
	return false;
}

function formatCapabilities(capabilities: ProbeResult['capabilities']): string {
	const labels: [keyof ProbeResult['capabilities'], string][] = [
		['sessionList', '会话列表'],
		['sessionResume', '会话恢复'],
		['sessionClose', '会话关闭'],
		['imagePrompts', '图片输入'],
	];
	const supported = labels.filter(([key]) => capabilities[key]).map(([, label]) => label);
	return supported.length > 0 ? supported.join('、') : '无（仅基础会话）';
}

/**
 * `scripts/compat.mjs` 的入口：真实启动一次 DSH 做兼容性检查并打印中文报告。
 * 返回 0 表示通过，非 0 表示需要用户处理。
 */
export async function runCompatCli(): Promise<number> {
	const log = (line: string): void => console.log(line);
	console.log('=== DSH Review 兼容性自检 ===');
	const launcher = await resolveExecutable('');
	log(`可执行文件：${launcher.file}（source=${launcher.source}）`);
	const profiles = await discoverAcpProfiles(defaultProfilesDir());
	log(`发现支持 ACP 的 profile：${profiles.length > 0 ? profiles.join('、') : '无'}`);
	const profile = profiles.includes('acp') ? 'acp' : profiles[0];
	if (!profile) {
		console.log('✗ 没有找到支持 ACP 的 profile。请确认已安装 DSH 桌面端或运行 `dsh --profile acp` 初始化 profile。');
		return 1;
	}
	const probe = await probeRuntime({ launcher, profile, cwd: process.cwd(), log, timeoutMs: 30000 });
	console.log('');
	console.log(`版本：${probe.dshVersion ?? '未知'}`);
	console.log(`ACP 协议版本：${String(probe.protocolVersion)}（期望 ${ACP_PROTOCOL_VERSION}）`);
	console.log(`能力：${formatCapabilities(probe.capabilities)}`);
	for (const warning of probe.warnings) console.log(`⚠ ${warning}`);
	if (probe.ok) {
		console.log('✓ 兼容性检查通过');
		return 0;
	}
	console.log(`✗ 兼容性检查失败：${probe.error ?? '未知错误'}`);
	console.log('可尝试运行：dsh --profile acp --from-default-profile acp --help 重建 profile。');
	return 1;
}
