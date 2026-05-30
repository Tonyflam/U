/**
 * @whalepod/config — shared environment, secrets, and logging-redaction config.
 *
 * Intentionally tiny surface. Apps import only what they need.
 */
export { parseEnv, commonEnv, type CommonEnv } from './env.js';
export { KmsClient, type KmsClientOptions, zeroize } from './kms.js';
export { REDACT_PATHS } from './redact.js';
