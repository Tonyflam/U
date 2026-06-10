'use client';

import { useEffect, useState } from 'react';
import { useAccount, useConfig, useDisconnect } from 'wagmi';
import { getConnectorClient } from 'wagmi/actions';
import { arbitrum } from 'wagmi/chains';
import { signTypedData as viemSignTypedData } from 'viem/actions';
import { useAppKit, useDisconnect as useAppKitDisconnect } from '@reown/appkit/react';

interface StartResponse {
  provisionalId: string;
  agentAddress: string;
  approveAgent: { typedData: Record<string, unknown> };
  approveBuilderFee: { typedData: Record<string, unknown> };
}

type Step = 'loading' | 'noTg' | 'connect' | 'config' | 'sign' | 'done' | 'already' | 'error';

interface OnboardedInfo {
  mainWallet: string;
  agentAddress: string;
  feeBps: number;
}

interface State {
  step: Step;
  error?: string;
  start?: StartResponse;
  userId?: string;
  info?: OnboardedInfo;
}

function getTgUserId(): string | null {
  if (typeof window === 'undefined') return null;
  const urlTg = new URL(window.location.href).searchParams.get('tg');
  if (urlTg) return urlTg;
  // Fall back to Telegram WebApp init data — set when launched via menu button.
  const tg = (
    window as unknown as {
      Telegram?: {
        WebApp?: { initDataUnsafe?: { user?: { id?: number | string } } };
      };
    }
  ).Telegram?.WebApp;
  const id = tg?.initDataUnsafe?.user?.id;
  if (id != null) return String(id);
  return null;
}

function shortAddr(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

// WalletConnect stores the wallet the user picked (its deep-link href + name)
// under this localStorage key when connecting on mobile. We reuse it to
// foreground that exact wallet on demand.
const WC_DEEPLINK_KEY = 'WALLETCONNECT_DEEPLINK_CHOICE';

/**
 * Foreground the connected mobile wallet so it shows the pending signature.
 *
 * Inside the Telegram Mini App webview, WalletConnect's automatic
 * `handleDeeplinkRedirect` (a bare `window.open` to the wallet) is swallowed by
 * Telegram and the wallet never comes forward — so the sign request sits on the
 * relay unseen and the UI appears to "hang at Approve". This re-opens the
 * wallet from a real user gesture, which Telegram does honour. Must be called
 * synchronously inside an onClick handler (no awaits before it) or the webview
 * will block the navigation.
 */
function openConnectedWallet(): void {
  if (typeof window === 'undefined') return;
  let href = '';
  try {
    const raw = window.localStorage.getItem(WC_DEEPLINK_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { href?: string };
      if (typeof parsed.href === 'string') href = parsed.href;
    }
  } catch {
    // ignore — fall through to the generic fallback below
  }
  // Fallback: MetaMask universal link works for the common case and harmlessly
  // no-ops if the user is on a different wallet that ignores it.
  if (!href) href = 'https://metamask.app.link';

  const tg = (window as unknown as { Telegram?: { WebApp?: { openLink?: (u: string) => void } } })
    .Telegram?.WebApp;
  const isHttp = href.startsWith('http://') || href.startsWith('https://');
  if (isHttp && tg?.openLink) {
    // Telegram only opens http(s) links; this escapes the webview to the
    // wallet's universal link, which the OS then hands to the wallet app.
    tg.openLink(href);
    return;
  }
  if (isHttp) {
    window.open(href, '_blank', 'noreferrer noopener');
    return;
  }
  // Custom scheme (e.g. metamask://) — a direct location change launches the app.
  window.location.href = href;
}

interface TypedData {
  domain: Record<string, unknown>;
  types: Record<string, unknown>;
  primaryType: string;
  message: Record<string, unknown>;
}

/**
 * True when an EIP-1193 error indicates the WalletConnect session is gone (vs.
 * the user simply rejecting). WalletConnect surfaces these as "Please call
 * connect() before request()", "No matching key", "session topic doesn't
 * exist", etc. We only attempt a reconnect for these — a user rejection must
 * propagate so we don't loop.
 */
function isSessionError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes('connect() before request') ||
    msg.includes('no matching key') ||
    msg.includes("session topic doesn't exist") ||
    msg.includes('session topic') ||
    msg.includes('missing or invalid') ||
    msg.includes('please call connect') ||
    msg.includes('no active session')
  );
}

export default function OnboardClient(): JSX.Element {
  const { address, isConnected, connector } = useAccount();
  const { disconnect } = useDisconnect();
  const { disconnect: appkitDisconnect } = useAppKitDisconnect();
  const { open } = useAppKit();
  // wagmi config — used to drive signing through wagmi's own connector-client
  // resolution (the same provider it uses for every other working call), which
  // holds the live WalletConnect session after AppKit reconnects.
  const config = useConfig();

  // Builder fee is locked to the protocol default (5 bps). Cap on-chain is 10 bps.
  // Users do not choose this — it's the WhalePod take rate.
  const maxFeeTenthsBp = 50;
  const [equityFloorUsd, setEquityFloorUsd] = useState('0');
  const [state, setState] = useState<State>({ step: 'loading' });
  const [busy, setBusy] = useState(false);
  const [signStep, setSignStep] = useState<0 | 1 | 2>(0);

  useEffect(() => {
    const tg = (
      window as unknown as {
        Telegram?: {
          WebApp?: {
            ready?: () => void;
            expand?: () => void;
            setHeaderColor?: (c: string) => void;
          };
        };
      }
    ).Telegram?.WebApp;
    tg?.ready?.();
    tg?.expand?.();
    tg?.setHeaderColor?.('#0b0e14');
  }, []);

  // Resolve TG user id (URL param OR Telegram.WebApp init data) — retry up to
  // ~1.5s because the SDK script may not be ready when this effect first runs.
  // Then check status against the DB.
  useEffect(() => {
    let cancelled = false;
    let attempts = 0;
    const maxAttempts = 15;

    async function resolveAndCheck(): Promise<void> {
      const tgUserId = getTgUserId();
      if (!tgUserId) {
        attempts += 1;
        if (attempts < maxAttempts && !cancelled) {
          setTimeout(() => void resolveAndCheck(), 100);
          return;
        }
        if (!cancelled) setState({ step: 'noTg' });
        return;
      }
      try {
        const r = await fetch(`/api/onboarding/status?tg=${encodeURIComponent(tgUserId)}`, {
          cache: 'no-store',
        });
        if (!r.ok) {
          if (!cancelled) setState({ step: 'connect' });
          return;
        }
        const j = (await r.json()) as { onboarded: boolean } & OnboardedInfo;
        if (cancelled) return;
        if (j.onboarded) {
          setState({
            step: 'already',
            info: {
              mainWallet: j.mainWallet,
              agentAddress: j.agentAddress,
              feeBps: j.feeBps,
            },
          });
        } else {
          setState({ step: 'connect' });
        }
      } catch {
        if (!cancelled) setState({ step: 'connect' });
      }
    }

    void resolveAndCheck();
    return () => {
      cancelled = true;
    };
  }, []);

  // Tear down BOTH the Reown AppKit/WalletConnect session and the wagmi
  // connector. On mobile, wagmi's disconnect() alone leaves the AppKit
  // WalletConnect session alive, so useAccount() keeps reporting connected and
  // the UI never updates — the disconnect control appears to do nothing.
  // AppKit's async disconnect clears the session for real; the wagmi call is a
  // belt-and-braces fallback for the injected/desktop path.
  async function tearDownWallet(): Promise<void> {
    try {
      await appkitDisconnect();
    } catch {
      // session may already be gone — fall through to the wagmi fallback
    }
    try {
      disconnect();
    } catch {
      // ignore wallet disconnect errors
    }
  }

  // Top-of-app wallet pill. Disconnects the wallet; the render falls back to
  // the connect screen once `isConnected` flips. Guarded by `busy` so a
  // double-tap on mobile can't stack teardowns.
  async function handleDisconnectWallet(): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      await tearDownWallet();
      setSignStep(0);
    } finally {
      setBusy(false);
    }
  }

  async function disconnectAndRestart(): Promise<void> {
    const tgUserId = getTgUserId();
    if (!tgUserId) return;
    setBusy(true);
    try {
      await fetch('/api/onboarding/disconnect', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tgUserId }),
      });
      await tearDownWallet();
      setSignStep(0);
      setState({ step: 'connect' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setState({ step: 'error', error: `Disconnect failed: ${msg}` });
    } finally {
      setBusy(false);
    }
  }

  async function beginOnboarding(): Promise<void> {
    if (!address) return;
    setBusy(true);
    setSignStep(0);
    setState({ step: 'sign' });
    try {
      const tgUserId = getTgUserId();
      if (!tgUserId) throw new Error('Open this page from your Telegram bot link to continue.');

      const startRes = await fetch('/api/onboarding/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          tgUserId,
          mainWallet: address,
          equityFloorUsd,
          approvedMaxFeeTenthsBp: maxFeeTenthsBp,
        }),
      });
      if (!startRes.ok) {
        const j = (await startRes.json().catch(() => ({}))) as {
          message?: string;
          detail?: string;
          error?: string;
        };
        throw new Error(
          j.detail ?? j.message ?? j.error ?? `start failed: ${String(startRes.status)}`,
        );
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

      // Sign HL's two OFF-CHAIN approvals using wagmi's canonical signing path,
      // not a hand-rolled raw provider call. `getConnectorClient` resolves the
      // exact provider wagmi uses for every working call (the WalletConnect
      // UniversalProvider that holds the live session after AppKit reconnect)
      // and builds a viem client; viem then issues `eth_signTypedData_v4`, which
      // is what fires WalletConnect's deep-link to foreground the wallet on
      // mobile. Two mobile-specific details:
      //  1) `assertChainId: false` skips wagmi's connector-chain guard, which
      //     throws "connector (id: undefined) does not match the connection's
      //     chain (id: 42161)" because mobile MetaMask over WalletConnect often
      //     reports no active chain. HL approvals are off-chain (the Arbitrum
      //     chainId lives inside the signed domain) so the wallet's live chain
      //     is irrelevant.
      //  2) If the session genuinely dropped (page reload on app-switch back
      //     from the wallet), the first request throws a session error; we
      //     reconnect once to re-establish it, then retry.
      if (!connector) {
        throw new Error('Wallet connection lost — tap "Connect wallet" and try again.');
      }
      const signer = address as `0x${string}`;
      const activeConnector = connector;

      async function signOnce(td: TypedData): Promise<`0x${string}`> {
        const client = await getConnectorClient(config, {
          account: signer,
          chainId: arbitrum.id,
          assertChainId: false,
        });
        // viem derives the EIP712Domain entry from the domain fields, so strip
        // any EIP712Domain the server may have included to avoid a redefinition.
        const types = { ...(td.types as Record<string, unknown>) };
        delete types.EIP712Domain;
        return viemSignTypedData(client, {
          account: signer,
          domain: td.domain,
          types,
          primaryType: td.primaryType,
          message: td.message,
        } as Parameters<typeof viemSignTypedData>[1]);
      }

      async function signWithSession(td: TypedData): Promise<`0x${string}`> {
        try {
          return await signOnce(td);
        } catch (err) {
          if (!isSessionError(err)) throw err;
          // Session dropped — re-establish it once (re-opens the wallet to
          // approve), bounded so a stalled reconnect can't hang forever, then
          // retry the signature on the now-live session.
          await Promise.race([
            activeConnector.connect(),
            new Promise((resolve) => setTimeout(resolve, 60000)),
          ]).catch(() => undefined);
          return signOnce(td);
        }
      }

      setSignStep(1);
      const approveAgentSig = await signWithSession(td1);
      setSignStep(2);
      const approveBuilderFeeSig = await signWithSession(td2);

      const completeRes = await fetch('/api/onboarding/complete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          provisionalId: start.provisionalId,
          approveAgentSig,
          approveBuilderFeeSig,
          tgUserId,
        }),
      });
      if (!completeRes.ok) {
        const j = (await completeRes.json().catch(() => ({}))) as {
          message?: string;
          detail?: string;
          error?: string;
        };
        throw new Error(
          j.detail ?? j.message ?? j.error ?? `complete failed: ${String(completeRes.status)}`,
        );
      }
      const out = (await completeRes.json()) as { userId: string };
      setState({ step: 'done', userId: out.userId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setState({ step: 'error', error: msg });
    } finally {
      setBusy(false);
    }
  }

  function returnToTg(): void {
    const tg = (window as unknown as { Telegram?: { WebApp?: { close?: () => void } } }).Telegram
      ?.WebApp;
    if (tg?.close) tg.close();
    else window.close();
  }

  return (
    <main className="wrap">
      <div className="bg" />
      <div className="card">
        <header className="hd">
          <div className="logo">
            <img src="/logo.png" alt="WhalePod" width={28} height={28} />
            <span>WhalePod</span>
          </div>
          {isConnected && address ? (
            <button
              className="pill"
              type="button"
              disabled={busy}
              onClick={() => void handleDisconnectWallet()}
              title="Disconnect"
            >
              {shortAddr(address)}
            </button>
          ) : null}
        </header>

        {state.step === 'loading' ? (
          <section className="intro" style={{ textAlign: 'center', padding: '40px 0' }}>
            <div className="spinner" />
            <p className="muted small">Checking your account…</p>
          </section>
        ) : state.step === 'noTg' ? (
          <section className="intro" style={{ textAlign: 'center' }}>
            <img
              src="/logo.png"
              alt="WhalePod"
              width={56}
              height={56}
              style={{
                width: 56,
                height: 56,
                borderRadius: 12,
                margin: '0 auto 16px',
                display: 'block',
              }}
            />
            <h2>Open WhalePod from Telegram</h2>
            <p className="lede" style={{ marginTop: 8 }}>
              WhalePod is a Telegram mini-app. Open it from the bot so we can link your wallet to
              your Telegram account.
            </p>
            <a
              className="cta"
              href="https://t.me/whalepod_bot"
              target="_blank"
              rel="noopener"
              style={{ display: 'inline-block', textDecoration: 'none', textAlign: 'center' }}
            >
              Open @whalepod_bot →
            </a>
            <p className="muted small" style={{ marginTop: 12 }}>
              Already onboarded? Open the bot and tap the menu button.
            </p>
          </section>
        ) : state.step === 'already' && state.info ? (
          <section className="done">
            <div className="check">✓</div>
            <h2>You&apos;re already set up.</h2>
            <p>
              Wallet <code>{shortAddr(state.info.mainWallet)}</code>
              <br />
              Agent <code>{shortAddr(state.info.agentAddress)}</code>
              <br />
              Builder fee <code>{state.info.feeBps.toFixed(1)} bps</code>
            </p>
            <button className="cta" type="button" onClick={returnToTg}>
              Back to Telegram
            </button>
            <button
              className="ghostBtn"
              type="button"
              disabled={busy}
              onClick={() => void disconnectAndRestart()}
            >
              {busy ? 'Disconnecting…' : 'Disconnect & connect another wallet'}
            </button>
            <p className="muted small" style={{ marginTop: 10 }}>
              This revokes the current agent and pauses all mirrors. You can re-onboard with a
              different wallet right after.
            </p>
          </section>
        ) : !isConnected ? (
          <section className="intro">
            <h1>
              Mirror Hyperliquid <span className="grad">whales</span> from Telegram.
            </h1>
            <p className="lede">
              Non-custodial. Your funds stay on Hyperliquid — we only place orders through an agent
              key you approve.
            </p>
            <ul className="feats">
              <li>
                <strong>Cap 10 bps</strong> builder fee, default 5 bps.
              </li>
              <li>
                <strong>Kill switch</strong> from any device, instantly.
              </li>
              <li>
                <strong>Agent key</strong> can trade — never withdraw.
              </li>
            </ul>
            <button className="cta" type="button" onClick={() => void open()}>
              Connect wallet
            </button>
            <p className="muted small">
              MetaMask · Rabby · Coinbase · Trust · 380+ wallets via WalletConnect
            </p>
          </section>
        ) : state.step === 'done' ? (
          <section className="done">
            <div className="check">✓</div>
            <h2>You&apos;re in.</h2>
            <p>
              Wallet <code>{address ? shortAddr(address) : ''}</code> is connected and authorized.
              <br />
              Head back to Telegram and try <code>/wallet</code> or <code>/whales</code>.
            </p>
            <button className="cta" type="button" onClick={returnToTg}>
              Back to Telegram
            </button>
          </section>
        ) : state.step === 'error' ? (
          <section className="err">
            <div className="x">!</div>
            <h2>Something went wrong</h2>
            <p className="errMsg">{state.error}</p>
            <button className="cta" type="button" onClick={() => setState({ step: 'connect' })}>
              Try again
            </button>
          </section>
        ) : (
          <section className="cfg">
            <h2>Set your guardrails</h2>
            <p className="muted">These are enforced on every mirrored order.</p>

            <div className="feeBox">
              <span className="feeLbl">Builder fee</span>
              <span className="feeVal">
                5.0 bps <span className="feeMeta">per fill</span>
              </span>
            </div>
            <p className="hint">
              Hyperliquid&apos;s hard cap is 10 bps. No subscription, no withdrawal fee.
            </p>

            <label className="row">
              <span className="lbl">Equity floor</span>
              <span className="ctrl">
                <input
                  type="text"
                  inputMode="decimal"
                  value={equityFloorUsd}
                  disabled={busy}
                  onChange={(e) => setEquityFloorUsd(e.target.value)}
                />
                <span className="suffix">USD</span>
              </span>
            </label>
            <p className="hint">No new orders if your account equity is below this number.</p>

            {busy ? (
              <div className="steps">
                <Step n={1} label="Build agent key" active={signStep >= 0} done={signStep > 0} />
                <Step n={2} label="Approve agent" active={signStep >= 1} done={signStep > 1} />
                <Step n={3} label="Approve builder fee" active={signStep >= 2} done={false} />
              </div>
            ) : null}

            {busy ? (
              <button
                className="cta"
                type="button"
                onClick={() => openConnectedWallet()}
                style={{ background: '#1f2937', color: '#e6e6e6' }}
              >
                Open wallet to approve →
              </button>
            ) : null}

            <button
              className="cta"
              type="button"
              disabled={busy}
              onClick={() => void beginOnboarding()}
            >
              {busy ? 'Waiting for signatures…' : 'Sign & authorize'}
            </button>
            <p className="muted small">
              {busy
                ? 'Approve both prompts in your wallet. If it didn’t open, tap “Open wallet to approve”.'
                : 'Two signatures: one to register the agent, one to approve the builder fee. Free — no on-chain transaction.'}
            </p>
          </section>
        )}
      </div>

      <footer className="ft">
        <a href="https://t.me/whalepod_news" target="_blank" rel="noopener">
          Channel
        </a>
        <span>·</span>
        <a href="https://t.me/whalepod_chat" target="_blank" rel="noopener">
          Chat
        </a>
        <span>·</span>
        <a href="https://x.com/whalepodapp" target="_blank" rel="noopener">
          X
        </a>
        <span>·</span>
        <span>Non-custodial · Open source</span>
      </footer>

      <style jsx>{styles}</style>
    </main>
  );
}

function Step({
  n,
  label,
  active,
  done,
}: {
  n: number;
  label: string;
  active: boolean;
  done: boolean;
}): JSX.Element {
  return (
    <div className={`step ${done ? 'done' : active ? 'active' : ''}`}>
      <span className="bullet">{done ? '✓' : n}</span>
      <span>{label}</span>
      <style jsx>{`
        .step {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 6px 0;
          color: #6b7280;
          font-size: 14px;
          transition: color 0.2s;
        }
        .step.active {
          color: #e6e6e6;
        }
        .step.done {
          color: #3bd5b5;
        }
        .bullet {
          width: 22px;
          height: 22px;
          border-radius: 50%;
          background: #1f2937;
          color: inherit;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          font-size: 12px;
          font-weight: 600;
          border: 1px solid #2a3344;
        }
        .step.active .bullet {
          border-color: #3bd5b5;
          color: #3bd5b5;
          box-shadow: 0 0 0 4px rgba(59, 213, 181, 0.12);
        }
        .step.done .bullet {
          background: #3bd5b5;
          color: #04201a;
          border-color: #3bd5b5;
        }
      `}</style>
    </div>
  );
}

const styles = `
  .wrap {
    min-height: 100dvh;
    padding: 24px 16px 40px;
    display: flex;
    flex-direction: column;
    align-items: center;
    position: relative;
    overflow: hidden;
  }
  .bg {
    position: fixed;
    inset: 0;
    z-index: -1;
    background:
      radial-gradient(60% 50% at 50% 0%, rgba(59, 213, 181, 0.18), transparent 70%),
      radial-gradient(40% 40% at 100% 100%, rgba(99, 102, 241, 0.12), transparent 70%),
      #0b0e14;
  }
  .card {
    width: 100%;
    max-width: 520px;
    background: linear-gradient(180deg, rgba(22, 27, 34, 0.85), rgba(15, 18, 24, 0.85));
    border: 1px solid #1e2530;
    border-radius: 18px;
    padding: 24px;
    box-shadow: 0 24px 60px -20px rgba(0, 0, 0, 0.6);
    backdrop-filter: blur(8px);
    animation: fadeUp 0.4s ease-out both;
  }
  @keyframes fadeUp {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
  }
  .hd {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 20px;
  }
  .logo {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    font-weight: 700;
    letter-spacing: -0.01em;
    font-size: 16px;
  }
  .logo img {
    width: 28px;
    height: 28px;
    border-radius: 6px;
    display: block;
  }
  .feeBox {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 16px;
    background: linear-gradient(135deg, rgba(59,213,181,0.08), rgba(99,102,241,0.06));
    border: 1px solid rgba(59,213,181,0.2);
    border-radius: 10px;
    margin: 8px 0 4px;
  }
  .feeLbl { color: #9ca3af; font-size: 13px; font-weight: 500; }
  .feeVal { font-size: 16px; font-weight: 700; color: #3bd5b5; font-variant-numeric: tabular-nums; }
  .feeMeta { color: #6b7280; font-size: 12px; font-weight: 400; margin-left: 4px; }
  @keyframes pulse {
    0%, 100% { box-shadow: 0 0 0 4px rgba(59, 213, 181, 0.18); }
    50% { box-shadow: 0 0 0 8px rgba(59, 213, 181, 0.04); }
  }
  .pill {
    background: #11161f;
    color: #9ca3af;
    border: 1px solid #1f2937;
    border-radius: 999px;
    padding: 6px 12px;
    font-size: 12px;
    cursor: pointer;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    transition: all 0.15s;
  }
  .pill:hover { color: #fca5a5; border-color: #7f1d1d; }

  h1 {
    font-size: 28px;
    line-height: 1.15;
    letter-spacing: -0.02em;
    margin: 0 0 12px;
  }
  .grad {
    background: linear-gradient(90deg, #3bd5b5, #6366f1);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
  }
  h2 { font-size: 20px; margin: 0 0 6px; letter-spacing: -0.01em; }
  .lede { color: #9ca3af; margin: 0 0 20px; font-size: 15px; line-height: 1.55; }
  .muted { color: #9ca3af; }
  .small { font-size: 12px; margin: 12px 0 0; }
  .hint { color: #6b7280; font-size: 12px; margin: 4px 0 16px; }
  code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    background: rgba(255,255,255,0.06);
    padding: 1px 6px;
    border-radius: 4px;
    font-size: 12px;
  }

  .feats { list-style: none; padding: 0; margin: 0 0 24px; }
  .feats li {
    padding: 10px 12px;
    border: 1px solid #1f2937;
    background: rgba(255,255,255,0.02);
    border-radius: 10px;
    margin-bottom: 8px;
    font-size: 14px;
    color: #d1d5db;
  }
  .feats strong { color: #fff; }

  .cta {
    width: 100%;
    background: linear-gradient(180deg, #3bd5b5, #2bb89a);
    color: #04201a;
    font-weight: 600;
    border: none;
    border-radius: 10px;
    padding: 14px 18px;
    font-size: 15px;
    cursor: pointer;
    transition: transform 0.08s ease, box-shadow 0.2s, filter 0.2s;
    box-shadow: 0 8px 20px -8px rgba(59, 213, 181, 0.5);
  }
  .cta:hover { transform: translateY(-1px); filter: brightness(1.05); }
  .cta:active { transform: translateY(0); }
  .cta:disabled { opacity: 0.6; cursor: not-allowed; transform: none; }

  .ghostBtn {
    width: 100%;
    margin-top: 10px;
    background: transparent;
    color: #9ca3af;
    border: 1px solid #2a3344;
    border-radius: 10px;
    padding: 12px 18px;
    font-size: 14px;
    cursor: pointer;
    transition: color 0.15s, border-color 0.15s, background 0.15s;
  }
  .ghostBtn:hover { color: #fca5a5; border-color: #7f1d1d; background: rgba(127,29,29,0.08); }
  .ghostBtn:disabled { opacity: 0.5; cursor: not-allowed; }

  .spinner {
    width: 32px; height: 32px; margin: 0 auto 12px;
    border: 3px solid #1f2937;
    border-top-color: #3bd5b5;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  .row {
    display: flex; align-items: center; justify-content: space-between;
    padding: 12px 0;
  }
  .lbl { font-size: 14px; color: #d1d5db; }
  .ctrl {
    display: inline-flex; align-items: center; gap: 6px;
    background: #0d1117; border: 1px solid #1f2937;
    border-radius: 8px; padding: 6px 10px;
    transition: border-color 0.15s;
  }
  .ctrl:focus-within { border-color: #3bd5b5; }
  .ctrl input {
    background: transparent; color: #e6e6e6; border: none; outline: none;
    width: 80px; font-size: 14px; text-align: right;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .suffix { color: #6b7280; font-size: 12px; }

  .steps {
    margin: 16px 0;
    padding: 12px 14px;
    background: rgba(255,255,255,0.02);
    border: 1px solid #1f2937;
    border-radius: 10px;
  }

  .done, .err { text-align: center; padding: 8px 0; }
  .check, .x {
    width: 56px; height: 56px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    font-size: 28px; font-weight: 700;
    margin: 8px auto 16px;
    animation: pop 0.35s cubic-bezier(.2,1.6,.4,1) both;
  }
  .check { background: rgba(59, 213, 181, 0.15); color: #3bd5b5; border: 1px solid rgba(59,213,181,0.4); }
  .x { background: rgba(248, 113, 113, 0.12); color: #fca5a5; border: 1px solid rgba(248,113,113,0.4); }
  @keyframes pop { from { transform: scale(0.5); opacity: 0; } to { transform: scale(1); opacity: 1; } }
  .errMsg {
    color: #fecaca; font-size: 13px;
    background: rgba(127,29,29,0.2); border: 1px solid rgba(127,29,29,0.4);
    padding: 10px 12px; border-radius: 8px;
    word-break: break-word; text-align: left;
    margin: 8px 0 16px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }

  .ft {
    margin-top: 24px;
    color: #6b7280;
    font-size: 12px;
    display: flex; gap: 10px; align-items: center;
  }
  .ft a { color: #9ca3af; text-decoration: none; }
  .ft a:hover { color: #3bd5b5; }
`;
