/**
 * ACP 运行时：解析 `dsh` 可执行文件、启动 `dsh --profile <profile>` 子进程、
 * 完成 ACP 握手并维护渲染层可见的 RuntimeState。
 *
 * 进程/协议细节全部委托给 transport.ts 与 jsonrpc.ts；本文件只负责生命周期
 * 与状态机，保证同一个 runtime 实例同时最多只有一个子进程。
 */
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import type { AcpCapabilities, RuntimeState } from '../types';
import type { DshRuntime, ProbeResult, RuntimeOptions } from './contracts';
import { JsonRpcPeer } from './jsonrpc';
import { ACP_METHODS, ACP_PROTOCOL_VERSION, type AcpInitializeResult } from './protocol';
import { spawnDshTransport, type SpawnedTransport } from './transport';

/** 解析后的启动器：把 file/argsPrefix/shell 直接交给 spawnDshTransport。 */
export interface ResolvedLauncher {
	file: string;
	argsPrefix: string[];
	/** Windows 的 `.cmd` / 裸命令名必须经由 shell 启动。 */
	shell: boolean;
	source: 'config' | 'path' | 'desktop' | 'npx';
	/** 探测过的全部候选路径，供兼容性诊断报告展示。 */
	candidates: string[];
}

const NPX_FALLBACK_ARGS = ['--yes', '@deepseek-ai/dsh'];

export function emptyCapabilities(): AcpCapabilities {
	return {
		sessionList: false,
		sessionResume: false,
		sessionClose: false,
		modelConfig: false,
		reasoningConfig: false,
		imagePrompts: false,
	};
}

/**
 * 判断是否需要 shell：Node >= 20 在 Windows 上禁止直接 spawn `.cmd/.bat`，
 * 而裸命令名（如 `npx`、用户填的 `dsh`）只能靠 shell 解析 PATH。
 */
export function needsShell(file: string): boolean {
	if (/\.(cmd|bat)$/i.test(file)) return true;
	if (process.platform !== 'win32') return false;
	const hasSeparator = file.includes('/') || file.includes(path.sep);
	return !path.isAbsolute(file) && !hasSeparator;
}

function isFile(file: string): boolean {
	try {
		return existsSync(file) && statSync(file).isFile();
	} catch {
		return false;
	}
}

/** PATH 里可能存在的 dsh（Windows 依次尝试 .cmd/.exe/.bat）。 */
function pathExecutableCandidates(): string[] {
	const extensions = process.platform === 'win32' ? ['.cmd', '.exe', '.bat'] : [''];
	const dirs = (process.env.PATH ?? '').split(path.delimiter).filter((dir) => dir.length > 0);
	const candidates: string[] = [];
	for (const dir of dirs) {
		for (const extension of extensions) candidates.push(path.join(dir, `dsh${extension}`));
	}
	return candidates;
}

/** DSH 桌面端自带的 CLI（安装后即使没加 PATH 也能用）。 */
function desktopExecutableCandidates(): string[] {
	const candidates: string[] = [];
	const localAppData = process.env.LOCALAPPDATA;
	if (localAppData) {
		candidates.push(
			path.join(localAppData, 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', process.platform === 'win32' ? 'dsh.cmd' : 'dsh'),
		);
	}
	const programFiles = process.env.ProgramFiles;
	if (process.platform === 'win32' && programFiles) {
		candidates.push(path.join(programFiles, 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'));
	}
	return candidates;
}

/**
 * 解析可执行文件：配置值 → PATH → DSH 桌面端 → `npx @deepseek-ai/dsh` 兜底。
 * `configured` 可能是空字符串；返回的 launcher 永远可用（最差是 npx 兜底）。
 */
export async function resolveExecutable(configured: string): Promise<ResolvedLauncher> {
	const candidates: string[] = [];
	const trimmed = (configured ?? '').trim();
	if (trimmed.length > 0) {
		candidates.push(trimmed);
		if (isFile(trimmed)) return { file: trimmed, argsPrefix: [], shell: needsShell(trimmed), source: 'config', candidates };
		// 用户填的是裸命令名时，先按 PATH 找真实文件，找不到就交给 shell 解析。
		if (!trimmed.includes('/') && !trimmed.includes(path.sep)) {
			const viaPath = pathExecutableCandidates();
			candidates.push(...viaPath);
			for (const file of viaPath) {
				if (isFile(file)) return { file, argsPrefix: [], shell: needsShell(file), source: 'config', candidates };
			}
			return { file: trimmed, argsPrefix: [], shell: process.platform === 'win32', source: 'config', candidates };
		}
	}
	const fromPath = pathExecutableCandidates();
	candidates.push(...fromPath);
	for (const file of fromPath) {
		if (isFile(file)) return { file, argsPrefix: [], shell: needsShell(file), source: 'path', candidates };
	}
	const fromDesktop = desktopExecutableCandidates();
	candidates.push(...fromDesktop);
	for (const file of fromDesktop) {
		if (isFile(file)) return { file, argsPrefix: [], shell: needsShell(file), source: 'desktop', candidates };
	}
	candidates.push(`npx ${NPX_FALLBACK_ARGS.join(' ')}`);
	return {
		file: 'npx',
		argsPrefix: [...NPX_FALLBACK_ARGS],
		shell: process.platform === 'win32',
		source: 'npx',
		candidates,
	};
}

function isCapability(value: unknown): boolean {
	// ACP 用空对象 `{}` 表示支持、`false`/缺失表示不支持。
	return value !== undefined && value !== null && value !== false;
}

/** 把 initialize 结果映射为 UI 关心的能力集合；未知字段一律忽略。 */
export function capabilitiesFromInitialize(result: AcpInitializeResult | undefined | null): AcpCapabilities {
	const capabilities = emptyCapabilities();
	if (!result || typeof result !== 'object') return capabilities;
	const agentCapabilities = (result as { agentCapabilities?: unknown }).agentCapabilities;
	if (!agentCapabilities || typeof agentCapabilities !== 'object') return capabilities;
	const sessionCapabilities = (agentCapabilities as { sessionCapabilities?: unknown }).sessionCapabilities;
	if (sessionCapabilities && typeof sessionCapabilities === 'object') {
		const caps = sessionCapabilities as { list?: unknown; resume?: unknown; close?: unknown };
		capabilities.sessionList = isCapability(caps.list);
		capabilities.sessionResume = isCapability(caps.resume);
		capabilities.sessionClose = isCapability(caps.close);
	}
	const promptCapabilities = (agentCapabilities as { promptCapabilities?: unknown }).promptCapabilities;
	if (promptCapabilities && typeof promptCapabilities === 'object') {
		capabilities.imagePrompts = (promptCapabilities as { image?: unknown }).image === true;
	}
	return capabilities;
}

/**
 * 扩展运行时接口：会话层拿到 configOptions 后回填 model/reasoning 能力，
 * 让诊断报告展示真实能力矩阵（initialize 本身不携带 configOptions）。
 * 不属于 DshRuntime 契约，调用方用可选链探测即可。
 */
export interface DshRuntimeWithCapabilities extends DshRuntime {
	updateCapabilities(patch: Partial<AcpCapabilities>): void;
}

export function createDshRuntime(options: RuntimeOptions): DshRuntime {
	const log = options.log;
	let state: RuntimeState = { phase: 'stopped', capabilities: emptyCapabilities() };
	const listeners = new Set<(state: RuntimeState) => void>();
	let transport: SpawnedTransport | undefined;
	let peer: JsonRpcPeer | undefined;
	let startPromise: Promise<RuntimeState> | undefined;
	/** stop() 触发的关闭不应被当成崩溃。 */
	let stopping = false;
	let cachedProbe: ProbeResult | undefined;

	const setState = (patch: Partial<RuntimeState>): void => {
		state = { ...state, ...patch };
		for (const listener of listeners) {
			try {
				listener(state);
			} catch (error) {
				log(`[runtime] 状态监听器抛出异常：${String(error)}`);
			}
		}
	};

	const teardown = async (): Promise<void> => {
		const spawned = transport;
		const currentPeer = peer;
		// 先摘掉引用：关闭回调看到 transport 已不是自己就会跳过错误状态。
		transport = undefined;
		peer = undefined;
		if (currentPeer) {
			try {
				currentPeer.dispose(new Error('运行时已停止'));
			} catch {
				/* 忽略 */
			}
		}
		if (spawned) {
			try {
				spawned.close();
			} catch {
				/* 忽略 */
			}
			try {
				await spawned.kill();
			} catch (error) {
				log(`[runtime] 结束子进程失败：${String(error)}`);
			}
		}
	};

	const start = async (): Promise<RuntimeState> => {
		if (state.phase === 'ready' && peer && !peer.isClosed) return state;
		if (startPromise) return startPromise;
		startPromise = (async (): Promise<RuntimeState> => {
			await teardown();
			stopping = false;
			const profile = (options.profile || 'acp').trim() || 'acp';
			setState({ phase: 'starting', error: undefined, profile });
			try {
				const launcher = await resolveExecutable(options.executable);
				const args = [...launcher.argsPrefix, '--profile', profile];
				log(`[runtime] 启动 DSH：${launcher.file} ${args.join(' ')}（source=${launcher.source}, shell=${String(launcher.shell)}）`);
				const spawned = spawnDshTransport({
					file: launcher.file,
					args,
					shell: launcher.shell,
					cwd: options.cwd,
					env: { ...process.env, DSH_PERMISSION_MODE: options.permissionMode },
					log,
					onDirtyLine: (line) => {
						log(`[runtime] stdout 非协议行：${line}`);
						options.onDirtyStdout?.(line);
					},
					onStderr: (text) => {
						const trimmed = text.trim();
						if (trimmed.length > 0) log(`[runtime] stderr：${trimmed}`);
					},
				});
				transport = spawned;
				const currentPeer = new JsonRpcPeer(spawned, log);
				peer = currentPeer;
				currentPeer.onClose((error) => {
					// 主动 stop / 已被 teardown 摘掉的连接不算错误。
					if (stopping || transport !== spawned) return;
					transport = undefined;
					peer = undefined;
					log(`[runtime] 连接关闭${error ? `：${error.message}` : ''}`);
					setState({ phase: 'error', error: `DSH 连接已断开：${error?.message ?? '进程已退出'}` });
				});
				const result = await currentPeer.request<AcpInitializeResult>(
					ACP_METHODS.initialize,
					{ protocolVersion: ACP_PROTOCOL_VERSION, clientCapabilities: {} },
					{ timeoutMs: 30000 },
				);
				const protocolVersion = typeof result?.protocolVersion === 'number' ? result.protocolVersion : undefined;
				if (protocolVersion !== ACP_PROTOCOL_VERSION) {
					// 协议版本不一致只告警：正常响应通常仍兼容，直接失败会让用户无法使用。
					log(`[runtime] 警告：DSH ACP 协议版本为 ${String(protocolVersion)}，扩展按 v${ACP_PROTOCOL_VERSION} 处理`);
				}
				setState({
					phase: 'ready',
					executable: launcher.file,
					profile,
					protocolVersion,
					dshVersion: cachedProbe?.dshVersion,
					capabilities: capabilitiesFromInitialize(result),
					error: undefined,
				});
				return state;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				log(`[runtime] 启动失败：${message}`);
				await teardown();
				setState({ phase: 'error', profile, error: `无法启动 DSH 运行时：${message}` });
				return state;
			}
		})().finally(() => {
			startPromise = undefined;
		});
		return startPromise;
	};

	const stop = async (): Promise<void> => {
		stopping = true;
		await teardown();
		setState({ phase: 'stopped', error: undefined });
	};

	const restart = async (): Promise<RuntimeState> => {
		log('[runtime] 收到重启请求');
		await stop();
		return start();
	};

	const api: DshRuntimeWithCapabilities = {
		state: () => state,
		onDidChangeState(listener) {
			listeners.add(listener);
			return {
				dispose: () => {
					listeners.delete(listener);
				},
			};
		},
		start,
		restart,
		stop,
		peer() {
			if (!peer || peer.isClosed || state.phase !== 'ready') {
				throw new Error(state.error ? `DSH 运行时不可用：${state.error}` : 'DSH 运行时尚未就绪');
			}
			return peer;
		},
		probe: () => cachedProbe,
		setProbe(probe) {
			cachedProbe = probe;
			// 版本号来自 CLI 探测，握手本身拿不到；探测结果到达后补齐展示信息。
			if (probe?.dshVersion && probe.dshVersion !== state.dshVersion) setState({ dshVersion: probe.dshVersion });
		},
		updateCapabilities(patch) {
			const changed = (Object.keys(patch) as (keyof AcpCapabilities)[]).some(
				(key) => state.capabilities[key] !== patch[key],
			);
			if (!changed) return;
			setState({ capabilities: { ...state.capabilities, ...patch } });
		},
	};
	return api;
}
