/** Environment settings: name, colour, protection, and DEK rotation. */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { errorMessage } from '@/shared/api/client';
import { rotateKey, updateEnvironment } from '@/features/projects/projects.api';
import type { Environment } from '@/shared/api/types';
import { Dialog } from '@/shared/components/Dialog';
import { useToast } from '@/shared/components/Toast';
import { Alert, Button, Input, cx } from '@/shared/components/ui';
import { ENV_COLORS, envColorClasses, resolveEnvColor } from '@/shared/lib/envColor';
import { useProtectedConfirm } from '../../useProtectedConfirm';

// Form for name/colour/protection, plus key rotation.
export function SettingsTab({ project, env }: { project: string; env: Environment }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState(env.name);
  const [color, setColor] = useState<string>(resolveEnvColor(env.color, env.slug));
  const [prot, setProt] = useState(env.protected);
  const [rotateOpen, setRotateOpen] = useState(false);
  const [rotated, setRotated] = useState<{ dekVersion: number; reencrypted: number } | null>(null);

  // Refresh project data after a change.
  const invalidate = () =>
    Promise.all([qc.invalidateQueries({ queryKey: ['project', project] }), qc.invalidateQueries({ queryKey: ['projects'] })]);

  // Save settings.
  const save = useMutation({
    mutationFn: (confirm?: string) => updateEnvironment(project, env.slug, { name: name.trim(), color, protected: prot, confirm }),
    onSuccess: async () => {
      await invalidate();
      toast.success('Environment updated');
    },
  });
  // Rotate the environment's data key.
  const rotate = useMutation({
    mutationFn: (confirm?: string) => rotateKey(project, env.slug, confirm),
    onSuccess: async (r) => {
      setRotated({ dekVersion: r.dekVersion, reencrypted: r.reencrypted });
      setRotateOpen(false);
      toast.success(`Key rotated — ${r.reencrypted} version(s) re-encrypted`);
      await invalidate();
    },
  });
  // Protected envs: the server requires `confirm` = env slug for settings changes and key rotation.
  const pc = useProtectedConfirm(env, rotate.isPending || save.isPending);

  // Protected envs ask for the slug before saving.
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    if (env.protected) pc.run('Save environment settings', (confirm) => save.mutate(confirm), { danger: !prot });
    else save.mutate(undefined);
  };

  return (
    <div className="max-w-2xl space-y-6">
      <form onSubmit={submit} className="space-y-4 rounded-lg p-4 ring-1 ring-stone-200 dark:ring-stone-700">
        {save.error && <Alert>{errorMessage(save.error)}</Alert>}
        <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} required />
        <fieldset>
          <legend className="text-sm font-medium">Colour</legend>
          <div className="mt-2 flex flex-wrap gap-2">
            {ENV_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={c}
                aria-pressed={color === c}
                onClick={() => setColor(c)}
                className={cx(
                  'size-8 rounded-full ring-offset-2 dark:ring-offset-stone-900',
                  envColorClasses(c).swatch,
                  color === c ? 'ring-2 ring-stone-900 dark:ring-white' : 'ring-1 ring-black/10',
                )}
              />
            ))}
          </div>
        </fieldset>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={prot} onChange={(e) => setProt(e.target.checked)} />
          Protected (changes require typing the environment slug; reveals require recent MFA)
        </label>
        <Button type="submit" loading={save.isPending}>Save</Button>
      </form>

      <section aria-labelledby="danger-h" className="space-y-3 rounded-lg p-4 ring-1 ring-red-300 dark:ring-red-800">
        <h3 id="danger-h" className="font-semibold text-red-700 dark:text-red-300">Danger zone</h3>
        <p className="text-sm">Generate a new data encryption key and re-encrypt every secret version in this environment.</p>
        {rotate.error && <Alert>{errorMessage(rotate.error)}</Alert>}
        {rotated && <Alert kind="success">Rotated to key v{rotated.dekVersion}; {rotated.reencrypted} version(s) re-encrypted.</Alert>}
        <Button variant="danger" onClick={() => (env.protected ? pc.run('Rotate encryption key', (confirm) => rotate.mutate(confirm), { danger: true }) : setRotateOpen(true))} loading={rotate.isPending}>
          Rotate encryption key
        </Button>
      </section>

      <Dialog
        open={rotateOpen}
        onClose={() => setRotateOpen(false)}
        dismissible={!rotate.isPending}
        title="Rotate encryption key?"
        description="All secret versions will be re-encrypted in a single transaction."
        footer={
          <>
            <Button variant="secondary" onClick={() => setRotateOpen(false)} disabled={rotate.isPending}>Cancel</Button>
            <Button variant="danger" loading={rotate.isPending} onClick={() => rotate.mutate(undefined)}>Rotate</Button>
          </>
        }
      >
        <p className="text-sm">This cannot be undone.</p>
      </Dialog>
      {pc.dialog}
    </div>
  );
}
