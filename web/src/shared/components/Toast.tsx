/** Toasts: `const toast = useToast(); toast.success('Copied')`. Rendered in an aria-live region. */
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { cx } from './ui';

// Toast types and the hook's API.
type Kind = 'success' | 'error' | 'info';
interface ToastItem {
  id: number;
  kind: Kind;
  message: string;
}
export interface ToastApi {
  success: (msg: string) => void;
  error: (msg: string) => void;
  info: (msg: string) => void;
}

// Context holding the toast API.
const Ctx = createContext<ToastApi | null>(null);

// Keeps the toast list and renders it in a live region.
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const next = useRef(1);

  // Add a toast (max 5 shown); errors stay 7 s, others 4 s.
  const push = useCallback((kind: Kind, message: string) => {
    const id = next.current++;
    setItems((xs) => [...xs.slice(-4), { id, kind, message }]);
    setTimeout(() => setItems((xs) => xs.filter((t) => t.id !== id)), kind === 'error' ? 7000 : 4000);
  }, []);

  const api = useMemo<ToastApi>(
    () => ({ success: (m) => push('success', m), error: (m) => push('error', m), info: (m) => push('info', m) }),
    [push],
  );

  return (
    <Ctx.Provider value={api}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex flex-col items-center gap-2 px-4 sm:items-end">
        {items.map((t) => (
          <div
            key={t.id}
            role={t.kind === 'error' ? 'alert' : 'status'}
            className={cx(
              'pointer-events-auto w-full max-w-sm rounded-md px-4 py-3 text-sm font-medium shadow-lg ring-1',
              t.kind === 'success' && 'bg-emerald-600 text-white ring-emerald-700',
              t.kind === 'error' && 'bg-red-600 text-white ring-red-700',
              t.kind === 'info' && 'bg-stone-800 text-white ring-stone-700',
            )}
          >
            {t.message}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

// Access toasts from any component under ToastProvider.
export function useToast(): ToastApi {
  const c = useContext(Ctx);
  if (!c) throw new Error('useToast must be used inside <ToastProvider>');
  return c;
}
