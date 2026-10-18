/** Client-side idle lock (mirrors the server's 15 minute idle timeout). */
import { useEffect, useRef } from 'react';

export const IDLE_LOCK_MS = 15 * 60_000;
// Events that count as user activity.
const EVENTS = ['pointerdown', 'pointermove', 'keydown', 'scroll', 'touchstart', 'wheel'] as const;

/**
 * Calls `onLock` once after `ms` without user activity. Activity resets the timer.
 * Disabled when `enabled` is false.
 */
export function useIdleLock(onLock: () => void, { enabled = true, ms = IDLE_LOCK_MS }: { enabled?: boolean; ms?: number } = {}) {
  // Keep the latest callback without re-arming the timer on every render.
  const cb = useRef(onLock);
  cb.current = onLock;

  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let fired = false;
    // (Re)start the countdown on each activity until it fires once.
    const arm = () => {
      if (fired) return;
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        fired = true;
        cb.current();
      }, ms);
    };
    arm();
    for (const ev of EVENTS) window.addEventListener(ev, arm, { passive: true, capture: true });
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      for (const ev of EVENTS) window.removeEventListener(ev, arm, { capture: true });
    };
  }, [enabled, ms]);
}
