/**
 * Telegram alerter for mirror failures.
 *
 * Wired into `mirrorConsumer` so a user is told in-app whenever a whale
 * fill is detected but the mirror could not be placed (risk block, KMS
 * sign error, exchange reject, transport hiccup). Without this the user
 * sees "No mirrored fills yet" and has no idea why.
 *
 * Best-effort: errors are logged and swallowed.
 */
import type { Logger } from 'pino';
import type { Api } from 'grammy';
import type { MirrorAlerter } from './mirrorConsumer.js';
import type { MirrorOutcome } from './submitMirror.js';
import type { TgUserIdResolver } from './fillPublisher.js';

export interface TelegramMirrorAlerterOptions {
  readonly api: Api;
  readonly resolver: TgUserIdResolver;
  readonly log: Logger;
}

export class TelegramMirrorAlerter implements MirrorAlerter {
  private readonly api: Api;
  private readonly resolver: TgUserIdResolver;
  private readonly log: Logger;

  constructor(opts: TelegramMirrorAlerterOptions) {
    this.api = opts.api;
    this.resolver = opts.resolver;
    this.log = opts.log;
  }

  async alert(input: {
    readonly userId: string;
    readonly whaleAddress: string;
    readonly coin: string | number;
    readonly side: 'B' | 'S';
    readonly outcome: MirrorOutcome;
  }): Promise<void> {
    let tgUserId: string | null;
    try {
      tgUserId = await this.resolver.tgUserIdByUserId(input.userId);
    } catch (err) {
      this.log.warn({ err, userId: input.userId }, 'mirror-alerter: tg lookup failed');
      return;
    }
    if (tgUserId === null) {
      this.log.warn({ userId: input.userId }, 'mirror-alerter: no tgUserId for user');
      return;
    }
    const text = renderAlert(input.whaleAddress, input.coin, input.side, input.outcome);
    if (text === undefined) return;
    try {
      await this.api.sendMessage(tgUserId, text);
    } catch (err) {
      this.log.warn({ err, tgUserId }, 'mirror-alerter: sendMessage failed');
    }
  }
}

function renderAlert(
  whaleAddress: string,
  coin: string | number,
  side: 'B' | 'S',
  outcome: MirrorOutcome,
): string | undefined {
  const sideText = side === 'B' ? 'BUY' : 'SELL';
  const coinText = typeof coin === 'number' ? `asset #${coin.toString()}` : coin;
  const header = `⚠️ Mirror skipped — whale \`${whaleAddress}\` opened ${sideText} ${coinText}`;

  if (outcome.kind === 'risk_blocked') {
    const reason = friendlyRiskReason(outcome.reason);
    const detailLine = outcome.detail !== undefined ? `\nDetail: ${outcome.detail}` : '';
    return [header, '', `Reason: ${reason}${detailLine}`, '', fixHint(outcome.reason)].join('\n');
  }
  if (outcome.kind === 'exchange_error') {
    if (/minimum value of \$10/i.test(outcome.message)) {
      return [
        `ℹ️ Whale \`${whaleAddress}\` opened ${sideText} ${coinText}, but the trade scaled to your cap was below Hyperliquid's $10 minimum order size.`,
        '',
        'Nothing to do — your cap is being enforced. Raise it with /setcap if you want to mirror smaller-priced whales.',
      ].join('\n');
    }
    if (/could not immediately match against any resting orders/i.test(outcome.message)) {
      return [
        `ℹ️ Whale \`${whaleAddress}\` opened ${sideText} ${coinText}, but the book was too thin for an IOC fill right now.`,
        '',
        'WhalePod sends reduce-only IOC, so when the book is empty at your price we skip rather than rest a limit order. Next entry from this whale will be tried fresh.',
      ].join('\n');
    }
    return [
      header,
      '',
      `Hyperliquid rejected the order: ${outcome.message}`,
      '',
      'Check your account on https://app.hyperliquid.xyz/ — common causes are insufficient margin, market closed, or invalid tick size.',
    ].join('\n');
  }
  if (outcome.kind === 'transport_error') {
    return [
      header,
      '',
      `Could not submit the order: ${outcome.message}`,
      '',
      'This is usually a transient network or signing-service issue. The next whale fill will be tried fresh.',
    ].join('\n');
  }
  return undefined;
}

function friendlyRiskReason(reason: string): string {
  switch (reason) {
    case 'geo_unknown':
      return 'Your region could not be verified.';
    case 'geo_blocked':
      return 'Your region is not supported.';
    case 'slippage_exceeded':
      return 'Whale price moved too far from current market price.';
    case 'equity_unknown':
      return 'Could not read your Hyperliquid account balance.';
    case 'equity_floor_breach':
      return 'Your perps account balance is at or below the configured floor.';
    case 'daily_notional_exceeded':
      return 'You hit the 24-hour mirror notional cap.';
    default:
      return reason;
  }
}

function fixHint(reason: string): string {
  switch (reason) {
    case 'equity_floor_breach':
      return 'Fix: deposit USDC into your Hyperliquid perps account (USDC must be in perps, not spot).';
    case 'slippage_exceeded':
      return 'Fix: raise RISK_MAX_SLIPPAGE_BPS or wait for the next whale entry.';
    case 'daily_notional_exceeded':
      return 'Fix: raise RISK_MAX_DAILY_NOTIONAL_USD or wait 24h.';
    case 'equity_unknown':
      return 'Fix: ensure Hyperliquid API is reachable; check the bot logs.';
    default:
      return 'Tap /mirrors to review settings.';
  }
}
