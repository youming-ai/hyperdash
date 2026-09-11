import { cookieStorage, createConfig, createStorage, http } from 'wagmi';
import { arbitrum, mainnet } from 'wagmi/chains';
import { coinbaseWallet, injected, walletConnect } from 'wagmi/connectors';

const projectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID || 'demo';

// Custom Hyperliquid chain (if needed)
export const hyperliquid = {
  id: 42161, // Using Arbitrum for now
  name: 'Hyperliquid',
  nativeCurrency: {
    decimals: 18,
    name: 'Ether',
    symbol: 'ETH',
  },
  rpcUrls: {
    default: { http: ['https://arb1.arbitrum.io/rpc'] },
  },
  blockExplorers: {
    default: { name: 'Arbiscan', url: 'https://arbiscan.io' },
  },
} as const;

export const wagmiConfig = createConfig({
  chains: [arbitrum, mainnet],
  ssr: true,
  connectors: [injected(), walletConnect({ projectId }), coinbaseWallet({ appName: 'HyperDash' })],
  storage: createStorage({ storage: cookieStorage }),
  transports: {
    [arbitrum.id]: http(),
    [mainnet.id]: http(),
  },
});

declare module 'wagmi' {
  interface Register {
    config: typeof wagmiConfig;
  }
}
