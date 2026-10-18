/**
 * Environment colours. The server stores `color` as a string; we treat it as a palette name
 * (green, amber, red, blue, violet, cyan, pink, slate). Hex values are mapped to the nearest
 * palette entry by hue, and unknown values fall back to a slug heuristic (dev/staging/prod).
 * Class names are static so Tailwind can see them (no inline styles: strict CSP).
 */
// Supported palette names.
export const ENV_COLORS = ['green', 'amber', 'red', 'blue', 'violet', 'cyan', 'pink', 'slate'] as const;
export type EnvColor = (typeof ENV_COLORS)[number];

// Tailwind classes for a chip, a dot and a swatch.
interface ColorClasses {
  chip: string;
  dot: string;
  swatch: string;
}

// Static class names per colour (must be literal so Tailwind keeps them).
const CLASSES: Record<EnvColor, ColorClasses> = {
  green: {
    chip: 'bg-emerald-100 text-emerald-800 ring-emerald-300 dark:bg-emerald-900/40 dark:text-emerald-200 dark:ring-emerald-700',
    dot: 'bg-emerald-500',
    swatch: 'bg-emerald-500',
  },
  amber: {
    chip: 'bg-amber-100 text-amber-800 ring-amber-300 dark:bg-amber-900/40 dark:text-amber-200 dark:ring-amber-700',
    dot: 'bg-amber-500',
    swatch: 'bg-amber-500',
  },
  red: {
    chip: 'bg-red-100 text-red-800 ring-red-300 dark:bg-red-900/40 dark:text-red-200 dark:ring-red-700',
    dot: 'bg-red-500',
    swatch: 'bg-red-500',
  },
  blue: {
    chip: 'bg-blue-100 text-blue-800 ring-blue-300 dark:bg-blue-900/40 dark:text-blue-200 dark:ring-blue-700',
    dot: 'bg-blue-500',
    swatch: 'bg-blue-500',
  },
  violet: {
    chip: 'bg-violet-100 text-violet-800 ring-violet-300 dark:bg-violet-900/40 dark:text-violet-200 dark:ring-violet-700',
    dot: 'bg-violet-500',
    swatch: 'bg-violet-500',
  },
  cyan: {
    chip: 'bg-cyan-100 text-cyan-800 ring-cyan-300 dark:bg-cyan-900/40 dark:text-cyan-200 dark:ring-cyan-700',
    dot: 'bg-cyan-500',
    swatch: 'bg-cyan-500',
  },
  pink: {
    chip: 'bg-pink-100 text-pink-800 ring-pink-300 dark:bg-pink-900/40 dark:text-pink-200 dark:ring-pink-700',
    dot: 'bg-pink-500',
    swatch: 'bg-pink-500',
  },
  slate: {
    chip: 'bg-stone-100 text-stone-700 ring-stone-300 dark:bg-stone-800 dark:text-stone-200 dark:ring-stone-600',
    dot: 'bg-stone-500',
    swatch: 'bg-stone-500',
  },
};

// Other colour names mapped onto our palette.
const ALIASES: Record<string, EnvColor> = {
  emerald: 'green',
  yellow: 'amber',
  orange: 'amber',
  rose: 'red',
  indigo: 'violet',
  purple: 'violet',
  teal: 'cyan',
  gray: 'slate',
  grey: 'slate',
};

// Maps a hex colour to the nearest palette entry by hue.
function fromHex(hex: string): EnvColor | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  let h = m[1]!;
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d < 0.12) return 'slate';
  let hue: number;
  if (max === r) hue = ((g - b) / d) % 6;
  else if (max === g) hue = (b - r) / d + 2;
  else hue = (r - g) / d + 4;
  hue = (hue * 60 + 360) % 360;
  if (hue < 15 || hue >= 345) return 'red';
  if (hue < 65) return 'amber';
  if (hue < 165) return 'green';
  if (hue < 200) return 'cyan';
  if (hue < 250) return 'blue';
  if (hue < 300) return 'violet';
  return 'pink';
}

// Guesses a colour from the env name (prod = red, staging = amber, dev = green).
function fromSlug(slug: string): EnvColor {
  const s = slug.toLowerCase();
  if (/prod/.test(s)) return 'red';
  if (/stag|uat|pre/.test(s)) return 'amber';
  if (/dev|local|test/.test(s)) return 'green';
  return 'slate';
}

// Resolves any stored colour value to a palette name.
export function resolveEnvColor(color: string | null | undefined, slug = ''): EnvColor {
  const c = (color ?? '').trim().toLowerCase();
  if ((ENV_COLORS as readonly string[]).includes(c)) return c as EnvColor;
  if (c in ALIASES) return ALIASES[c]!;
  return fromHex(c) ?? fromSlug(slug);
}

// Tailwind classes for an environment's colour.
export function envColorClasses(color: string | null | undefined, slug = ''): ColorClasses {
  return CLASSES[resolveEnvColor(color, slug)];
}
