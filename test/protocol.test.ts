import { describe, expect, it } from 'vitest';
import { contentToText, findConfigOption, normalizeConfigOptions } from '../src/acp/protocol';

describe('normalizeConfigOptions', () => {
	it('normalizes the grouped ACP model option and the reasoning selector', () => {
		const options = normalizeConfigOptions([
			{
				id: 'model',
				name: 'Model',
				category: 'model',
				type: 'select',
				currentValue: '["deepseek-official","deepseek-v4-flash"]',
				options: [
					{
						group: 'deepseek-official',
						name: 'DeepSeek',
						options: [
							{ value: '["deepseek-official","deepseek-v4-flash"]', name: 'deepseek-v4-flash' },
							{ value: '["deepseek-official","deepseek-v4-pro"]', name: 'DeepSeek-V4-Pro', description: '更强' },
						],
					},
				],
			},
			{
				id: 'reasoning_effort',
				name: 'Reasoning effort',
				category: 'thought_level',
				type: 'select',
				currentValue: 'high',
				options: [
					{ value: 'off', name: 'Off' },
					{ value: 'high', name: 'High' },
				],
			},
		]);
		expect(options).toHaveLength(2);
		expect(options[0]).toMatchObject({ id: 'model', category: 'model' });
		expect(options[0].values).toHaveLength(2);
		expect(options[0].values[1]).toMatchObject({
			value: '["deepseek-official","deepseek-v4-pro"]',
			name: 'DeepSeek-V4-Pro',
			group: 'deepseek-official',
			groupName: 'DeepSeek',
		});
		expect(findConfigOption(options, 'model')?.id).toBe('model');
		expect(findConfigOption(options, 'reasoning')?.id).toBe('reasoning_effort');
	});

	it('accepts flat option lists and ignores malformed entries', () => {
		const options = normalizeConfigOptions([
			{ id: 'model', name: 'Model', type: 'select', options: [{ value: 'a', name: 'A' }] },
			{ id: 'broken' },
			null,
			{ name: 'no id' },
		]);
		expect(options).toHaveLength(2);
		expect(options[0].values).toEqual([{ value: 'a', name: 'A', description: undefined, group: undefined, groupName: undefined }]);
		expect(findConfigOption(options, 'reasoning')).toBeUndefined();
	});

	it('tolerates unknown payload shapes', () => {
		expect(normalizeConfigOptions(undefined)).toEqual([]);
		expect(normalizeConfigOptions({})).toEqual([]);
		expect(normalizeConfigOptions([{ id: 42 }])).toEqual([]);
	});
});

describe('contentToText', () => {
	it('extracts text blocks and concatenates arrays', () => {
		expect(contentToText({ type: 'text', text: 'hi' })).toBe('hi');
		expect(
			contentToText([
				{ type: 'text', text: 'a' },
				{ type: 'text', text: 'b' },
				{ type: 'image', data: '...' },
			]),
		).toBe('ab');
		expect(contentToText(null)).toBe('');
		expect(contentToText({ type: 'text', text: 1 })).toBe('');
	});
});
