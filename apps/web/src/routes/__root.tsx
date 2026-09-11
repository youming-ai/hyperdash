/// <reference types="vite/client" />
import {
  createRootRoute,
  HeadContent,
  Link,
  Outlet,
  Scripts,
  useRouter,
} from '@tanstack/react-router';
import { TanStackRouterDevtools } from '@tanstack/react-router-devtools';
import { AlertTriangle, Menu, Moon, RefreshCw, Sun, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { AuthButton } from '~/components/AuthButton';
import { Button } from '~/components/ui/button';
import { WalletButton } from '~/components/WalletButton';
import { Providers, useTheme } from '~/providers';
import appCss from '~/styles.css?url';

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'HyperDash — Trading Terminal for Hyperliquid' },
      {
        name: 'description',
        content:
          'Advanced trading terminal for Hyperliquid. Real-time analytics, whale tracking, and copy trading.',
      },
    ],
    links: [{ rel: 'stylesheet', href: appCss }],
  }),
  component: RootComponent,
  shellComponent: RootDocument,
  notFoundComponent: NotFound,
  errorComponent: RouteError,
});

/** One nav, one place. The old icon rail duplicated this list exactly. */
const NAV = [
  { to: '/', label: 'Overview' },
  { to: '/terminal', label: 'Terminal' },
  { to: '/traders', label: 'Traders' },
  { to: '/analytics', label: 'Analytics' },
  { to: '/strategies', label: 'Strategies' },
] as const;

function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  const next = theme === 'light' ? 'dark' : 'light';
  return (
    <button
      type="button"
      onClick={toggleTheme}
      className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-fg-tertiary transition-colors hover:bg-raised hover:text-foreground cursor-pointer"
      title={`Switch to ${next} theme`}
      aria-label={`Switch to ${next} theme`}
    >
      {theme === 'light' ? (
        <Moon className="size-4" strokeWidth={1.8} />
      ) : (
        <Sun className="size-4" strokeWidth={1.8} />
      )}
    </button>
  );
}

function RootComponent() {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <header className="app-topbar">
        <div className="mx-auto flex h-[52px] w-full max-w-[1600px] items-center gap-3 px-3 sm:px-5">
          <button
            type="button"
            onClick={() => setMobileOpen((open) => !open)}
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-fg-tertiary hover:bg-raised hover:text-foreground md:hidden cursor-pointer"
            aria-label={mobileOpen ? 'Close navigation' : 'Open navigation'}
            aria-expanded={mobileOpen}
            aria-controls="app-mobile-nav"
          >
            {mobileOpen ? <X className="size-4" /> : <Menu className="size-4" />}
          </button>

          <Link
            to="/"
            className="-m-1.5 flex shrink-0 items-center gap-2 rounded-md p-1.5"
            aria-label="HyperDash home"
          >
            <span className="font-mono text-md font-bold tracking-tight text-fg-accent">HD</span>
            <span className="hidden text-sm font-medium tracking-tight sm:inline">HyperDash</span>
          </Link>

          <nav aria-label="Primary" className="hidden min-w-0 items-center gap-0.5 md:flex">
            {NAV.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                className="nav-link"
                activeProps={{ 'data-active': 'true' }}
              >
                {item.label}
              </Link>
            ))}
          </nav>

          {/* Right cluster: every control is 32px tall so the row lines up.
              Previously RainbowKit's stock 40px button sat between a 32px theme
              toggle and a 28px auth button. */}
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            <ThemeToggle />
            <WalletButton />
            <AuthButton />
          </div>
        </div>

        {mobileOpen ? (
          <nav
            id="app-mobile-nav"
            aria-label="Primary"
            className="border-t border-border bg-panel px-2 py-2 md:hidden"
          >
            <div className="flex flex-col gap-0.5">
              {NAV.map((item) => (
                <Link
                  key={item.to}
                  to={item.to}
                  onClick={() => setMobileOpen(false)}
                  className="nav-link w-full"
                  activeProps={{ 'data-active': 'true' }}
                >
                  {item.label}
                </Link>
              ))}
            </div>
          </nav>
        ) : null}
      </header>

      <main className="mx-auto w-full max-w-[1600px] grow px-3 py-4 sm:px-5">
        <Outlet />
      </main>

      <footer className="mx-auto flex w-full max-w-[1600px] flex-wrap items-center justify-between gap-2 border-t border-border px-3 py-3 text-2xs text-fg-quaternary sm:px-5">
        <span>HyperDash — market data from the public Hyperliquid API</span>
        <span>Not affiliated with Hyperliquid. Trading involves risk.</span>
      </footer>

      {import.meta.env.DEV ? <TanStackRouterDevtools position="bottom-right" /> : null}
    </div>
  );
}

function RouteError({ error, reset }: { error: Error; reset: () => void }) {
  const router = useRouter();
  return (
    <div className="panel mx-auto mt-8 flex max-w-md flex-col items-center gap-3 p-6 text-center">
      <AlertTriangle className="size-6 text-destructive" strokeWidth={1.6} aria-hidden="true" />
      <h1 className="text-lg font-medium">Something went wrong</h1>
      <p className="text-sm text-fg-tertiary">
        This view failed to render. The rest of the app is unaffected.
      </p>
      <p className="num max-w-full truncate text-2xs text-fg-quaternary" title={error.message}>
        {error.message}
      </p>
      <Button
        variant="primary"
        onClick={() => {
          void router.invalidate();
          reset();
        }}
      >
        <RefreshCw aria-hidden="true" />
        Try again
      </Button>
    </div>
  );
}

function NotFound() {
  return (
    <div className="panel mx-auto mt-8 flex max-w-md flex-col items-center gap-3 p-6 text-center">
      <h1 className="text-lg font-medium">Page not found</h1>
      <p className="text-sm text-fg-tertiary">
        That route does not exist. Check the address or head back to the overview.
      </p>
      <Link to="/" className="nav-link" data-active="true">
        Back to overview
      </Link>
    </div>
  );
}

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
        <script
          // biome-ignore lint/security/noDangerouslySetInnerHtml: inline pre-paint theme script is the standard anti-FOUC technique
          dangerouslySetInnerHTML={{
            __html: `try{if(localStorage.getItem('hd-theme')==='light')document.documentElement.classList.add('light');}catch(e){}`,
          }}
        />
      </head>
      <body>
        <Providers>{children}</Providers>
        <Scripts />
      </body>
    </html>
  );
}
