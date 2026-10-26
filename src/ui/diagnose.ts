/**
 * 兼容性诊断报告。
 *
 * `formatDiagnoseReport` 是纯函数（不 import vscode），由 `test/ui-diagnose.test.ts`
 * 直接测试；`showDiagnoseReport` 才在运行时动态引入 vscode 展示/复制报告，
 * 这样诊断逻辑可以在扩展宿主之外复用与验证。
 */
import type { DiagnoseInput } from './contract';
import type { RuntimePhase } from '../types';

const PHASE_LABELS: Record<RuntimePhase, string> = {
	stopped: '未连接（stopped）',
	starting: '启动中（starting）',
	ready: '已连接（ready）',
	error: '连接失败（error）',
};

const CAPABILITY_LABELS: ReadonlyArray<readonly [keyof DiagnoseInput['runtime']['capabilities'], string]> = [
	['sessionList', '会话列表（session/list）'],
	['sessionResume', '恢复会话（session/resume）'],
	['sessionClose', '关闭会话（session/close）'],
	['modelConfig', '模型切换（configOptions: model）'],
	['reasoningConfig', '推理强度（configOptions: reasoning_effort）'],
	['imagePrompts', '图片提示（prompt image）'],
];

/** Markdown 表格单元格转义，避免配置值里的 `|` 破坏表格。 */
function cell(value: string): string {
	return value.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
}

function orPlaceholder(value: string | undefined, placeholder = '（无）'): string {
	return value && value.trim().length > 0 ? value : placeholder;
}

function formatList(lines: readonly string[], empty = '（无）'): string {
	if (lines.length === 0) return empty;
	return lines.map((line) => `- ${line}`).join('\n');
}

function truncate(value: string, max: number): string {
	return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * 生成完整诊断报告（Markdown）。包含：运行时状态、能力矩阵、兼容性探针、
 * 可执行文件候选、当前配置、日志尾部与备注，方便用户直接贴到 issue 里。
 */
export function formatDiagnoseReport(input: DiagnoseInput): string {
	const { runtime, probe, config } = input;
	const generatedAt = new Date().toISOString();
	const lines: string[] = [];

	lines.push('# DeepSeek Harness 兼容性诊断报告', '');
	lines.push(`- 生成时间：${generatedAt}`);
	lines.push(`- 扩展版本：${orPlaceholder(input.extensionVersion, '未知')}`);
	lines.push('');

	lines.push('## 运行时', '');
	lines.push(`- 阶段：${PHASE_LABELS[runtime.phase] ?? runtime.phase}`);
	lines.push(`- 可执行文件：${orPlaceholder(runtime.executable, '（未确定）')}`);
	lines.push(`- Profile：${orPlaceholder(runtime.profile, '（未确定）')}`);
	lines.push(`- DSH 版本：${orPlaceholder(runtime.dshVersion, '未知')}`);
	lines.push(
		`- ACP 协议版本：${runtime.protocolVersion === undefined ? '未知' : String(runtime.protocolVersion)}`,
	);
	lines.push(`- 错误：${orPlaceholder(runtime.error)}`);
	lines.push('');

	lines.push('## ACP 能力', '');
	lines.push('| 能力 | 可用 |', '| --- | --- |');
	for (const [key, label] of CAPABILITY_LABELS) {
		lines.push(`| ${label} | ${runtime.capabilities[key] ? '是' : '否'} |`);
	}
	lines.push('');

	lines.push('## 兼容性探针', '');
	if (probe) {
		lines.push(`- 结果：${probe.ok ? '通过' : '失败'}`);
		lines.push(`- 可执行文件：${orPlaceholder(probe.executable, '（未知）')}`);
		lines.push(`- Profile：${orPlaceholder(probe.profile, '（未知）')}`);
		lines.push(`- DSH 版本：${orPlaceholder(probe.dshVersion, '未知')}`);
		lines.push(
			`- ACP 协议版本：${probe.protocolVersion === undefined ? '未知' : String(probe.protocolVersion)}`,
		);
		lines.push(`- 检查时间：${new Date(probe.checkedAt).toISOString()}`);
		lines.push(`- 错误：${orPlaceholder(probe.error)}`);
		lines.push('', '### 探针警告', '', formatList(probe.warnings));
		lines.push('', '### 探针可执行文件候选', '', formatList(probe.executableCandidates));
	} else {
		lines.push('未运行兼容性探针（运行时尚未启动，或探测被跳过）。');
	}
	lines.push('');

	lines.push('## 可执行文件候选', '');
	if (input.executableCandidates.length === 0) {
		lines.push('（未发现候选，请手动设置 `deepseekHarness.executable`）');
	} else {
		input.executableCandidates.forEach((candidate, index) => {
			lines.push(`${index + 1}. \`${candidate.replace(/`/g, '\\`')}\``);
		});
	}
	lines.push('');

	lines.push('## 当前配置', '');
	lines.push('| 配置项 | 值 |', '| --- | --- |');
	lines.push(`| 可执行文件 | ${cell(orPlaceholder(config.executable, '（自动探测）'))} |`);
	lines.push(`| Profile | ${cell(orPlaceholder(config.profile, '（自动）'))} |`);
	lines.push(`| 权限模式 | ${cell(orPlaceholder(config.permissionMode))} |`);
	lines.push(`| 自动批准 | ${cell(orPlaceholder(config.autoApprove))} |`);
	lines.push(`| 工作区根目录 | ${cell(orPlaceholder(config.workspaceRoot))} |`);
	lines.push('');

	lines.push('## 日志尾部', '');
	lines.push('````text');
	if (input.logTail.length === 0) {
		lines.push('（无日志）');
	} else {
		for (const line of input.logTail) lines.push(line.replace(/\r/g, ''));
	}
	lines.push('````', '');

	lines.push('## 备注', '');
	lines.push(formatList(input.notes));
	lines.push('');

	return lines.join('\n');
}

/**
 * 在 VS Code 里展示诊断摘要，并提供「复制报告」/「打开设置」操作。
 * 这里才动态 import vscode，保证本模块的纯函数部分可在 Node 下测试。
 */
export async function showDiagnoseReport(input: DiagnoseInput): Promise<void> {
	const vscode = await import('vscode');
	const report = formatDiagnoseReport(input);
	const phase = PHASE_LABELS[input.runtime.phase] ?? input.runtime.phase;
	const detail = input.runtime.error
		? `，错误：${truncate(input.runtime.error, 120)}`
		: input.probe && !input.probe.ok
			? '，兼容性探针未通过'
			: '';
	const summary = `DeepSeek Harness 诊断：运行时${phase}${detail}`;
	const choice = await vscode.window.showInformationMessage(summary, '复制报告', '打开设置');
	if (choice === '复制报告') {
		await vscode.env.clipboard.writeText(report);
		await vscode.window.showInformationMessage('兼容性诊断报告已复制到剪贴板。');
	} else if (choice === '打开设置') {
		await vscode.commands.executeCommand('workbench.action.openSettings', 'deepseekHarness');
	}
}
