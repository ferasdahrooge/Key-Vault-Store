/** New-secret dialog and edit drawer (metadata, optional new value, versions + rollback, delete). */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { errorMessage } from '@/shared/api/client';
import { createSecret, deleteSecret, listVersions, rollbackSecret, updateSecret, type UpdateSecretInput } from './secrets.api';
import { SECRET_TYPES, type Environment, type SecretMeta, type SecretType } from '@/shared/api/types';
import { Dialog } from '@/shared/components/Dialog';
import { useToast } from '@/shared/components/Toast';
import { Alert, Button, Input, Select, Textarea } from '@/shared/components/ui';
import { formatDateTime } from '@/shared/lib/format';
import { SECRET_KEY_RE } from '@/shared/lib/format';
import { generatePassword } from '@/shared/lib/password';
import { useProtectedConfirm } from '../../useProtectedConfirm';

// Types edited in a textarea, and types that get a Generate button.
const MULTILINE: SecretType[] = ['cert', 'note', 'json'];
const GENERATABLE: SecretType[] = ['password', 'apikey'];

// Client-side check: JSON secrets must parse.
export function validateValue(type: SecretType, value: string): string | null {
  if (type === 'json' && value !== '') {
    try {
      JSON.parse(value);
    } catch {
      return 'Value must be valid JSON.';
    }
  }
  return null;
}

// Comma-separated text → unique, trimmed tags.
const parseTags = (s: string) =>
  Array.from(new Set(s.split(',').map((t) => t.trim()).filter(Boolean)));

// Convert between ISO timestamps and <input type=date> values.
const toDateInput = (iso: string | null) => (iso ? iso.slice(0, 10) : '');
const fromDateInput = (d: string) => (d ? new Date(`${d}T00:00:00Z`).toISOString() : null);

// React Query cache key for an environment's secret list.
export const secretsKey = (p: string, e: string) => ['secrets', p, e] as const;

// Value input: masked field or textarea, plus optional password generator.
function ValueField({ type, value, onChange, label, error, required }: { type: SecretType; value: string; onChange: (v: string) => void; label: string; error: string | null; required?: boolean }) {
  return (
    <div className="space-y-1">
      {MULTILINE.includes(type) ? (
        <Textarea label={label} value={value} onChange={(e) => onChange(e.target.value)} rows={6} error={error} spellCheck={false} autoComplete="off" required={required} />
      ) : (
        <Input label={label} type="password" value={value} onChange={(e) => onChange(e.target.value)} error={error} autoComplete="new-password" spellCheck={false} required={required} />
      )}
      {GENERATABLE.includes(type) && (
        <Button size="sm" variant="secondary" onClick={() => onChange(generatePassword(32))}>
          Generate
        </Button>
      )}
    </div>
  );
}

// Type dropdown options.
const typeOptions = SECRET_TYPES.map((t) => ({ value: t, label: t }));

// Dialog for creating a secret.
export function NewSecretDialog({ open, onClose, project, env }: { open: boolean; onClose: () => void; project: string; env: Environment }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [key, setKey] = useState('');
  const [type, setType] = useState<SecretType>('password');
  const [value, setValue] = useState('');
  const [description, setDescription] = useState('');
  const [tags, setTags] = useState('');
  const [expires, setExpires] = useState('');
  const [touched, setTouched] = useState(false);

  const reset = () => {
    setKey('');
    setType('password');
    setValue('');
    setDescription('');
    setTags('');
    setExpires('');
    setTouched(false);
  };

  const m = useMutation({
    mutationFn: () =>
      createSecret(project, env.slug, {
        key,
        value,
        type,
        description: description || undefined,
        tags: parseTags(tags),
        expiresAt: fromDateInput(expires),
      }),
    onSuccess: async () => {
      setValue('');
      await qc.invalidateQueries({ queryKey: secretsKey(project, env.slug) });
      toast.success(`Created ${key}`);
      reset();
      onClose();
    },
  });

  // Validation for key and value.
  const keyErr = touched && !SECRET_KEY_RE.test(key) ? 'Letters, digits, _ . - ; must start with a letter or _ (max 128).' : null;
  const valueErr = validateValue(type, value);
  const canSubmit = SECRET_KEY_RE.test(key) && value !== '' && !valueErr;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (canSubmit) m.mutate();
  };

  const close = () => {
    reset();
    m.reset();
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      dismissible={!m.isPending}
      title="New secret"
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={m.isPending}>
            Cancel
          </Button>
          <Button type="submit" form="new-secret-form" loading={m.isPending} disabled={!canSubmit}>
            Create
          </Button>
        </>
      }
    >
      <form id="new-secret-form" onSubmit={submit} className="space-y-3">
        {m.error && <Alert>{errorMessage(m.error)}</Alert>}
        <Input label="Key" value={key} onChange={(e) => setKey(e.target.value)} onBlur={() => setTouched(true)} error={keyErr} spellCheck={false} autoComplete="off" required data-autofocus />
        <Select label="Type" value={type} onChange={(v) => setType(v as SecretType)} options={typeOptions} />
        <ValueField type={type} value={value} onChange={setValue} label="Value" error={valueErr} required />
        <Input label="Description" value={description} onChange={(e) => setDescription(e.target.value)} />
        <Input label="Tags" hint="Comma separated" value={tags} onChange={(e) => setTags(e.target.value)} />
        <Input label="Expires" type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />
      </form>
    </Dialog>
  );
}

// Edit dialog: metadata, new value, version history, rollback and delete.
export function EditSecretDrawer({ secret, onClose, project, env, canEdit }: { secret: SecretMeta; onClose: () => void; project: string; env: Environment; canEdit: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [type, setType] = useState<SecretType>(secret.type);
  const [value, setValue] = useState('');
  const [description, setDescription] = useState(secret.description ?? '');
  const [tags, setTags] = useState(secret.tags.join(', '));
  const [expires, setExpires] = useState(toDateInput(secret.expiresAt));
  const [comment, setComment] = useState('');

  // Version history for this secret.
  const versionsQ = useQuery({ queryKey: ['versions', project, env.slug, secret.id], queryFn: () => listVersions(project, env.slug, secret.id) });

  const invalidate = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: secretsKey(project, env.slug) }),
      qc.invalidateQueries({ queryKey: ['versions', project, env.slug, secret.id] }),
      qc.invalidateQueries({ queryKey: ['compare', project] }),
    ]);
  };

  // Save changes (a new value creates a new version).
  const save = useMutation({
    mutationFn: (confirm: string | undefined) => {
      const body: UpdateSecretInput = { type, description, tags: parseTags(tags), expiresAt: fromDateInput(expires) };
      if (value) body.value = value;
      if (comment) body.comment = comment;
      if (confirm) body.confirm = confirm;
      return updateSecret(project, env.slug, secret.id, body);
    },
    onSuccess: async () => {
      setValue('');
      setComment('');
      await invalidate();
      toast.success(`Saved ${secret.key}`);
    },
  });
  // Restore an older version.
  const rollback = useMutation({
    mutationFn: ({ version, confirm }: { version: number; confirm?: string }) => rollbackSecret(project, env.slug, secret.id, version, confirm),
    onSuccess: async (_r, v) => {
      await invalidate();
      toast.success(`Rolled back to v${v.version}`);
    },
  });
  // Delete the secret.
  const del = useMutation({
    mutationFn: (confirm: string | undefined) => deleteSecret(project, env.slug, secret.id, confirm),
    onSuccess: async () => {
      await invalidate();
      toast.success(`Deleted ${secret.key}`);
      onClose();
    },
  });

  // Any action in flight disables the others.
  const busy = save.isPending || rollback.isPending || del.isPending;
  const pc = useProtectedConfirm(env, busy);
  const valueErr = validateValue(type, value);
  const err = save.error ?? rollback.error ?? del.error;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (valueErr || !canEdit) return;
    pc.run(`Save ${secret.key}`, (c) => save.mutate(c));
  };

  return (
    <>
      <Dialog
        open
        onClose={onClose}
        dismissible={!busy}
        size="xl"
        title={<span className="font-mono">{secret.key}</span>}
        description={`Current version v${secret.currentVersion}`}
        footer={
          canEdit ? (
            <>
              <Button
                variant="danger"
                className="mr-auto"
                disabled={busy}
                onClick={() => {
                  if (env.protected) pc.run(`Delete ${secret.key}`, (c) => del.mutate(c), { danger: true });
                  else if (window.confirm(`Delete ${secret.key}?`)) del.mutate(undefined);
                }}
              >
                Delete
              </Button>
              <Button variant="secondary" onClick={onClose} disabled={busy}>
                Close
              </Button>
              <Button type="submit" form="edit-secret-form" loading={save.isPending} disabled={!!valueErr || busy}>
                Save
              </Button>
            </>
          ) : (
            <Button variant="secondary" onClick={onClose}>
              Close
            </Button>
          )
        }
      >
        <div className="grid gap-6 md:grid-cols-2">
          <form id="edit-secret-form" onSubmit={submit} className="space-y-3">
            {err && <Alert>{errorMessage(err)}</Alert>}
            <fieldset disabled={!canEdit} className="space-y-3">
              <Select label="Type" value={type} onChange={(v) => setType(v as SecretType)} options={typeOptions} disabled={!canEdit} />
              {canEdit && <ValueField type={type} value={value} onChange={setValue} label="New value (optional)" error={valueErr} />}
              <Input label="Description" value={description} onChange={(e) => setDescription(e.target.value)} />
              <Input label="Tags" hint="Comma separated" value={tags} onChange={(e) => setTags(e.target.value)} />
              <Input label="Expires" type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />
              {canEdit && <Input label="Comment" value={comment} onChange={(e) => setComment(e.target.value)} hint="Recorded with the new version" />}
            </fieldset>
          </form>
          <section aria-labelledby="versions-h">
            <h3 id="versions-h" className="mb-2 text-sm font-semibold">
              Versions
            </h3>
            {versionsQ.isLoading && <p className="text-sm text-stone-500">Loading…</p>}
            {versionsQ.error && <Alert>{errorMessage(versionsQ.error)}</Alert>}
            <ul className="divide-y divide-stone-200 rounded-md ring-1 ring-stone-200 dark:divide-stone-700 dark:ring-stone-700">
              {versionsQ.data?.versions.map((v) => (
                <li key={v.version} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                  <div className="min-w-0">
                    <div className="font-medium">
                      v{v.version}
                      {v.version === secret.currentVersion && <span className="ml-2 text-xs text-emerald-600">current</span>}
                    </div>
                    <div className="truncate text-xs text-stone-500">
                      {formatDateTime(v.createdAt)} · {v.createdBy?.name ?? 'system'}
                      {v.comment ? ` · ${v.comment}` : ''}
                    </div>
                  </div>
                  {canEdit && v.version !== secret.currentVersion && (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy}
                      onClick={() => pc.run(`Roll back ${secret.key} to v${v.version}`, (c) => rollback.mutate({ version: v.version, confirm: c }))}
                    >
                      Rollback
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </section>
        </div>
      </Dialog>
      {pc.dialog}
    </>
  );
}
