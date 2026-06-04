/**
 * Cheap "is this 0x address actually a real HL trader?" probe.
 *
 * Used by /follow to reject obvious mistakes (typo'd address, dead/empty
 * wallet, random hex). If the address has both zero open positions AND
 * zero recent fills, we refuse. Otherwise we let the user follow — even
 * a wallet that's currently flat may have a real trading history.
 *
 * One HL `userFills` call. Failure to reach HL = fail OPEN so an HL
 * outage doesn't block onboarding. The decision is just an extra UX
 * guard, not a security control.
 */
import type { HttpHlTransport } from '@whalepod/sdk';
import type { Address } from '@whalepod/schema';

export interface WhaleProbe {
  forWhale(address: Address): Promise<{ readonly isReal: boolean; readonly fillCount: number }>;
}

interface RawFill {
  readonly time?: number;
}

export class HlWhaleProbe implements WhaleProbe {
  constructor(private readonly transport: Pick<HttpHlTransport, 'info'>) {}

  async forWhale(
    address: Address,
  ): Promise<{ readonly isReal: boolean; readonly fillCount: number }> {
    try {
      const fills = await this.transport.info<readonly RawFill[]>({
        type: 'userFills',
        user: address,
      });
      const count = Array.isArray(fills) ? fills.length : 0;
      return { isReal: count > 0, fillCount: count };
    } catch {
      // Fail open — don't block /follow on an HL hiccup.
      return { isReal: true, fillCount: -1 };
    }
  }
}
