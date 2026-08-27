/// <reference types="vite/client" />
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { createRootRoute, HeadContent, Link, Outlet, Scripts } from '@tanstack/react-router';
import { TanStackRouterDevtools } from '@tanstack/react-router-devtools';
import {
  Activity,
  BarChart3,
  Copy,
  LayoutDashboard,
  Menu,
  Moon,
  Sun,
  Users,
  X,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { AuthButton } from '~/components/AuthButton';
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
});

const NAV = [
  { to: '/', label: 'Overview', icon: LayoutDashboard },
  { to: '/terminal', label: 'Terminal', icon: Activity },
  { to: '/traders', label: 'Traders', icon: Users },
  { to: '/analytics', label: 'Analytics', icon: BarChart3 },
  { to: '/strategies', label: 'Strategies', icon: Copy },
] as const;

function NavLink({ to, label, Icon }: { to: string; label: string; Icon: typeof Activity }) {
  return (
    <Link
      to={to}
      className="rail-item"
      activeProps={{ 'data-active': 'true' }}
      title={label}
      aria-label={label}
    >
      <Icon className="h-[18px] w-[18px]" strokeWidth={1.8} />
    </Link>
  );
}

function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  return (
    <button
      type="button"
      onClick={toggleTheme}
      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[hsl(var(--fg-tertiary))] hover:bg-[hsl(var(--muted))] hover:text-[hsl(var(--foreground))] transition-colors"
      title={theme === 'light' ? 'Switch to dark' : 'Switch to light'}
      aria-label="Toggle theme"
    >
      {theme === 'light' ? (
        <Moon className="h-4 w-4" strokeWidth={1.8} />
      ) : (
        <Sun className="h-4 w-4" strokeWidth={1.8} />
      )}
    </button>
  );
}

function RootComponent() {
  const [mobileOpen, setMobileOpen] = useState(false);
  return (
    <div className="min-h-screen bg-[hsl(var(--background))] text-[hsl(var(--foreground))]">
      {/* Left icon rail — desktop */}
      <aside className="app-rail">
        <Link to="/" className="rail-item" title="HyperDash" activeProps={{}}>
          <span className="font-mono text-[15px] font-bold text-[hsl(var(--primary))]">H</span>
        </Link>
        <div className="my-1 h-px w-6 bg-[hsl(var(--border))]" />
        {NAV.map((item) => (
          <NavLink key={item.to} to={item.to} label={item.label} Icon={item.icon} />
        ))}
        <div className="mt-auto flex flex-col items-center gap-1">
          <span className="status-dot status-dot-live animate-live" title="Feed live" />
        </div>
      </aside>

      {/* Content column */}
      <div className="md:pl-14">
        <header className="app-topbar">
          <div className="flex h-[52px] items-center justify-between gap-2 px-3 sm:px-6">
            <div className="flex min-w-0 items-center gap-2 sm:gap-3">
              <button
                type="button"
                onClick={() => setMobileOpen((v) => !v)}
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md hover:bg-[hsl(var(--muted))] md:hidden"
                aria-label="Toggle navigation"
                aria-expanded={mobileOpen}
              >
                {mobileOpen ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
              </button>
              <span className="shrink-0 text-[15px] font-semibold tracking-tight">HyperDash</span>
              <span className="badge badge-accent hidden shrink-0 sm:inline-flex">HYPERLIQUID</span>
            </div>
            <nav className="hidden shrink-0 items-center gap-1 md:flex">
              {NAV.map((item) => (
                <Link
                  key={item.to}
                  to={item.to}
                  className="dock-tab"
                  activeProps={{ 'data-active': 'true' }}
                >
                  {item.label}
                </Link>
              ))}
            </nav>
            <div className="flex shrink-0 items-center gap-1 sm:gap-1.5">
              <ThemeToggle />
              <span className="hidden shrink-0 sm:inline-flex max-w-[160px]">
                <ConnectButton showBalance={false} accountStatus="address" chainStatus="none" />
              </span>
              <span className="inline-flex shrink-0 sm:hidden">
                <ConnectButton showBalance={false} accountStatus="avatar" chainStatus="none" />
              </span>
              <span className="shrink-0">
                <AuthButton />
              </span>
            </div>
          </div>
          {/* Mobile drawer */}
          {mobileOpen && (
            <nav className="border-t border-[hsl(var(--border))] bg-[hsl(var(--card))] px-2 py-2 md:hidden">
              <div className="flex flex-col gap-1">
                {NAV.map((item) => (
                  <Link
                    key={item.to}
                    to={item.to}
                    onClick={() => setMobileOpen(false)}
                    className="flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium hover:bg-[hsl(var(--muted))]"
                    activeProps={{
                      className:
                        'flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium bg-[hsl(var(--muted))] text-[hsl(var(--primary))]',
                    }}
                  >
                    <item.icon className="h-4 w-4" strokeWidth={1.8} />
                    {item.label}
                  </Link>
                ))}
              </div>
            </nav>
          )}
        </header>

        <main className="animate-fade-in">
          <Outlet />
        </main>
      </div>

      {import.meta.env.DEV && <TanStackRouterDevtools position="bottom-right" />}
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
