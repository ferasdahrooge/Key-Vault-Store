/**
 * Shared UI primitives. Both page agents build on these — keep the props stable.
 * Styling is Tailwind only (no inline styles: strict CSP).
 */
import { forwardRef, useId, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from 'react';
import type { Role } from '../api/types';
import { envColorClasses } from '../lib/envColor';

// Joins class names, skipping falsy values.
export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

// Button styles per variant.
type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';
const VARIANTS: Record<Variant, string> = {
  primary: 'bg-brand-600 text-white hover:bg-brand-500 focus-visible:outline-brand-600 disabled:bg-brand-400',
  secondary:
    'bg-white text-stone-900 ring-1 ring-inset ring-stone-300 hover:bg-stone-50 dark:bg-stone-800 dark:text-stone-100 dark:ring-stone-600 dark:hover:bg-stone-700',
  danger: 'bg-red-600 text-white hover:bg-red-500 focus-visible:outline-red-600 disabled:bg-red-400',
  ghost: 'text-stone-700 hover:bg-stone-100 dark:text-stone-300 dark:hover:bg-stone-800',
};

// Button props: variant, size and a loading spinner.
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: 'sm' | 'md';
  loading?: boolean;
}

// Styled button; disabled while loading.
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', loading, disabled, className, children, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-md font-semibold shadow-sm transition focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-70',
        size === 'sm' ? 'px-2.5 py-1.5 text-xs' : 'px-3.5 py-2 text-sm',
        VARIANTS[variant],
        className,
      )}
      {...rest}
    >
      {loading && <Spinner className="size-4" />}
      {children}
    </button>
  );
});

// Small animated loading indicator.
export function Spinner({ className }: { className?: string }) {
  return (
    <svg className={cx('animate-spin', className ?? 'size-5')} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.25" strokeWidth="4" />
      <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
    </svg>
  );
}

// Shared styling for inputs, textareas and selects.
const fieldCls =
  'block w-full rounded-md border-0 bg-white px-3 py-2 text-sm text-stone-900 shadow-sm ring-1 ring-inset ring-stone-300 placeholder:text-stone-400 focus:ring-2 focus:ring-inset focus:ring-brand-600 disabled:opacity-60 dark:bg-stone-900 dark:text-stone-100 dark:ring-stone-600';

// Label, hint and error shared by form fields.
interface FieldWrapProps {
  label: string;
  hint?: ReactNode;
  error?: string | null;
}

// Labelled text input with hint and error message.
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & FieldWrapProps>(function Input(
  { label, hint, error, className, id, ...rest },
  ref,
) {
  const autoId = useId();
  const fid = id ?? autoId;
  return (
    <div className={className}>
      <label htmlFor={fid} className="block text-sm font-medium text-stone-700 dark:text-stone-300">
        {label}
      </label>
      <input
        ref={ref}
        id={fid}
        aria-invalid={!!error || undefined}
        aria-describedby={error ? `${fid}-err` : hint ? `${fid}-hint` : undefined}
        className={cx(fieldCls, 'mt-1', error && 'ring-red-500')}
        {...rest}
      />
      {hint && !error && (
        <p id={`${fid}-hint`} className="mt-1 text-xs text-stone-500 dark:text-stone-400">
          {hint}
        </p>
      )}
      <FieldError id={`${fid}-err`} error={error} />
    </div>
  );
});

// Labelled multi-line input (monospace).
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & FieldWrapProps>(
  function Textarea({ label, hint, error, className, id, ...rest }, ref) {
    const autoId = useId();
    const fid = id ?? autoId;
    return (
      <div className={className}>
        <label htmlFor={fid} className="block text-sm font-medium text-stone-700 dark:text-stone-300">
          {label}
        </label>
        <textarea
          ref={ref}
          id={fid}
          aria-invalid={!!error || undefined}
          className={cx(fieldCls, 'mt-1 font-mono', error && 'ring-red-500')}
          {...rest}
        />
        {hint && !error && <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">{hint}</p>}
        <FieldError id={`${fid}-err`} error={error} />
      </div>
    );
  },
);

// Labelled dropdown.
export function Select({
  label,
  value,
  onChange,
  options,
  className,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  className?: string;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className={className}>
      <label htmlFor={id} className="block text-sm font-medium text-stone-700 dark:text-stone-300">
        {label}
      </label>
      <select id={id} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} className={cx(fieldCls, 'mt-1')}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

// Inline validation message under a field.
export function FieldError({ error, id }: { error?: string | null; id?: string }) {
  if (!error) return null;
  return (
    <p id={id} role="alert" className="mt-1 text-xs text-red-600 dark:text-red-400">
      {error}
    </p>
  );
}

// Coloured message box (error, info, warning, success).
export function Alert({ kind = 'error', children }: { kind?: 'error' | 'info' | 'warning' | 'success'; children: ReactNode }) {
  const cls = {
    error: 'bg-red-50 text-red-800 ring-red-200 dark:bg-red-950/50 dark:text-red-200 dark:ring-red-900',
    info: 'bg-sky-50 text-sky-800 ring-sky-200 dark:bg-sky-950/50 dark:text-sky-200 dark:ring-sky-900',
    warning: 'bg-amber-50 text-amber-900 ring-amber-200 dark:bg-amber-950/50 dark:text-amber-200 dark:ring-amber-900',
    success: 'bg-emerald-50 text-emerald-800 ring-emerald-200 dark:bg-emerald-950/50 dark:text-emerald-200 dark:ring-emerald-900',
  }[kind];
  return (
    <div role={kind === 'error' ? 'alert' : 'status'} className={cx('rounded-md px-3 py-2 text-sm ring-1 ring-inset', cls)}>
      {children}
    </div>
  );
}

// Small pill label.
export function Badge({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset',
        className ?? 'bg-stone-100 text-stone-700 ring-stone-300 dark:bg-stone-800 dark:text-stone-300 dark:ring-stone-600',
      )}
    >
      {children}
    </span>
  );
}

// Badge colours per role.
const ROLE_CLS: Record<Role, string> = {
  owner: 'bg-brand-100 text-brand-800 ring-brand-300 dark:bg-brand-900/40 dark:text-brand-200 dark:ring-brand-700',
  editor: 'bg-sky-100 text-sky-800 ring-sky-300 dark:bg-sky-900/40 dark:text-sky-200 dark:ring-sky-700',
  viewer: 'bg-stone-100 text-stone-700 ring-stone-300 dark:bg-stone-800 dark:text-stone-300 dark:ring-stone-600',
};

// Shows a role, or "no access".
export function RoleBadge({ role }: { role: Role | null }) {
  if (!role) return <Badge>no access</Badge>;
  return <Badge className={ROLE_CLS[role]}>{role}</Badge>;
}

// Coloured environment label with an optional lock icon.
export function EnvChip({ name, slug, color, isProtected }: { name: string; slug: string; color?: string | null; isProtected?: boolean }) {
  const c = envColorClasses(color, slug);
  return (
    <span className={cx('inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset', c.chip)}>
      <span className={cx('size-1.5 rounded-full', c.dot)} aria-hidden="true" />
      {name}
      {isProtected && <LockIcon className="size-3" title="Protected environment" />}
    </span>
  );
}

// Padlock icon (accessible when given a title).
export function LockIcon({ className, title }: { className?: string; title?: string }) {
  return (
    <svg className={className ?? 'size-4'} viewBox="0 0 20 20" fill="currentColor" role={title ? 'img' : undefined} aria-hidden={title ? undefined : true}>
      {title && <title>{title}</title>}
      <path
        fillRule="evenodd"
        d="M10 1a4.5 4.5 0 0 0-4.5 4.5V9H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2h-.5V5.5A4.5 4.5 0 0 0 10 1Zm3 8V5.5a3 3 0 1 0-6 0V9h6Z"
        clipRule="evenodd"
      />
    </svg>
  );
}

// Placeholder box for empty lists.
export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-stone-300 p-8 text-center dark:border-stone-700">
      <p className="text-sm font-semibold text-stone-900 dark:text-stone-100">{title}</p>
      {children && <div className="mt-2 text-sm text-stone-500 dark:text-stone-400">{children}</div>}
    </div>
  );
}

// Page title, subtitle and action buttons.
export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-stone-900 dark:text-white">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}
