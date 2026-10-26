/**
 * Model catalog hygiene: retired model ids, model option normalization and the
 * user's DSH default model preference.
 *
 * Deep imports (`./legacyModels`) are fine too; this barrel keeps controller
 * integration to a single import.
 */
export * from './dshModelPreference';
export * from './legacyModels';
export * from './modelOptions';
