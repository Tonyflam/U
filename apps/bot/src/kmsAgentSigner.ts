/**
 * KMS-backed `AgentSigner` for `submitMirror`.
 *
 * Looks up the user's sealed agent key + main wallet, decrypts the agent
 * private key inside `withAgentSigner` (zeroized on exit), and signs the
 * HL L1 action with `signL1Action`. The plaintext key never leaves the
 * `fn` callback.
 *
 * Production wires the lookup to `DrizzleBotRepo`; tests pass a fake.
 */
import { signL1Action } from '@whalepod/sdk';
import type { HlOrderAction, HlSignature } from '@whalepod/sdk';
import { withAgentSigner } from '@whalepod/vault';
import type { SealedAgentKey, VaultKms } from '@whalepod/vault';
import type { Address } from '@whalepod/schema';
import type { AgentSigner } from './submitMirror.js';

export interface AgentKeyRow {
  readonly sealed: SealedAgentKey;
}

export interface AgentKeyLookup {
  /** Returns the sealed agent-key row, or undefined if the user is unknown. */
  forUser(userId: string): Promise<AgentKeyRow | undefined>;
}

export interface KmsAgentSignerOptions {
  readonly kms: VaultKms;
  readonly keys: AgentKeyLookup;
  readonly isMainnet: boolean;
}

export class KmsAgentSigner implements AgentSigner {
  private readonly kms: VaultKms;
  private readonly keys: AgentKeyLookup;
  private readonly isMainnet: boolean;

  constructor(options: KmsAgentSignerOptions) {
    this.kms = options.kms;
    this.keys = options.keys;
    this.isMainnet = options.isMainnet;
  }

  async sign(input: {
    readonly userId: string;
    readonly agentAddress: Address;
    readonly action: HlOrderAction;
    readonly nonce: number;
  }): Promise<HlSignature> {
    const row = await this.keys.forUser(input.userId);
    if (!row) {
      throw new Error(`agent key not found for user ${input.userId}`);
    }
    return withAgentSigner(
      {
        sealed: row.sealed,
        kms: this.kms,
        encryptionContext: { userId: input.userId, purpose: 'agent-key' },
      },
      async (account) => {
        if (account.address.toLowerCase() !== input.agentAddress) {
          throw new Error(
            `agent key address mismatch: stored=${account.address.toLowerCase()} expected=${input.agentAddress}`,
          );
        }
        return signL1Action({
          account,
          action: input.action,
          nonce: input.nonce,
          isMainnet: this.isMainnet,
        });
      },
    );
  }
}
