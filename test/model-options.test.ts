import { describe, expect, it } from 'vitest';
import { findConfigOption, normalizeConfigOptions } from '../src/acp/protocol';
import {
	LEGACY_MODEL_ALIASES,
	canonicalModelId,
	canonicalModelRef,
	isLegacyModel,
	modelRefKey,
	type ModelRef,
} from '../src/model/legacyModels';
import {
	formatModelValue,
	normalizeModelOptions,
	parseModelValue,
	sameModelRef,
	toConfigOptions,
} from '../src/model/modelOptions';
import type { ConfigOption } from '../src/types';

const OFFICIAL_FLASH: ModelRef = { provider: 'deepseek-official', model: 'deepseek-flash' };
const OFFICIAL_PRO: ModelRef = { provider: 'deepseek-official', model: 'deepseek-v4-pro' };
const ACCOUNT_FLASH: ModelRef = { provider: 'deepseek-account', model: 'deepseek-flash' };
const ACCOUNT_PRO: ModelRef = { provider: 'deepseek-account', model: 'deepseek-v4-pro' };
const LEGACY_FLASH: ModelRef = { provider: 'deepseek-official', model: 'deepseek-v4-flash' };

/** Real `session/new` configOptions payload (captured from the ACP runtime). */
const MODEL_OPTION_RAW = {
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
				{ value: '["deepseek-official","deepseek-flash"]', name: 'DeepSeek-V4.1-Flash' },
				{ value: '["deepseek-official","deepseek-v4-pro"]', name: 'DeepSeek-V4-Pro' },
			],
		},
		{
			group: 'deepseek-account',
			name: 'DeepSeek Account',
			options: [
				{ value: '["deepseek-account","deepseek-flash"]', name: 'DeepSeek-V4.1-Flash' },
				{ value: '["deepseek-account","deepseek-v4-pro"]', name: 'DeepSeek-V4-Pro' },
			],
		},
	],
};

const REASONING_OPTION_RAW = {
	id: 'reasoning_effort',
	name: 'Reasoning effort',
	category: 'thought_level',
	type: 'select',
	currentValue: 'high',
	options: [
		{ value: 'off', name: 'Off' },
		{ value: 'low', name: 'Low' },
		{ value: 'high', name: 'High' },
		{ value: 'max', name: 'Max' },
	],
};

const RAW_CONFIG_OPTIONS: unknown = [MODEL_OPTION_RAW, REASONING_OPTION_RAW];

function modelOption(options: ConfigOption[]): ConfigOption {
	const option = findConfigOption(options, 'model');
	if (!option) throw new Error('expected a model option');
	return option;
}

function modelRefs(options: ConfigOption[]): Array<ModelRef | undefined> {
	return modelOption(options).values.map((value) => parseModelValue(value.value));
}

describe('legacyModels', () => {
	it('maps retired ids to their replacements for the DeepSeek providers', () => {
		expect(LEGACY_MODEL_ALIASES['deepseek-v4-flash']).toBe('deepseek-flash');
		expect(isLegacyModel('deepseek-official', 'deepseek-v4-flash')).toBe(true);
		expect(isLegacyModel('deepseek-account', 'deepseek-v4-flash')).toBe(true);
		expect(canonicalModelId('deepseek-official', 'deepseek-v4-flash')).toBe('deepseek-flash');
		expect(canonicalModelRef(LEGACY_FLASH)).toEqual(OFFICIAL_FLASH);
	});

	it('hides the retired vision experiment without a replacement', () => {
		const hidden: ModelRef = { provider: 'deepseek-official', model: 'deepseek-v4-flash-vision-exp' };
		expect(isLegacyModel(hidden.provider, hidden.model)).toBe(true);
		expect(canonicalModelId(hidden.provider, hidden.model)).toBeNull();
		expect(canonicalModelRef(hidden)).toBeUndefined();
	});

	it('leaves current models and unknown providers alone', () => {
		expect(isLegacyModel('deepseek-official', 'deepseek-flash')).toBe(false);
		expect(canonicalModelId('deepseek-official', 'deepseek-flash')).toBe('deepseek-flash');
		expect(canonicalModelId('some-provider', 'deepseek-v4-flash')).toBe('deepseek-v4-flash');
		expect(isLegacyModel('some-provider', 'deepseek-v4-flash')).toBe(false);
	});

	it('formats stable ref keys', () => {
		expect(modelRefKey(OFFICIAL_FLASH)).toBe('deepseek-official/deepseek-flash');
	});
});

describe('parseModelValue / formatModelValue', () => {
	it('round-trips a model reference through the ACP encoding', () => {
		const encoded = formatModelValue(OFFICIAL_FLASH);
		expect(encoded).toBe('["deepseek-official","deepseek-flash"]');
		expect(parseModelValue(encoded)).toEqual(OFFICIAL_FLASH);
	});

	it('accepts the `{ value }` wrapper some ACP versions emit', () => {
		expect(parseModelValue({ value: '["deepseek-account","deepseek-v4-pro"]' })).toEqual(ACCOUNT_PRO);
	});

	it('tolerates malformed values', () => {
		expect(parseModelValue(undefined)).toBeUndefined();
		expect(parseModelValue(null)).toBeUndefined();
		expect(parseModelValue(42)).toBeUndefined();
		expect(parseModelValue('deepseek-flash')).toBeUndefined();
		expect(parseModelValue('[]')).toBeUndefined();
		expect(parseModelValue('["only-provider"]')).toBeUndefined();
		expect(parseModelValue('["p","m","extra"]')).toBeUndefined();
		expect(parseModelValue('["p",42]')).toBeUndefined();
		expect(parseModelValue('["","m"]')).toBeUndefined();
		expect(parseModelValue('not json')).toBeUndefined();
		expect(parseModelValue(['p', 'm'])).toBeUndefined();
	});

	it('compares model references', () => {
		expect(sameModelRef(OFFICIAL_FLASH, { ...OFFICIAL_FLASH })).toBe(true);
		expect(sameModelRef(OFFICIAL_FLASH, ACCOUNT_FLASH)).toBe(false);
		expect(sameModelRef(undefined, OFFICIAL_FLASH)).toBe(false);
	});
});

describe('normalizeModelOptions', () => {
	it('hides the retired model and keeps the canonical choices per provider', () => {
		const result = normalizeModelOptions(RAW_CONFIG_OPTIONS, { hideLegacy: true });
		expect(result.options).toHaveLength(2);
		expect(modelRefs(result.options)).toEqual([OFFICIAL_FLASH, OFFICIAL_PRO, ACCOUNT_FLASH, ACCOUNT_PRO]);
		expect(modelOption(result.options).values.map((value) => value.name)).toEqual([
			'DeepSeek-V4.1-Flash',
			'DeepSeek-V4-Pro',
			'DeepSeek-V4.1-Flash',
			'DeepSeek-V4-Pro',
		]);
		expect(modelOption(result.options).values.map((value) => value.group)).toEqual([
			'deepseek-official',
			'deepseek-official',
			'deepseek-account',
			'deepseek-account',
		]);
	});

	it('maps the retired current value onto the canonical flash for the same provider', () => {
		const result = normalizeModelOptions(RAW_CONFIG_OPTIONS, { hideLegacy: true });
		expect(result.selected).toEqual(OFFICIAL_FLASH);
		expect(result.hiddenLegacy).toEqual(['deepseek-official/deepseek-v4-flash']);
		// `currentValue` stays the wire truth so the controller can detect a needed
		// session/set_config_option call by diffing it against `selected`.
		expect(modelOption(result.options).currentValue).toBe('["deepseek-official","deepseek-v4-flash"]');
		expect(parseModelValue(modelOption(result.options).currentValue)).toEqual(LEGACY_FLASH);
		expect(sameModelRef(parseModelValue(modelOption(result.options).currentValue), result.selected)).toBe(false);
	});

	it('lets a preferred model win when it exists in the options', () => {
		const result = normalizeModelOptions(RAW_CONFIG_OPTIONS, { hideLegacy: true, preferred: ACCOUNT_FLASH });
		expect(result.selected).toEqual(ACCOUNT_FLASH);
	});

	it('canonicalizes a preferred retired model id', () => {
		const result = normalizeModelOptions(RAW_CONFIG_OPTIONS, { hideLegacy: true, preferred: LEGACY_FLASH });
		expect(result.selected).toEqual(OFFICIAL_FLASH);
	});

	it('falls back to the current value when the preferred model is unavailable', () => {
		const result = normalizeModelOptions(RAW_CONFIG_OPTIONS, {
			hideLegacy: true,
			preferred: { provider: 'openai', model: 'gpt-5' },
		});
		expect(result.selected).toEqual(OFFICIAL_FLASH);
	});

	it('keeps retired options when hideLegacy is false but still selects the canonical model', () => {
		const result = normalizeModelOptions(RAW_CONFIG_OPTIONS, { hideLegacy: false });
		expect(modelRefs(result.options)).toEqual([LEGACY_FLASH, OFFICIAL_FLASH, OFFICIAL_PRO, ACCOUNT_FLASH, ACCOUNT_PRO]);
		expect(result.hiddenLegacy).toEqual([]);
		expect(result.selected).toEqual(OFFICIAL_FLASH);
	});

	it('leaves the reasoning option untouched', () => {
		const normalized = normalizeConfigOptions(RAW_CONFIG_OPTIONS);
		const expectedReasoning = normalized.find((option) => option.id === 'reasoning_effort');
		const result = normalizeModelOptions(RAW_CONFIG_OPTIONS, { hideLegacy: true });
		expect(result.options.find((option) => option.id === 'reasoning_effort')).toEqual(expectedReasoning);
	});

	it('accepts already normalized ConfigOption[] and produces the same result', () => {
		const normalizedInput = normalizeConfigOptions(RAW_CONFIG_OPTIONS);
		expect(normalizeModelOptions(normalizedInput, { hideLegacy: true })).toEqual(
			normalizeModelOptions(RAW_CONFIG_OPTIONS, { hideLegacy: true }),
		);
		const preferred: ModelRef = { provider: 'deepseek-account', model: 'deepseek-v4-pro' };
		expect(normalizeModelOptions(normalizedInput, { hideLegacy: false, preferred })).toEqual(
			normalizeModelOptions(RAW_CONFIG_OPTIONS, { hideLegacy: false, preferred }),
		);
		expect(toConfigOptions(normalizedInput)).toEqual(normalizedInput);
	});

	it('selects nothing extra when the current value is already canonical', () => {
		const raw = [{ ...MODEL_OPTION_RAW, currentValue: '["deepseek-official","deepseek-flash"]' }];
		const result = normalizeModelOptions(raw, { hideLegacy: true });
		expect(result.selected).toEqual(OFFICIAL_FLASH);
		expect(result.hiddenLegacy).toEqual(['deepseek-official/deepseek-v4-flash']);
		expect(sameModelRef(parseModelValue(modelOption(result.options).currentValue), result.selected)).toBe(true);
	});

	it('maps a retired current value on the deepseek-account provider too', () => {
		const raw = [
			{
				id: 'model',
				category: 'model',
				type: 'select',
				currentValue: '["deepseek-account","deepseek-v4-flash"]',
				options: [
					{ value: '["deepseek-account","deepseek-v4-flash"]', name: 'deepseek-v4-flash' },
					{ value: '["deepseek-account","deepseek-flash"]', name: 'DeepSeek-V4.1-Flash' },
				],
			},
		];
		const result = normalizeModelOptions(raw, { hideLegacy: true });
		expect(result.selected).toEqual(ACCOUNT_FLASH);
		expect(result.hiddenLegacy).toEqual(['deepseek-account/deepseek-v4-flash']);
	});

	it('hides the retired vision experiment and keeps the remaining choices', () => {
		const raw = [
			{
				id: 'model',
				name: 'Model',
				category: 'model',
				type: 'select',
				currentValue: '["deepseek-official","deepseek-v4-flash-vision-exp"]',
				options: [
					{
						group: 'deepseek-official',
						name: 'DeepSeek',
						options: [
							{ value: '["deepseek-official","deepseek-v4-flash-vision-exp"]', name: 'vision-exp' },
							{ value: '["deepseek-official","deepseek-v4-pro"]', name: 'DeepSeek-V4-Pro' },
						],
					},
				],
			},
		];
		const result = normalizeModelOptions(raw, { hideLegacy: true });
		expect(modelRefs(result.options)).toEqual([OFFICIAL_PRO]);
		expect(result.hiddenLegacy).toEqual(['deepseek-official/deepseek-v4-flash-vision-exp']);
		// No replacement exists for the current value, so nothing is recommended.
		expect(result.selected).toBeUndefined();
	});

	it('selects a retired value that is explicitly kept when hideLegacy is false', () => {
		const raw = [
			{
				id: 'model',
				category: 'model',
				type: 'select',
				currentValue: '["deepseek-official","deepseek-v4-flash-vision-exp"]',
				options: [{ value: '["deepseek-official","deepseek-v4-flash-vision-exp"]', name: 'vision-exp' }],
			},
		];
		const result = normalizeModelOptions(raw, { hideLegacy: false });
		expect(result.selected).toEqual({ provider: 'deepseek-official', model: 'deepseek-v4-flash-vision-exp' });
	});

	it('keeps values whose encoding is unknown instead of dropping them', () => {
		const raw = [
			{
				id: 'model',
				category: 'model',
				type: 'select',
				currentValue: '["deepseek-official","deepseek-flash"]',
				options: [
					{ value: 'plain-string', name: 'Unknown' },
					{ value: '["deepseek-official","deepseek-flash"]', name: 'DeepSeek-V4.1-Flash' },
				],
			},
		];
		const result = normalizeModelOptions(raw, { hideLegacy: true });
		expect(modelOption(result.options).values.map((value) => value.name)).toEqual([
			'Unknown',
			'DeepSeek-V4.1-Flash',
		]);
		expect(result.selected).toEqual(OFFICIAL_FLASH);
		expect(result.hiddenLegacy).toEqual([]);
	});

	it('returns safely when there is no model option', () => {
		const normalizedInput = normalizeConfigOptions([REASONING_OPTION_RAW]);
		for (const input of [normalizedInput, [REASONING_OPTION_RAW]]) {
			const result = normalizeModelOptions(input, { hideLegacy: true });
			expect(findConfigOption(result.options, 'model')).toBeUndefined();
			expect(result.options).toHaveLength(1);
			expect(result.selected).toBeUndefined();
			expect(result.hiddenLegacy).toEqual([]);
		}
	});

	it('tolerates unknown payload shapes', () => {
		for (const input of [undefined, null, 'nope', {}, 42, [], [null], [{ id: 7 }]]) {
			const result = normalizeModelOptions(input, { hideLegacy: true });
			expect(result).toEqual({ options: [], selected: undefined, hiddenLegacy: [] });
		}
	});
});
