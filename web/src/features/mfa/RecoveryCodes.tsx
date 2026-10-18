/** Shows freshly issued recovery codes once, with copy/download and a confirmation checkbox. */
import { useId, useState } from 'react';
import { downloadText } from '@/shared/lib/download';
import { CopyButton } from '@/shared/components/CopyButton';
import { Alert, Button } from '@/shared/components/ui';

// Props: the codes, and what to do once the user confirms they saved them.
export interface RecoveryCodesProps {
  codes: string[];
  onDone: () => void;
  doneLabel?: string;
}

/** One-time display of recovery codes, gated by an "I saved them" checkbox. */
export function RecoveryCodes({ codes, onDone, doneLabel = 'Continue' }: RecoveryCodesProps) {
  const [saved, setSaved] = useState(false);
  const id = useId();
  const text = codes.join('\n');
  return (
    <div className="space-y-4">
      <Alert kind="warning">
        These recovery codes are shown only once. Each code works one time if you lose access to your other factors.
      </Alert>
      <ol aria-label="Recovery codes" className="grid grid-cols-2 gap-2 rounded-md bg-stone-100 p-4 font-mono text-sm dark:bg-stone-800">
        {codes.map((c) => (
          <li key={c} className="select-all">
            {c}
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap gap-2">
        <CopyButton value={text} label="Copy codes" />
        <Button variant="secondary" size="sm" onClick={() => downloadText(text + '\n', 'key-vault-recovery-codes.txt')}>
          Download .txt
        </Button>
      </div>
      <div className="flex items-center gap-2">
        <input id={id} type="checkbox" className="size-4" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
        <label htmlFor={id} className="text-sm">
          I saved these codes somewhere safe
        </label>
      </div>
      <Button disabled={!saved} onClick={onDone}>
        {doneLabel}
      </Button>
    </div>
  );
}
