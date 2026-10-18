/** Reveal / copy a secret value. The plaintext lives only in this component's state, never in the query cache. */
import { useMutation } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { errorMessage } from '@/shared/api/client';
import { revealSecret } from './secrets.api';
import { useToast } from '@/shared/components/Toast';
import { Button } from '@/shared/components/ui';
import { copyWithAutoClear } from '@/shared/lib/clipboard';

// A revealed value hides itself after 30 s.
export const REVEAL_MS = 30_000;

// Masked value with reveal (countdown) and copy buttons.
export function RevealCell({ project, env, secretId, secretKey }: { project: string; env: string; secretId: string; secretKey: string }) {
  const toast = useToast();
  const [value, setValue] = useState<string | null>(null);
  const [left, setLeft] = useState(0);
  const timers = useRef<{ hide?: ReturnType<typeof setTimeout>; tick?: ReturnType<typeof setInterval> }>({});

  // Stop the hide timer and countdown (also on unmount).
  const clearTimers = () => {
    clearTimeout(timers.current.hide);
    clearInterval(timers.current.tick);
  };
  useEffect(() => clearTimers, []);

  // Mask the value again.
  const hide = () => {
    clearTimers();
    setValue(null);
    setLeft(0);
  };

  // Reveal call; gcTime 0 so the value isn't kept in the cache.
  const reveal = useMutation({ mutationFn: () => revealSecret(project, env, secretId), gcTime: 0 });

  // Show the value and start the 30 s countdown.
  const show = (v: string) => {
    clearTimers();
    setValue(v);
    setLeft(REVEAL_MS / 1000);
    timers.current.tick = setInterval(() => setLeft((s) => Math.max(0, s - 1)), 1000);
    timers.current.hide = setTimeout(hide, REVEAL_MS);
  };

  // Fetch the plaintext; errors become a toast.
  const fetchValue = async (): Promise<string | null> => {
    try {
      const r = await reveal.mutateAsync();
      reveal.reset(); // drop the value from the mutation state
      return r.value;
    } catch (e) {
      reveal.reset();
      toast.error(errorMessage(e, 'Could not reveal the secret.'));
      return null;
    }
  };

  // Toggle between hidden and revealed.
  const onReveal = async () => {
    if (value !== null) return hide();
    const v = await fetchValue();
    if (v !== null) show(v);
  };

  // Copy (fetching first if hidden); clipboard clears after 30 s.
  const onCopy = async () => {
    const v = value ?? (await fetchValue());
    if (v === null) return;
    try {
      await copyWithAutoClear(v);
      toast.success('Copied — clipboard clears in 30s');
    } catch {
      toast.error('Clipboard is not available.');
    }
  };

  return (
    <div className="flex min-w-0 items-center gap-2">
      <code className="min-w-0 max-w-xs truncate rounded bg-stone-100 px-1.5 py-0.5 font-mono text-xs dark:bg-stone-800" data-testid={`value-${secretKey}`}>
        {value !== null ? value : '••••••••••••'}
      </code>
      {value !== null && (
        <span className="shrink-0 text-xs tabular-nums text-stone-500" aria-live="polite">
          {left}s
        </span>
      )}
      <Button
        size="sm"
        variant="ghost"
        onClick={() => void onReveal()}
        loading={reveal.isPending}
        aria-label={value !== null ? `Hide ${secretKey}` : `Reveal ${secretKey}`}
      >
        <EyeIcon off={value !== null} />
      </Button>
      <Button size="sm" variant="ghost" onClick={() => void onCopy()} aria-label={`Copy ${secretKey}`}>
        Copy
      </Button>
    </div>
  );
}

// Eye icon; crossed out while the value is visible.
function EyeIcon({ off }: { off: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
      {off && <path d="M3 3l18 18" />}
    </svg>
  );
}
