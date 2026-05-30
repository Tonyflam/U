/**
 * Pino redaction paths shared by every WhalePod service.
 *
 * Logs MUST be passed through pino with these paths redacted. Logs are the
 * #1 accidental leak channel; treat the list as security-critical.
 *
 * Pattern syntax: https://getpino.io/#/docs/redaction
 */
export const REDACT_PATHS: readonly string[] = [
  // Auth + tokens
  '*.password',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.apiKey',
  '*.authorization',
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  'headers.cookie',

  // Wallet / crypto material
  '*.privateKey',
  '*.private_key',
  '*.secretKey',
  '*.secret_key',
  '*.mnemonic',
  '*.seed',
  '*.agentKey',
  '*.agent_key',
  '*.signature',
  '*.sig',

  // Hyperliquid / EIP-712
  '*.r',
  '*.s',
  '*.v',

  // KMS
  '*.Plaintext',
  '*.CiphertextBlob',

  // Telegram
  '*.botToken',
  '*.tgInitData',
  '*.initData',
] as const;
