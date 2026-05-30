import Link from 'next/link';

export default function HomePage({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}): JSX.Element {
  const tg = typeof searchParams['tg'] === 'string' ? searchParams['tg'] : '';
  const href = tg ? `/onboard?tg=${encodeURIComponent(tg)}` : '/onboard';
  return (
    <main
      style={{
        minHeight: '100dvh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        background:
          'radial-gradient(60% 50% at 50% 0%, rgba(59,213,181,0.18), transparent 70%), radial-gradient(40% 40% at 100% 100%, rgba(99,102,241,0.12), transparent 70%), #0b0e14',
      }}
    >
      <div
        style={{
          maxWidth: 480,
          width: '100%',
          textAlign: 'center',
          padding: 32,
          borderRadius: 18,
          border: '1px solid #1e2530',
          background: 'rgba(22,27,34,0.6)',
          backdropFilter: 'blur(8px)',
        }}
      >
        <h1 style={{ fontSize: 36, margin: 0, letterSpacing: '-0.02em' }}>
          Whale
          <span
            style={{
              background: 'linear-gradient(90deg,#3bd5b5,#6366f1)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
            }}
          >
            Pod
          </span>
        </h1>
        <p style={{ color: '#9ca3af', marginTop: 8, marginBottom: 28, fontSize: 15 }}>
          Non-custodial copy-trading on Hyperliquid perps. Connect your wallet to begin.
        </p>
        <Link
          href={href}
          style={{
            display: 'inline-block',
            padding: '14px 24px',
            background: 'linear-gradient(180deg,#3bd5b5,#2bb89a)',
            color: '#04201a',
            borderRadius: 10,
            textDecoration: 'none',
            fontWeight: 600,
            boxShadow: '0 8px 20px -8px rgba(59,213,181,0.5)',
          }}
        >
          Begin onboarding →
        </Link>
      </div>
    </main>
  );
}
