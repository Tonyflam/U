'use client';

import { WagmiProvider, cookieStorage, createStorage } from 'wagmi';
import { arbitrum, mainnet } from 'wagmi/chains';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { createAppKit } from '@reown/appkit/react';
import { WagmiAdapter } from '@reown/appkit-adapter-wagmi';

const projectId = '300db405c25f36a3847110ee52bf3bc7';

// HL onboarding signs OFF-CHAIN EIP-712 payloads whose chainId (Arbitrum,
// 0xa4b1) lives inside the signed domain — the wallet can produce a valid
// signature while sitting on ANY chain. We therefore register Ethereum
// mainnet (1) too: mobile MetaMask connects on mainnet by default, and if 1
// isn't a configured network wagmi can't resolve the connector's chain and
// throws "connector (id: undefined) does not match connection's chain (id: 1)"
// before signing. Arbitrum stays the default we (best-effort) switch to.
const wagmiAdapter = new WagmiAdapter({
  storage: createStorage({ storage: cookieStorage }),
  ssr: true,
  projectId,
  networks: [arbitrum, mainnet],
});

if (typeof window !== 'undefined') {
  createAppKit({
    // adapter version-pin mismatch causes a structural-type error around
    // ChainNamespace; the runtime is correct.
    adapters: [wagmiAdapter as never],
    projectId,
    networks: [arbitrum, mainnet],
    defaultNetwork: arbitrum,
    metadata: {
      name: 'WhalePod',
      description: 'Mirror Hyperliquid whales from Telegram. Non-custodial.',
      url: 'https://app.whalepod.trade',
      icons: ['https://app.whalepod.trade/favicon.png'],
    },
    features: {
      analytics: false,
      email: false,
      socials: false,
    },
    themeMode: 'dark',
    themeVariables: {
      '--w3m-accent': '#3bd5b5',
      '--w3m-color-mix': '#0b0e14',
      '--w3m-color-mix-strength': 30,
      '--w3m-border-radius-master': '4px',
      '--w3m-font-family':
        'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    },
  });
}

export function Providers({ children }: { children: ReactNode }): JSX.Element {
  const [queryClient] = useState(() => new QueryClient());
  return (
    <WagmiProvider config={wagmiAdapter.wagmiConfig}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}
