/**
 * Turn ACP session config options into a model picker payload.
 *
 * Two shapes are accepted because the extension sees both:
 *  1. the raw `session/new` / `config_option_update` payload, where the model
 *     choices are grouped (`options: [{ group, name, options: [...] }]`);
 *  2. the already normalized `ConfigOption[]` stored on `ActiveSession`, where
 *     each entry carries `values: ConfigOptionValue[]` instead.
 *
 * The returned model option deliberately keeps the *server reported*
 * `currentValue` (wire truth) instead of rewriting it to the recommendation, so
 * the controller can decide whether `session/set_config_option` is still
 * needed:
 *
 * ```ts
 * const result = normalizeModelOptions(raw, { hideLegacy, preferred });
 * const current = parseModelValue(findConfigOption(result.options, 'model')?.currentValue);
 * if (result.selected && !sameModelRef(current, result.selected)) {
 * 	await session.setConfig('model', formatModelValue(result.selected));
 * }
 * ```
 *
 * This module is vscode-free so it can be unit tested with vitest.
 */
import { findConfigOption, normalizeConfigOptions } from '../acp/protocol';
import type { ConfigOption, ConfigOptionValue } from '../types';
import { canonicalModelRef, isLegacyModel, modelRefKey, type ModelRef } from './legacyModels';

export interface ModelSelectionOptions {
	/** Hide retired model ids from the picker (`deepseekHarness.hideLegacyModels`). */
	hideLegacy: boolean;
	/** Preferred model (`deepseekHarness.preferredModel` or DSH `agent-default-model`). */
	preferred?: ModelRef;
}

export interface ModelOptionsResult {
	/** Config options to render; only the model option is rewritten. */
	options: ConfigOption[];
	/** Model the picker should show, or `undefined` when nothing is selectable. */
	selected?: ModelRef;
	/** Retired model refs removed from the picker, as `provider/model`. */
	hiddenLegacy: string[];
}

/** Encode a model reference the way ACP `configOptions` values are encoded. */
export function formatModelValue(ref: ModelRef): string {
	return JSON.stringify([ref.provider, ref.model]);
}

/** Decode an ACP model option value; `undefined` for anything malformed. */
export function parseModelValue(value: unknown): ModelRef | undefined {
	// Some ACP versions wrap the string as `{ value: '...' }`.
	if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
		return parseModelValue((value as { value?: unknown }).value);
	}
	if (typeof value !== 'string') return undefined;
	const text = value.trim();
	if (!text.startsWith('[')) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!Array.isArray(parsed) || parsed.length !== 2) return undefined;
	const [provider, model] = parsed;
	if (typeof provider !== 'string' || typeof model !== 'string') return undefined;
	if (provider.length === 0 || model.length === 0) return undefined;
	return { provider, model };
}

/** Whether two model references are the same provider+model pair. */
export function sameModelRef(a: ModelRef | undefined, b: ModelRef | undefined): boolean {
	if (!a || !b) return false;
	return a.provider === b.provider && a.model === b.model;
}

function isConfigOptionLike(item: unknown): item is ConfigOption {
	if (typeof item !== 'object' || item === null) return false;
	const candidate = item as { id?: unknown; values?: unknown };
	return typeof candidate.id === 'string' && Array.isArray(candidate.values);
}

function cloneConfigOptionValue(value: unknown): ConfigOptionValue | undefined {
	if (typeof value !== 'object' || value === null) return undefined;
	const candidate = value as {
		value?: unknown;
		name?: unknown;
		description?: unknown;
		group?: unknown;
		groupName?: unknown;
	};
	if (typeof candidate.value !== 'string' || typeof candidate.name !== 'string') return undefined;
	return {
		value: candidate.value,
		name: candidate.name,
		description: typeof candidate.description === 'string' ? candidate.description : undefined,
		group: typeof candidate.group === 'string' ? candidate.group : undefined,
		groupName: typeof candidate.groupName === 'string' ? candidate.groupName : undefined,
	};
}

/** Rebuild an already normalized option into the exact shape `normalizeConfigOptions` produces. */
function cloneConfigOption(option: ConfigOption): ConfigOption {
	return {
		id: option.id,
		name: typeof option.name === 'string' ? option.name : option.id,
		category: typeof option.category === 'string' ? option.category : undefined,
		type: typeof option.type === 'string' ? option.type : 'select',
		currentValue: option.currentValue,
		values: option.values
			.map((value) => cloneConfigOptionValue(value))
			.filter((value): value is ConfigOptionValue => value !== undefined),
	};
}

/**
 * Accept either the raw ACP payload or normalized `ConfigOption[]`.
 *
 * Detection: array items carrying a `values` array are treated as already
 * normalized (the session manager's shape); everything else goes through
 * `normalizeConfigOptions`.
 */
export function toConfigOptions(raw: unknown): ConfigOption[] {
	if (Array.isArray(raw) && raw.some((item) => isConfigOptionLike(item))) {
		const result: ConfigOption[] = [];
		for (const item of raw) {
			if (isConfigOptionLike(item)) result.push(cloneConfigOption(item));
		}
		return result;
	}
	return normalizeConfigOptions(raw);
}

function containsModel(available: readonly ModelRef[], ref: ModelRef): boolean {
	return available.some((item) => sameModelRef(item, ref));
}

/** Try the canonical id first, then the literal one (covers `hideLegacy: false`). */
function pickAvailable(available: readonly ModelRef[], ref: ModelRef): ModelRef | undefined {
	const canonical = canonicalModelRef(ref);
	if (canonical && containsModel(available, canonical)) return canonical;
	if (containsModel(available, ref)) return ref;
	return undefined;
}

/**
 * Filter retired models and decide which model the picker should show.
 *
 * Selection priority:
 *  1. `opts.preferred` when it exists in the (filtered) options, canonicalized;
 *  2. the server reported `currentValue`, canonicalized when it is a retired
 *     alias and the replacement exists for the same provider;
 *  3. `undefined` (nothing selectable) — the caller keeps the server state.
 *
 * Options other than `model` (e.g. `reasoning_effort`) are returned untouched.
 */
export function normalizeModelOptions(raw: unknown, opts: ModelSelectionOptions): ModelOptionsResult {
	const normalized = toConfigOptions(raw);
	const modelOption = findConfigOption(normalized, 'model');
	if (!modelOption) return { options: normalized, selected: undefined, hiddenLegacy: [] };

	const hiddenLegacy: string[] = [];
	const values: ConfigOptionValue[] = [];
	const available: ModelRef[] = [];
	for (const value of modelOption.values) {
		const ref = parseModelValue(value.value);
		if (!ref) {
			// Unknown value encoding: keep it, it cannot be classified safely.
			values.push(value);
			continue;
		}
		if (isLegacyModel(ref.provider, ref.model)) {
			const canonical = canonicalModelRef(ref);
			if (!opts.hideLegacy) {
				values.push(value);
				available.push(canonical ?? ref);
				continue;
			}
			hiddenLegacy.push(modelRefKey(ref));
			continue;
		}
		values.push(value);
		available.push(ref);
	}

	let selected: ModelRef | undefined;
	if (opts.preferred) selected = pickAvailable(available, opts.preferred);
	if (!selected) {
		const current = parseModelValue(modelOption.currentValue);
		if (current) selected = pickAvailable(available, current);
	}

	// Keep `currentValue` as reported by the agent: callers diff it against
	// `selected` to know whether a `session/set_config_option` call is needed.
	const filtered: ConfigOption = { ...modelOption, values };
	const options = normalized.map((option) => (option === modelOption ? filtered : option));
	return { options, selected, hiddenLegacy };
}
