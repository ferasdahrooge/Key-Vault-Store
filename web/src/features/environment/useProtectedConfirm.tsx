/**
 * Wraps an action so that, in a protected environment, the user must first type the env slug.
 * Usage: const pc = useProtectedConfirm(env); pc.run('Delete KEY', (confirm) => mutate(confirm)); render {pc.dialog}.
 */
import { useState, type ReactNode } from 'react';
import type { Environment } from '@/shared/api/types';
import { ConfirmProtectedDialog } from './ConfirmProtectedDialog';

// The action waiting for confirmation.
interface Pending {
  action: string;
  danger: boolean;
  details?: ReactNode;
  fn: (confirm: string | undefined) => void;
}

export function useProtectedConfirm(env: Pick<Environment, 'slug' | 'protected'>, busy = false) {
  const [pending, setPending] = useState<Pending | null>(null);

  // Ask for confirmation in protected envs; otherwise run immediately.
  const run = (action: string, fn: (confirm: string | undefined) => void, opts: { danger?: boolean; details?: ReactNode; force?: boolean } = {}) => {
    if (env.protected || opts.force) setPending({ action, fn, danger: !!opts.danger, details: opts.details });
    else fn(undefined);
  };

  // The confirmation dialog to render.
  const dialog = (
    <ConfirmProtectedDialog
      open={!!pending}
      envSlug={env.slug}
      action={pending?.action ?? ''}
      details={pending?.details}
      danger={pending?.danger}
      busy={busy}
      onCancel={() => setPending(null)}
      onConfirm={(confirm) => {
        const p = pending;
        setPending(null);
        p?.fn(confirm);
      }}
    />
  );

  return { run, dialog };
}
