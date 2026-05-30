import Link from 'next/link';

export default function HomePage(): JSX.Element {
  return (
    <main style={{ maxWidth: 640, margin: '0 auto', padding: 32 }}>
      <h1 style={{ fontSize: 32, marginBottom: 8 }}>WhalePod</h1>
      <p style={{ opacity: 0.8 }}>
        Non-custodial copy-trading on Hyperliquid perps. Start by linking your wallet.
      </p>
      <Link
        href="/onboard"
        style={{
          display: 'inline-block',
          marginTop: 24,
          padding: '12px 24px',
          background: '#3b82f6',
          color: 'white',
          borderRadius: 8,
          textDecoration: 'none',
        }}
      >
        Begin onboarding
      </Link>
    </main>
  );
}
