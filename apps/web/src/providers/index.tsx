import {
  darkTheme,
  lightTheme,
  RainbowKitProvider,
  type Theme as RainbowTheme,
} from '@rainbow-me/rainbowkit';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { WagmiProvider } from 'wagmi';
import { ApiError } from '~/lib/api-client';
import { wagmiConfig } from '~/lib/wagmi';

import '@rainbow-me/rainbowkit/styles.css';

/**
 * App Providers.
 *
 * - `ThemeProvider`: dark (default) / light theme, persisted to localStorage
 *   and applied as a `light` class on <html> (see styles.css).
 * - `WagmiProvider`: wallet connection (configured with `ssr: true`).
 * - `QueryClientProvider`: TanStack Query. The client is created per render via
 *   `useState` so the server never shares cache across requests.
 * - `RainbowKitProvider`: wallet connection UI, follows the app theme.
 */

export type Theme = 'dark' | 'light';

const STORAGE_KEY = 'hd-theme';

interface ThemeContextValue {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: 'dark',
  setTheme: () => {},
  toggleTheme: () => {},
});

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}

function readStoredTheme(): Theme {
  if (typeof window === 'undefined') return 'dark';
  try {
    return localStorage.getItem(STORAGE_KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

function applyThemeClass(theme: Theme): void {
  if (typeof document === 'undefined') return;
  document.documentElement.classList.toggle('light', theme === 'light');
}

function rainbowTheme(theme: Theme): RainbowTheme {
  const common = {
    accentColor: '#cf3406',
    accentColorForeground: 'white',
    borderRadius: 'medium' as const,
  };
  return theme === 'light' ? lightTheme(common) : darkTheme(common);
}

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30 * 1000,
            refetchOnWindowFocus: false,
            /**
             * Do not retry client errors.
             *
             * TanStack Query retries every failure three times by default, with
             * exponential backoff. A 4xx cannot succeed on retry — 401 needs a
             * session, 404 a different URL — so the retries only delay the
             * message the user needs. A signed-out visitor to a protected route
             * used to watch a skeleton for roughly eight seconds before being
             * told to sign in; the first response already knew the answer.
             *
             * Server and network errors keep retrying, which is what the default
             * is actually for.
             */
            retry: (failureCount, error) => {
              if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
                return false;
              }
              return failureCount < 3;
            },
          },
        },
      }),
  );

  const [theme, setThemeState] = useState<Theme>(() => readStoredTheme());

  useEffect(() => {
    applyThemeClass(theme);
  }, [theme]);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    applyThemeClass(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // storage unavailable (private mode) — theme still applies for the session
    }
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme(theme === 'light' ? 'dark' : 'light');
  }, [theme, setTheme]);

  const themeValue = useMemo(
    () => ({ theme, setTheme, toggleTheme }),
    [theme, setTheme, toggleTheme],
  );

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider theme={rainbowTheme(theme)} modalSize="compact">
          <ThemeContext.Provider value={themeValue}>{children}</ThemeContext.Provider>
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
