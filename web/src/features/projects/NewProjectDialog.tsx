/** Dialog to create a project with its initial environments (dev/staging/prod by default). */
import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createProject } from './projects.api';
import { errorMessage } from '@/shared/api/client';
import type { NewEnvironmentInput } from '@/shared/api/types';
import { ENV_COLORS } from '@/shared/lib/envColor';
import { SLUG_RE } from '@/shared/lib/format';
import { Dialog } from '@/shared/components/Dialog';
import { useToast } from '@/shared/components/Toast';
import { Alert, Button, Input, Select, Textarea } from '@/shared/components/ui';

// One editable environment row in the form.
type Row = Required<NewEnvironmentInput> & { key: number };
// Stable React keys for environment rows (slugs can be edited, so they can't be the key).
let nextKey = 1;
// Helpers to build rows and the default dev/staging/prod set.
const row = (slug: string, name: string, color: string, prot = false): Row => ({ key: nextKey++, slug, name, color, protected: prot });
const defaults = () => [row('dev', 'Development', 'green'), row('staging', 'Staging', 'amber'), row('prod', 'Production', 'red', true)];

// Form dialog for creating a project (admin only).
export function NewProjectDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [envs, setEnvs] = useState<Row[]>(defaults);

  // Clear the form after a successful create.
  const reset = () => {
    setSlug('');
    setName('');
    setDescription('');
    setEnvs(defaults());
  };
  // Create the project, refresh the project list, close the dialog.
  const m = useMutation({
    mutationFn: () =>
      createProject({
        slug,
        name: name.trim(),
        description: description.trim() || undefined,
        environments: envs.map(({ key: _k, ...e }) => ({ ...e, name: e.name.trim() })),
      }),
    onSuccess: () => {
      toast.success('Project created.');
      void qc.invalidateQueries({ queryKey: ['projects'] });
      reset();
      m.reset();
      onClose();
    },
  });

  // Update one environment row.
  const update = (key: number, patch: Partial<Row>) => setEnvs((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  // Form is valid when all slugs/names are valid and env slugs are unique.
  const slugs = envs.map((e) => e.slug);
  const envErrors = envs.some((e) => !SLUG_RE.test(e.slug) || !e.name.trim()) || new Set(slugs).size !== slugs.length;
  const valid = SLUG_RE.test(slug) && name.trim() && envs.length > 0 && !envErrors;

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (valid) m.mutate();
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      dismissible={!m.isPending}
      size="lg"
      title="New project"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={m.isPending}>
            Cancel
          </Button>
          <Button type="submit" form="new-project-form" loading={m.isPending} disabled={!valid}>
            Create project
          </Button>
        </>
      }
    >
      <form id="new-project-form" onSubmit={onSubmit} className="space-y-4">
        {m.isError && <Alert>{errorMessage(m.error)}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label="Slug"
            required
            value={slug}
            onChange={(e) => setSlug(e.target.value.toLowerCase())}
            hint="Lowercase letters, digits and dashes."
            error={slug && !SLUG_RE.test(slug) ? 'Invalid slug.' : null}
          />
          <Input label="Name" required value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <Textarea label="Description" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        <fieldset className="space-y-3">
          <legend className="text-sm font-medium">Environments</legend>
          {envs.map((r, i) => (
            <div key={r.key} className="grid items-end gap-2 rounded-md p-2 ring-1 ring-stone-200 sm:grid-cols-[1fr_1fr_8rem_auto_auto] dark:ring-stone-700">
              <Input label={`Env ${i + 1} slug`} value={r.slug} onChange={(e) => update(r.key, { slug: e.target.value.toLowerCase() })} error={r.slug && !SLUG_RE.test(r.slug) ? 'Invalid' : null} />
              <Input label={`Env ${i + 1} name`} value={r.name} onChange={(e) => update(r.key, { name: e.target.value })} />
              <Select label="Colour" value={r.color} onChange={(v) => update(r.key, { color: v })} options={ENV_COLORS.map((c) => ({ value: c, label: c }))} />
              <label className="flex items-center gap-2 pb-2 text-sm">
                <input type="checkbox" className="size-4" checked={r.protected} onChange={(e) => update(r.key, { protected: e.target.checked })} />
                Protected
              </label>
              <Button variant="ghost" size="sm" aria-label={`Remove environment ${r.slug || i + 1}`} onClick={() => setEnvs((rs) => rs.filter((x) => x.key !== r.key))}>
                Remove
              </Button>
            </div>
          ))}
          {new Set(slugs).size !== slugs.length && <Alert>Environment slugs must be unique.</Alert>}
          <Button variant="secondary" size="sm" onClick={() => setEnvs((rs) => [...rs, row('', '', 'blue')])}>
            Add environment
          </Button>
        </fieldset>
      </form>
    </Dialog>
  );
}
