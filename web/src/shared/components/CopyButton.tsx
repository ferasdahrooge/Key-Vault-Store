/** Copy-to-clipboard button with a short "Copied" state; can auto-clear the clipboard for secrets. */
import { useEffect, useRef, useState } from 'react';
import { copyText, copyWithAutoClear } from '../lib/clipboard';
import { Button, type ButtonProps } from './ui';
import { useToast } from './Toast';

// Props for CopyButton (all Button props except onClick/value).
export interface CopyButtonProps extends Omit<ButtonProps, 'onClick' | 'value'> {
  /** Text to copy, or an async getter (e.g. reveal-then-copy). */
  value: string | (() => Promise<string>);
  /** Clear the clipboard after 30 s if unchanged (use for secrets). */
  autoClear?: boolean;
  label?: string;
  /** Toast shown on success. */
  successMessage?: string;
}

/** Copies `value` (string or async getter) and shows "Copied" for 2 s. */
export function CopyButton({ value, autoClear, label = 'Copy', successMessage, variant = 'secondary', size = 'sm', ...rest }: CopyButtonProps) {
  const [state, setState] = useState<'idle' | 'busy' | 'copied'>('idle');
  const toast = useToast();
  const t = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(t.current), []);

  // Resolve the text, copy it, then flash "Copied" for 2 s.
  const onClick = async () => {
    setState('busy');
    try {
      const text = typeof value === 'string' ? value : await value();
      if (autoClear) await copyWithAutoClear(text);
      else await copyText(text);
      setState('copied');
      if (successMessage) toast.success(successMessage);
      clearTimeout(t.current);
      t.current = setTimeout(() => setState('idle'), 2000);
    } catch {
      setState('idle');
      toast.error('Could not copy to the clipboard.');
    }
  };

  return (
    <Button variant={variant} size={size} loading={state === 'busy'} onClick={onClick} {...rest}>
      {state === 'copied' ? 'Copied' : label}
    </Button>
  );
}
