/**
 * Retired DeepSeek model ids and their replacements.
 *
 * Why this exists: the ACP profile ships a factory patch that selects
 * `deepseek-v4-flash`, and the bundled catalog still advertises that retired id
 * next to `deepseek-flash` (display name `DeepSeek-V4.1-Flash`). The result was
 * a duplicated looking model dropdown plus a default the service no longer
 * serves. Keeping the mapping here — instead of in the UI or the controller —
 * gives the extension and its tests a single source of truth.
 *
 * The module is vscode-free so it can be unit tested with vitest.
 */

/** A `(provider, model)` pair, matching the ACP `configOptions` value encoding. */
export interface ModelRef {
	provider: string;
	model: string;
}

/** Providers whose catalogs carried the retired model ids. */
export const LEGACY_MODEL_PROVIDERS: readonly string[] = ['deepseek-official', 'deepseek-account'];

/**
 * Retired model id -> replacement id.
 *
 * `null` means the model is gone with no replacement, so it is hidden even when
 * legacy models are otherwise kept.
 */
export const LEGACY_MODEL_ALIASES: Readonly<Record<string, string | null>> = {
	'deepseek-v4-flash': 'deepseek-flash',
	'deepseek-v4-flash-vision-exp': null,
};

/** Whether `(provider, model)` points at a retired model id of a known provider. */
export function isLegacyModel(provider: string, model: string): boolean {
	if (!LEGACY_MODEL_PROVIDERS.includes(provider)) return false;
	return Object.prototype.hasOwnProperty.call(LEGACY_MODEL_ALIASES, model);
}

/**
 * Canonical model id for a `(provider, model)` pair.
 *
 * Returns the replacement id for retired aliases, the unchanged model id for
 * live models, and `null` when the model is retired without a replacement (the
 * caller should hide it).
 */
export function canonicalModelId(provider: string, model: string): string | null {
	if (!isLegacyModel(provider, model)) return model;
	const replacement = LEGACY_MODEL_ALIASES[model];
	return typeof replacement === 'string' ? replacement : null;
}

/** Canonical form of a model reference; `undefined` when it should be hidden. */
export function canonicalModelRef(ref: ModelRef): ModelRef | undefined {
	const model = canonicalModelId(ref.provider, ref.model);
	return model === null ? undefined : { provider: ref.provider, model };
}

/** Stable `provider/model` label used for logs, settings and test assertions. */
export function modelRefKey(ref: ModelRef): string {
	return `${ref.provider}/${ref.model}`;
}
