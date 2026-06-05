'use client';

// useAppKit() throws if createAppKit() has not run; createAppKit() needs window
// (set in providers.tsx behind `typeof window !== 'undefined'`). Rendering the
// onboarding UI during SSR therefore 500s. Loading the real component on the
// client only keeps the page reachable at request time without warming up
// AppKit on the server.
import dynamic from 'next/dynamic';

const OnboardClient = dynamic(() => import('./OnboardClient'), {
  ssr: false,
  loading: () => (
    <main
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#0b0e14',
        color: '#9aa3b2',
        fontFamily: 'ui-sans-serif, system-ui, -apple-system, sans-serif',
        fontSize: 14,
      }}
    >
      Loading WhalePod…
    </main>
  ),
});

export default function OnboardPage(): JSX.Element {
  return <OnboardClient />;
}
