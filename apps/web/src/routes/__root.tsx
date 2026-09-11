/// <reference types="vite/client" />
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { createRootRoute, HeadContent, Link, Outlet, Scripts } from '@tanstack/react-router';
import { TanStackRouterDevtools } from '@tanstack/react-router-devtools';
import { Activity, BarChart3, Copy, LayoutDashboard, Moon, Sun, Users } from 'lucide-react';
import type { ReactNode } from 'react';
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
      className="rail-item"
      title={theme === 'light' ? 'Switch to dark' : 'Switch to light'}
      aria-label="Toggle theme"
    >
      {theme === 'light' ? (
        <Moon className="h-[16px] w-[16px]" strokeWidth={1.8} />
      ) : (
        <Sun className="h-[16px] w-[16px]" strokeWidth={1.8} />
      )}
    </button>
  );
}

function RootComponent() {
  return (
    <div className="min-h-screen bg-[hsl(var(--background))] text-[hsl(var(--foreground))]">
      {/* Left icon rail */}
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
          <div className="flex h-[52px] items-center justify-between px-4 sm:px-6">
            <div className="flex items-center gap-3">
              <span className="text-[15px] font-semibold tracking-tight">HyperDash</span>
              <span className="badge badge-accent hidden sm:inline-flex">HYPERLIQUID</span>
            </div>
            <nav className="hidden items-center gap-1 md:flex">
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
            <div className="flex items-center gap-2">
              <ThemeToggle />
              <ConnectButton showBalance={false} accountStatus="address" chainStatus="icon" />
              <AuthButton />
            </div>
          </div>
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
