/** Dialog to ask an environment's owners for time-boxed access (role, reason, duration). */
import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { requestAccess } from './accessRequests.api';
import { errorMessage } from '@/shared/api/client';
import type { Role } from '@/shared/api/types';
import { ACCESS_REQUESTS_KEY } from './useAccessRequests';
import { formatDuration } from '@/shared/lib/format';
import { Dialog } from '@/shared/components/Dialog';
import { useToast } from '@/shared/components/Toast';
import { Alert, Button, Select, Textarea } from '@/shared/components/ui';

/** Offered durations in minutes: 1 h, 4 h, 8 h, 1 day, 1 week. */
export const ACCESS_DURATIONS = [60, 240, 480, 1440, 10080] as const;

// Which environment the request is for.
export interface RequestAccessDialogProps {
  open: boolean;
  onClose: () => void;
  project: { slug: string; name: string };
  env: { slug: string; name: string };
}

// Form dialog that sends an access request.
export function RequestAccessDialog({ open, onClose, project, env }: RequestAccessDialogProps) {
  const qc = useQueryClient();
  const toast = useToast();
  const [role, setRole] = useState<Role>('viewer');
  const [reason, setReason] = useState('');
  const [duration, setDuration] = useState('240');
  // Send the request, refresh the request list, close the dialog.
  const m = useMutation({
    mutationFn: () => requestAccess(project.slug, env.slug, { role, reason: reason.trim(), durationMin: Number(duration) }),
    onSuccess: () => {
      toast.success('Access request sent to the environment owners.');
      void qc.invalidateQueries({ queryKey: ACCESS_REQUESTS_KEY });
      setReason('');
      m.reset();
      onClose();
    },
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (reason.trim()) m.mutate();
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      dismissible={!m.isPending}
      title={`Request access to ${project.name} / ${env.name}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={m.isPending}>
            Cancel
          </Button>
          <Button type="submit" form="request-access-form" loading={m.isPending} disabled={!reason.trim()}>
            Send request
          </Button>
        </>
      }
    >
      <form id="request-access-form" onSubmit={onSubmit} className="space-y-4">
        {m.isError && <Alert>{errorMessage(m.error)}</Alert>}
        <Select
          label="Role"
          value={role}
          onChange={(v) => setRole(v as Role)}
          options={[
            { value: 'viewer', label: 'Viewer (read secrets)' },
            { value: 'editor', label: 'Editor (change secrets)' },
            { value: 'owner', label: 'Owner (manage environment)' },
          ]}
        />
        <Select
          label="Duration"
          value={duration}
          onChange={setDuration}
          options={ACCESS_DURATIONS.map((d) => ({ value: String(d), label: formatDuration(d) }))}
        />
        <Textarea label="Reason" required rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
      </form>
    </Dialog>
  );
}
