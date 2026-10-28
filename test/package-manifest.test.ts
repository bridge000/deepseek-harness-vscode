/**
 * Manifest regression guard.
 *
 * VS Code renders a `view/title` contribution as plain text when its command
 * has no icon, which is exactly what used to overflow the sidebar header
 * ("DeepSeek Harness: 清除审查结果"). This test keeps every view-title action
 * icon-only and keeps the manifest/CHANGELOG versions in sync.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

interface CommandContribution {
	command: string;
	title: string;
	icon?: string;
}

interface MenuContribution {
	command: string;
	when?: string;
}

interface SettingProperty {
	type?: string;
	default?: unknown;
	minimum?: number;
	maximum?: number;
	description?: string;
	markdownDescription?: string;
}

interface Manifest {
	version: string;
	contributes: {
		commands: CommandContribution[];
		menus: Record<string, MenuContribution[] | undefined>;
		configuration?: { properties?: Record<string, SettingProperty> };
	};
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as Manifest;
const changelog = readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');

const commandsById = new Map(manifest.contributes.commands.map((command) => [command.command, command]));
const viewTitle = manifest.contributes.menus['view/title'] ?? [];
const commandPalette = manifest.contributes.menus.commandPalette ?? [];
const settings = manifest.contributes.configuration?.properties ?? {};

describe('view/title 菜单', () => {
	it('每条命令都必须有 codicon（否则 VS Code 会渲染命令全名，挤坏侧边栏标题栏）', () => {
		expect(viewTitle.length).toBeGreaterThan(0);
		for (const entry of viewTitle) {
			const contribution = commandsById.get(entry.command);
			expect(contribution, `view/title 引用了未声明的命令：${entry.command}`).toBeDefined();
			expect(contribution?.icon, `${entry.command} 在 view/title 中缺少 icon`).toBeTruthy();
		}
	});

	it('「清除审查结果」不再占用 view/title，但仍可从命令面板执行', () => {
		expect(viewTitle.some((entry) => entry.command === 'deepseekHarness.clearFindings')).toBe(false);
		expect(commandPalette.some((entry) => entry.command === 'deepseekHarness.clearFindings')).toBe(true);
	});
});

describe('字号设置', () => {
	it('fontScale 存在、类型正确且带 0.8–1.8 范围', () => {
		const property = settings['deepseekHarness.fontScale'];
		expect(property, '缺少 deepseekHarness.fontScale 设置').toBeDefined();
		expect(property?.type).toBe('number');
		expect(property?.default).toBe(1);
		expect(property?.minimum).toBe(0.8);
		expect(property?.maximum).toBe(1.8);
	});

	it('描述里同时包含「字体」「字号」，保证设置搜索可发现，并提示 ⋯ 菜单入口', () => {
		const description = settings['deepseekHarness.fontScale']?.description ?? '';
		expect(description).toContain('字体');
		expect(description).toContain('字号');
		expect(description).toContain('⋯');
	});
});

describe('后台自启设置', () => {
	it('autoStartRuntime 存在且默认开启', () => {
		const property = settings['deepseekHarness.autoStartRuntime'];
		expect(property, '缺少 deepseekHarness.autoStartRuntime 设置').toBeDefined();
		expect(property?.type).toBe('boolean');
		expect(property?.default).toBe(true);
	});
});

describe('版本一致性', () => {
	it('package.json version 与 CHANGELOG 最新小节一致', () => {
		const latest = /^##\s+([0-9]+\.[0-9]+\.[0-9]+)/m.exec(changelog)?.[1];
		expect(latest).toBe(manifest.version);
	});
});
