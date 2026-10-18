/** App shell for signed-in pages: skip link, header with navigation, and the routed page. */
import { Link, Outlet } from 'react-router-dom';
import { Nav } from './Nav';
import { LockIcon } from '@/shared/components/ui';

/** Rendered by the router around every authenticated page (see RequireAuth). */
export function Layout() {
  return (
    <div className="min-h-screen">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:rounded focus:bg-white focus:p-2">
        Skip to content
      </a>
      <header className="border-b border-stone-200 bg-white dark:border-stone-800 dark:bg-stone-900">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 px-4 py-2">
          <Link to="/" className="flex items-center gap-2 font-semibold">
            <LockIcon className="size-5 text-brand-600 dark:text-brand-400" />
            Key Vault
          </Link>
          <Nav />
        </div>
      </header>
      <main id="main" className="mx-auto max-w-6xl px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}
