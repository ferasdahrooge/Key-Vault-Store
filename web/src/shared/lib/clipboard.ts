/** Clipboard helpers. Secrets are copied with a timed clear so they don't linger. */
// Copied secrets are cleared from the clipboard after 30 s.
export const CLIPBOARD_CLEAR_MS = 30_000;

/**
 * Copies `value` and schedules clearing the clipboard after `ms`.
 * The clipboard is only cleared if it still contains `value` (checked with readText when permitted);
 * if reading is not permitted we attempt to clear it anyway.
 * Returns a cancel function for the scheduled clear.
 */
export async function copyWithAutoClear(value: string, ms = CLIPBOARD_CLEAR_MS): Promise<() => void> {
  const cb = navigator.clipboard;
  if (!cb?.writeText) throw new Error('Clipboard is not available');
  await cb.writeText(value);
  const timer = setTimeout(() => {
    void clearIfUnchanged(value);
  }, ms);
  return () => clearTimeout(timer);
}

// Empties the clipboard unless the user has copied something else since.
export async function clearIfUnchanged(value: string): Promise<void> {
  const cb = navigator.clipboard;
  if (!cb) return;
  let current: string | null = null;
  try {
    current = cb.readText ? await cb.readText() : null;
  } catch {
    current = null; // not permitted
  }
  if (current !== null && current !== value) return; // user copied something else
  try {
    await cb.writeText('');
  } catch {
    // document may not be focused; nothing more we can do
  }
}

/** Plain copy for non-secret strings (invite URLs, public keys). */
export async function copyText(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}
