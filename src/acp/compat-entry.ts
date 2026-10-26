/**
 * Script-facing entry point (no `vscode` imports).
 *
 * `scripts/compat.mjs` and `scripts/smoke.mjs` require the bundled
 * `dist/compat.cjs`, which exposes the *real* launcher resolution, transport and
 * JSON-RPC client so the scripts test the same code paths as the extension.
 */
import * as os from 'node:os';
import * as path from 'node:path';

import type { ProbeResult } from './contracts';
import { JsonRpcPeer } from './jsonrpc';
import { discoverAcpProfiles, probeRuntime } from './compat';
import { resolveExecutable } from './runtime';
import { spawnDshTransport } from './transport';
import { ACP_METHODS, ACP_PROTOCOL_VERSION, type AcpNewSessionResult, type AcpPromptResult } from './protocol';

function log(line: string): void {
	process.stdout.write(`${line}\n`);
}

function profilesDir(): string {
	return path.join(os.homedir(), '.dsh', 'profiles');
}

async function runOneShot(
	launcher: Awaited<ReturnType<typeof resolveExecutable>>,
	profile: string,
	cwd: string,
	action: (peer: JsonRpcPeer) => Promise<void>,
): Promise<void> {
	const transport = spawnDshTransport({
		file: launcher.file,
		args: [...launcher.argsPrefix, '--profile', profile],
		shell: launcher.shell,
		cwd,
		env: { ...process.env, DSH_PERMISSION_MODE: 'read-only' },
		log: (line) => log(`[spawn] ${line}`),
		onDirtyLine: (line) => log(`[stdout-dirty] ${line}`),
		onStderr: (text) => process.stderr.write(text),
	});
	const peer = new JsonRpcPeer(transport, (line) => log(`[rpc] ${line}`));
	try {
		await peer.request(
			ACP_METHODS.initialize,
			{ protocolVersion: ACP_PROTOCOL_VERSION, clientCapabilities: {} },
			{ timeoutMs: 60000 },
		);
		await action(peer);
	} finally {
		try {
			peer.dispose();
		} catch {
			/* ignore */
		}
		await transport.kill().catch(() => undefined);
	}
}

/** `npm run compat`: assert the key ACP contract used by the extension. */
export async function runCompatCli(): Promise<number> {
	const cwd = process.cwd();
	log(`DSH Review 兼容性检查（cwd=${cwd}）`);
	let failures = 0;
	const check = (ok: boolean, message: string): void => {
		log(`${ok ? '  ✓' : '  ✗'} ${message}`);
		if (!ok) failures += 1;
	};
	try {
		const launcher = await resolveExecutable('');
		log(`可执行文件：${launcher.file}（来源 ${launcher.source}）`);
		for (const candidate of launcher.candidates) log(`  候选：${candidate}`);

		const profile = process.env.DSH_REVIEW_PROFILE || 'acp';
		const profiles = await discoverAcpProfiles(profilesDir());
		log(`ACP profile：${profiles.length > 0 ? profiles.join(', ') : '(未发现)'}`);
		check(profiles.length > 0 || profile === 'acp', '至少存在一个 ACP-capable profile（或使用默认 acp）');

		const probe: ProbeResult = await probeRuntime({
			launcher,
			profile,
			cwd,
			log: (line) => log(`  [probe] ${line}`),
		});
		check(probe.ok, `ACP 握手可用${probe.error ? `（${probe.error}）` : ''}`);
		check(typeof probe.dshVersion === 'string' && probe.dshVersion.length > 0, `dsh 版本可解析：${probe.dshVersion ?? '(未知)'}`);
		check(probe.protocolVersion === ACP_PROTOCOL_VERSION, `ACP protocolVersion=${probe.protocolVersion ?? '(未知)'}（期望 ${ACP_PROTOCOL_VERSION}）`);

		if (probe.ok) {
			await runOneShot(launcher, profile, cwd, async (peer) => {
				const created = await peer.request<AcpNewSessionResult>(
					ACP_METHODS.sessionNew,
					{ cwd, mcpServers: [] },
					{ timeoutMs: 120000 },
				);
				check(typeof created.sessionId === 'string' && created.sessionId.length > 0, `session/new 返回 sessionId`);
				const rawOptions = Array.isArray(created.configOptions) ? created.configOptions : [];
				const normalized = rawOptions as Array<{ id?: unknown; category?: unknown }>;
				const hasModel = normalized.some((option) => option?.category === 'model' || option?.id === 'model');
				check(hasModel, 'session/new 提供 model 配置项（模型选择器可用）');
				await peer.request(ACP_METHODS.sessionClose, { sessionId: created.sessionId }, { timeoutMs: 60000 }).catch((error: unknown) => {
					log(`  (session/close 失败，已忽略：${String(error)})`);
				});
			});
		}
	} catch (error) {
		failures += 1;
		log(`  ✗ 未捕获错误：${error instanceof Error ? error.message : String(error)}`);
	}
	log(failures === 0 ? '结果：兼容' : `结果：不兼容（${failures} 项失败）——请运行 “DSH: 兼容性诊断” 并考虑更新扩展`);
	return failures === 0 ? 0 : 1;
}

/** `npm run smoke`: initialize → session/new → session/close（+ 可选 prompt）。 */
export async function runSmokeCli(): Promise<number> {
	const cwd = process.cwd();
	log(`DSH Review 冒烟测试（cwd=${cwd}）`);
	const launcher = await resolveExecutable('');
	log(`可执行文件：${launcher.file}（来源 ${launcher.source}）`);
	const profile = process.env.DSH_REVIEW_PROFILE || 'acp';
	const promptEnabled = process.env.DSH_REVIEW_SMOKE_PROMPT === '1';
	let failures = 0;
	try {
		await runOneShot(launcher, profile, cwd, async (peer) => {
			const created = await peer.request<AcpNewSessionResult>(
				ACP_METHODS.sessionNew,
				{ cwd, mcpServers: [] },
				{ timeoutMs: 120000 },
			);
			if (typeof created.sessionId !== 'string') throw new Error('session/new 未返回 sessionId');
			log(`  ✓ session/new ${created.sessionId}`);

			if (promptEnabled) {
				let text = '';
				const off = peer.onNotification(ACP_METHODS.sessionUpdate, (params) => {
					const update = (params as { update?: { sessionUpdate?: string; content?: unknown } }).update;
					if (update?.sessionUpdate === 'agent_message_chunk' && typeof update.content === 'object' && update.content !== null) {
						const content = update.content as { type?: string; text?: string };
						if (content.type === 'text' && typeof content.text === 'string') text += content.text;
					}
				});
				const result = await peer.request<AcpPromptResult>(
					ACP_METHODS.sessionPrompt,
					{ sessionId: created.sessionId, prompt: [{ type: 'text', text: '请只回复两个字：收到。' }] },
					{ timeoutMs: 180000 },
				);
				off.dispose();
				log(`  ✓ session/prompt stopReason=${result?.stopReason ?? '(unknown)'}，收到 ${text.length} 字符`);
				if (text.trim().length === 0) {
					failures += 1;
					log('  ✗ 没有收到 agent_message_chunk 文本');
				}
			}
			await peer.request(ACP_METHODS.sessionClose, { sessionId: created.sessionId }, { timeoutMs: 60000 }).catch(() => undefined);
			log('  ✓ session/close');
		});
	} catch (error) {
		failures += 1;
		log(`  ✗ 冒烟失败：${error instanceof Error ? error.message : String(error)}`);
	}
	log(failures === 0 ? '结果：通过' : '结果：失败');
	return failures === 0 ? 0 : 1;
}
