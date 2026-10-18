/** Shared frame for the public auth pages. */
import type { ReactNode } from 'react';
import { LockIcon } from '@/shared/components/ui';

/** Centered card for public auth pages (login, invite, enroll). */
export function AuthCard({ title, subtitle, children }: { title: string; subtitle?: ReactNode; children: ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-sm ring-1 ring-stone-200 sm:p-8 dark:bg-stone-900 dark:ring-stone-800">
        <div className="mb-6 flex items-center gap-2 font-semibold">
          <LockIcon className="size-5 text-brand-600 dark:text-brand-400" />
          Key Vault
        </div>
        <h1 className="text-xl font-semibold">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-stone-600 dark:text-stone-400">{subtitle}</p>}
        <div className="mt-6">{children}</div>
      </div>
    </main>
  );
}
