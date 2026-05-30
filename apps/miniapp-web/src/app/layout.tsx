import type { Metadata } from 'next';
import { Providers } from './providers';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'WhalePod',
  description: 'Mirror Hyperliquid whales from Telegram. Non-custodial.',
  icons: {
    icon: '/favicon.png',
    apple: '/favicon.png',
  },
  openGraph: {
    title: 'WhalePod',
    description: 'Mirror Hyperliquid whales from Telegram. Non-custodial.',
    images: [{ url: '/og-card.png', width: 1200, height: 630, alt: 'WhalePod' }],
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'WhalePod',
    description: 'Mirror Hyperliquid whales from Telegram. Non-custodial.',
    images: ['/og-card.png'],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          fontFamily: 'system-ui, sans-serif',
          background: '#0b0e14',
          color: '#e6e6e6',
        }}
      >
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
