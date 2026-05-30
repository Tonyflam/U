'use client';

import { useState } from 'react';
import { useAccount, useConnect, useDisconnect, useSignTypedData, useSwitchChain } from 'wagmi';

interface StartResponse {
  provisionalId: string;
  agentAddress: string;
  approveAgent: { typedData: Record<string, unknown> };
  approveBuilderFee: { typedData: Record<string, unknown> };
}

type Step = 'connect' | 'config' | 'sign' | 'done' | 'error';

interface State {
  step: Step;
  error?: string;
  start?: StartResponse;
  userId?: string;
}

const TG_USER_ID_FROM_URL = (): string | null => {
  if (typeof window === 'undefined') return null;
  const url = new URL(window.location.href);
  return url.searchParams.get('tg');
};

export default function OnboardPage(): JSX.Element {
  const { address, isConnected } = useAccount();
  const { connect, connectors, isPending: connecting } = useConnect();
  const { disconnect } = useDisconnect();
  const { signTypedDataAsync } = useSignTypedData();
  const { switchChainAsync } = useSwitchChain();

  const [maxFeeBps, setMaxFeeBps] = useState(5);
  const [equityFloorUsd, setEquityFloorUsd] = useState('0');
  const [state, setState] = useState<State>({ step: 'connect' });
  const [busy, setBusy] = useState(false);

  async function beginOnboarding(): Promise<void> {
    if (!address) return;
    setBusy(true);
    setState({ step: 'sign' });
    try {
      const tgUserId = TG_USER_ID_FROM_URL();
      if (!tgUserId) throw new Error('Open this page from your Telegram bot link.');
      const startRes = await fetch('/api/onboarding/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          tgUserId,
          mainWallet: address,
          equityFloorUsd,
          approvedMaxFeeTenthsBp: maxFeeBps * 10,
        }),
      });
      if (!startRes.ok) {
        const j = (await startRes.json().catch(() => ({}))) as { message?: string };
        throw new Error(j.message ?? `start failed: ${String(startRes.status)}`);
      }
      const start = (await startRes.json()) as StartResponse;
      setState({ step: 'sign', start });

      const td1 = start.approveAgent.typedData as {
        domain: Record<string, unknown>;
        types: Record<string, unknown>;
        primaryType: string;
        message: Record<string, unknown>;
      };
      const td2 = start.approveBuilderFee.typedData as typeof td1;
      const targetChainId = Number(
        (td1.domain as { chainId?: number | string }).chainId ?? 0,
      );
      if (targetChainId > 0) {
        try {
          await switchChainAsync({ chainId: targetChainId });
        } catch (e) {
          throw new Error(
            `Please switch your wallet to chain ${String(targetChainId)} (Arbitrum) and try again.`,
          );
        }
      }
      const approveAgentSig = await signTypedDataAsync(td1 as never);
      const approveBuilderFeeSig = await signTypedDataAsync(td2 as never);

      const completeRes = await fetch('/api/onboarding/complete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          provisionalId: start.provisionalId,
          approveAgentSig,
          approveBuilderFeeSig,
        }),
      });
      if (!completeRes.ok) {
        const j = (await completeRes.json().catch(() => ({}))) as { message?: string };
        throw new Error(j.message ?? `complete failed: ${String(completeRes.status)}`);
      }
      const out = (await completeRes.json()) as { userId: string };
      setState({ step: 'done', userId: out.userId });
    } catch (err) {
      setState({ step: 'error', error: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ maxWidth: 640, margin: '0 auto', padding: 32 }}>
      <h1>Onboard</h1>

      {!isConnected ? (
        <section>
          <p>Connect the wallet you use to trade on Hyperliquid.</p>
          {connectors.map((c) => (
            <button
              key={c.uid}
              type="button"
              onClick={() => connect({ connector: c })}
              disabled={connecting}
              style={btn}
            >
              {connecting ? 'Connecting…' : `Connect ${c.name}`}
            </button>
          ))}
        </section>
      ) : (
        <section>
          <p>
            Connected: <code>{address}</code>{' '}
            <button type="button" onClick={() => disconnect()} style={linkBtn}>
              disconnect
            </button>
          </p>

          {state.step !== 'done' && state.step !== 'error' && (
            <fieldset style={{ border: '1px solid #333', padding: 16, marginTop: 16 }}>
              <legend>Settings</legend>
              <label style={{ display: 'block', marginBottom: 12 }}>
                Max builder fee (bps, max 10):{' '}
                <input
                  type="number"
                  min={1}
                  max={10}
                  value={maxFeeBps}
                  onChange={(e) => setMaxFeeBps(Number(e.target.value))}
                  style={inp}
                />
              </label>
              <label style={{ display: 'block' }}>
                Equity floor (USD, never trade below):{' '}
                <input
                  type="text"
                  value={equityFloorUsd}
                  onChange={(e) => setEquityFloorUsd(e.target.value)}
                  style={inp}
                />
              </label>
            </fieldset>
          )}

          {state.step === 'done' ? (
            <p style={{ color: '#34d399', marginTop: 16 }}>
              All set. Your user id: <code>{state.userId}</code>. Return to Telegram.
            </p>
          ) : state.step === 'error' ? (
            <p style={{ color: '#f87171', marginTop: 16 }}>Error: {state.error}</p>
          ) : (
            <button
              type="button"
              onClick={() => void beginOnboarding()}
              disabled={busy}
              style={btn}
            >
              {busy ? 'Working…' : 'Sign and authorize'}
            </button>
          )}
        </section>
      )}
    </main>
  );
}

const btn: React.CSSProperties = {
  padding: '10px 18px',
  marginTop: 16,
  background: '#3b82f6',
  color: 'white',
  border: 'none',
  borderRadius: 6,
  cursor: 'pointer',
};
const linkBtn: React.CSSProperties = {
  background: 'transparent',
  color: '#93c5fd',
  border: 'none',
  cursor: 'pointer',
  padding: 0,
};
const inp: React.CSSProperties = {
  marginLeft: 8,
  padding: '4px 8px',
  background: '#111',
  color: 'white',
  border: '1px solid #333',
  borderRadius: 4,
};
