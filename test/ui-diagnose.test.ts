/**
 * `formatDiagnoseReport` 单元测试。
 *
 * 只测纯函数部分：不 import vscode、不依赖扩展宿主，`npm test`（vitest）可直接跑。
 */
import { describe, expect, it } from 'vitest';
import type { DiagnoseInput } from '../src/ui/contract';
import { formatDiagnoseReport } from '../src/ui/diagnose';

function makeInput(overrides: Partial<DiagnoseInput> = {}): DiagnoseInput {
	const base: DiagnoseInput = {
		extensionVersion: '0.1.0',
		runtime: {
			phase: 'ready',
			executable: 'C:\\tools\\dsh.exe',
			profile: 'acp',
			dshVersion: '1.2.3',
			protocolVersion: 1,
			capabilities: {
				sessionList: true,
				sessionResume: true,
				sessionClose: false,
				modelConfig: true,
				reasoningConfig: false,
				imagePrompts: false,
			},
		},
		executableCandidates: ['C:\\tools\\dsh.exe', 'C:\\Users\\me\\AppData\\Local\\dsh.exe'],
		config: {
			executable: '',
			profile: 'acp',
			permissionMode: 'workspace-write',
			autoApprove: 'ask',
			workspaceRoot: 'D:\\workspace\\demo',
		},
		logTail: ['[runtime] start', '[acp] initialize ok'],
		notes: ['测试环境：Windows 11'],
	};
	return { ...base, ...overrides };
}

describe('formatDiagnoseReport', () => {
	it('包含标题、运行时、能力矩阵与当前配置', () => {
		const report = formatDiagnoseReport(makeInput());

		expect(report).toContain('# DSH Review 兼容性诊断报告');
		expect(report).toContain('- 扩展版本：0.1.0');
		expect(report).toContain('- 阶段：已连接（ready）');
		expect(report).toContain('- 可执行文件：C:\\tools\\dsh.exe');
		expect(report).toContain('- Profile：acp');
		expect(report).toContain('- DSH 版本：1.2.3');
		expect(report).toContain('- ACP 协议版本：1');

		// 能力矩阵：可用/不可用都按布尔值渲染
		expect(report).toContain('| 会话列表（session/list） | 是 |');
		expect(report).toContain('| 关闭会话（session/close） | 否 |');
		expect(report).toContain('| 推理强度（configOptions: reasoning_effort） | 否 |');

		// 配置表
		expect(report).toContain('| 权限模式 | workspace-write |');
		expect(report).toContain('| 自动批准 | ask |');
		expect(report).toContain('| 工作区根目录 | D:\\workspace\\demo |');
		expect(report).toContain('| 可执行文件 | （自动探测） |');
	});

	it('渲染探针、候选列表、日志与备注', () => {
		const report = formatDiagnoseReport(
			makeInput({
				probe: {
					ok: false,
					executable: 'C:\\tools\\dsh.exe',
					profile: 'acp',
					dshVersion: '1.2.3',
					protocolVersion: 1,
					executableCandidates: ['C:\\tools\\dsh.exe'],
					capabilities: {
						sessionList: true,
						sessionResume: true,
						sessionClose: false,
						modelConfig: true,
						reasoningConfig: false,
						imagePrompts: false,
					},
					warnings: ['profile acp 不存在', '缺 model 配置项'],
					error: '启动超时',
					checkedAt: Date.UTC(2026, 0, 2, 3, 4, 5),
				},
			}),
		);

		expect(report).toContain('- 结果：失败');
		expect(report).toContain('- 检查时间：2026-01-02T03:04:05.000Z');
		expect(report).toContain('- 错误：启动超时');
		expect(report).toContain('### 探针警告');
		expect(report).toContain('- profile acp 不存在');
		expect(report).toContain('- 缺 model 配置项');

		// 候选按 1. 2. 编号
		expect(report).toContain('1. `C:\\tools\\dsh.exe`');
		expect(report).toContain('2. `C:\\Users\\me\\AppData\\Local\\dsh.exe`');

		// 日志放在四反引号围栏里，避免日志中的 ``` 提前闭合
		expect(report).toContain('````text');
		expect(report).toContain('[runtime] start');
		expect(report).toContain('[acp] initialize ok');

		expect(report).toContain('- 测试环境：Windows 11');
	});

	it('无探针/空数组时给出占位文案，不出现 undefined', () => {
		const report = formatDiagnoseReport(
			makeInput({
				runtime: {
					phase: 'error',
					capabilities: {
						sessionList: false,
						sessionResume: false,
						sessionClose: false,
						modelConfig: false,
						reasoningConfig: false,
						imagePrompts: false,
					},
					error: '找不到 dsh 可执行文件',
				},
				executableCandidates: [],
				logTail: [],
				notes: [],
			}),
		);

		expect(report).toContain('- 阶段：连接失败（error）');
		expect(report).toContain('- 错误：找不到 dsh 可执行文件');
		expect(report).toContain('未运行兼容性探针');
		expect(report).toContain('（未发现候选，请手动设置 `dshReview.executable`）');
		expect(report).toContain('（无日志）');
		expect(report).toContain('## 备注');
		expect(report).not.toContain('undefined');
		expect(report).not.toContain('NaN');
		expect(report).not.toContain('Invalid Date');
	});

	it('对表格单元格里的竖线与换行做转义', () => {
		const report = formatDiagnoseReport(
			makeInput({
				config: {
					executable: 'C:\\a|b\\dsh.exe',
					profile: 'acp',
					permissionMode: 'read-only',
					autoApprove: 'all',
					workspaceRoot: 'D:\\line1\nline2',
				},
			}),
		);
		expect(report).toContain('| 可执行文件 | C:\\a\\|b\\dsh.exe |');
		expect(report).toContain('| 工作区根目录 | D:\\line1 line2 |');
	});

	it('输出以换行结尾，便于直接写入 Markdown 文件/剪贴板', () => {
		const report = formatDiagnoseReport(makeInput());
		expect(report.endsWith('\n')).toBe(true);
	});
});
