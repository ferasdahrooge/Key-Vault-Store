/**
 * Accessible modal dialog: role=dialog + aria-modal, focuses the first focusable element,
 * traps Tab, closes on Escape / backdrop click, restores focus to the opener on close.
 */
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cx } from './ui';

// Elements that can receive keyboard focus inside the dialog.
const FOCUSABLE = 'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

// Props for the modal dialog.
export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  /** Buttons row rendered at the bottom. */
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  /** Prevent closing via Escape/backdrop (e.g. while a request is in flight or for one-time secrets). */
  dismissible?: boolean;
}

// Modal rendered into document.body via a portal.
export function Dialog({ open, onClose, title, description, children, footer, size = 'md', dismissible = true }: DialogProps) {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();
  // Latest close handler/dismissible flag, so callers passing inline callbacks don't re-run the
  // open effect (which would steal focus back to the first field on every keystroke).
  const onCloseRef = useRef(onClose);
  const dismissibleRef = useRef(dismissible);
  useEffect(() => {
    onCloseRef.current = onClose;
    dismissibleRef.current = dismissible;
  });

  useEffect(() => {
    if (!open) return;
    // Remember who opened the dialog, then focus the first field inside it.
    const opener = document.activeElement as HTMLElement | null;
    const el = panel.current;
    const first = el?.querySelector<HTMLElement>('[data-autofocus]') ?? el?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? el)?.focus();

    // Escape closes; Tab/Shift+Tab wrap around inside the dialog.
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && dismissibleRef.current) {
        e.stopPropagation();
        onCloseRef.current();
      } else if (e.key === 'Tab' && el) {
        const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)];
        if (items.length === 0) return e.preventDefault();
        const firstEl = items[0]!;
        const lastEl = items[items.length - 1]!;
        if (e.shiftKey && document.activeElement === firstEl) {
          e.preventDefault();
          lastEl.focus();
        } else if (!e.shiftKey && document.activeElement === lastEl) {
          e.preventDefault();
          firstEl.focus();
        }
      }
    }
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      opener?.focus?.();
    };
  }, [open]);

  if (!open) return null;
  // Max width per size option.
  const width = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl' }[size];

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center">
      <div className="fixed inset-0 bg-stone-900/60" aria-hidden="true" onClick={dismissible ? onClose : undefined} />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        className={cx(
          'relative w-full overflow-hidden rounded-lg bg-white shadow-xl ring-1 ring-stone-200 focus:outline-none dark:bg-stone-900 dark:ring-stone-700',
          width,
        )}
      >
        <div className="max-h-[80vh] overflow-y-auto px-6 pt-5 pb-4">
          <h2 id={titleId} className="text-lg font-semibold text-stone-900 dark:text-white">
            {title}
          </h2>
          {description && (
            <p id={descId} className="mt-1 text-sm text-stone-500 dark:text-stone-400">
              {description}
            </p>
          )}
          <div className="mt-4">{children}</div>
        </div>
        {footer && (
          <div className="flex flex-wrap justify-end gap-2 border-t border-stone-200 bg-stone-50 px-6 py-3 dark:border-stone-700 dark:bg-stone-800/50">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
