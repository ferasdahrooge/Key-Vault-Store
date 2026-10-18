/** Protected environments: the user must type the env slug to confirm a destructive/changing action. */
import { useEffect, useState, type ReactNode } from 'react';
import { Dialog } from '@/shared/components/Dialog';
import { Button, Input } from '@/shared/components/ui';

// Props for the type-the-slug confirmation dialog.
export interface ConfirmProtectedDialogProps {
  open: boolean;
  envSlug: string;
  /** e.g. "Delete STRIPE_KEY" */
  action: string;
  details?: ReactNode;
  danger?: boolean;
  busy?: boolean;
  onCancel: () => void;
  /** Receives the typed slug — send it as `confirm` to the API. */
  onConfirm: (confirm: string) => void;
}

// Modal that only enables Confirm once the slug is typed exactly.
export function ConfirmProtectedDialog({ open, envSlug, action, details, danger, busy, onCancel, onConfirm }: ConfirmProtectedDialogProps) {
  const [typed, setTyped] = useState('');
  // Clear the input each time the dialog opens.
  useEffect(() => {
    if (open) setTyped('');
  }, [open]);
  const ok = typed === envSlug;

  return (
    <Dialog
      open={open}
      onClose={onCancel}
      dismissible={!busy}
      title={action}
      description={`${envSlug} is a protected environment.`}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} disabled={!ok} loading={busy} onClick={() => onConfirm(typed)}>
            Confirm
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (ok && !busy) onConfirm(typed);
        }}
      >
        {details && <div className="mb-3 text-sm text-stone-700 dark:text-stone-300">{details}</div>}
        <Input
          label={`Type "${envSlug}" to confirm`}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          data-autofocus
        />
      </form>
    </Dialog>
  );
}
