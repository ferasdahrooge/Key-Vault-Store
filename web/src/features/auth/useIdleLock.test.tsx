import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, fireEvent, renderHook } from '@testing-library/react';
import { IDLE_LOCK_MS, useIdleLock } from './useIdleLock';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it('locks after 15 minutes of inactivity', () => {
  const onLock = vi.fn();
  renderHook(() => useIdleLock(onLock));
  act(() => vi.advanceTimersByTime(IDLE_LOCK_MS - 1));
  expect(onLock).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(1));
  expect(onLock).toHaveBeenCalledTimes(1);
  act(() => vi.advanceTimersByTime(IDLE_LOCK_MS * 2));
  expect(onLock).toHaveBeenCalledTimes(1);
});

it('activity resets the timer', () => {
  const onLock = vi.fn();
  renderHook(() => useIdleLock(onLock));
  act(() => vi.advanceTimersByTime(IDLE_LOCK_MS - 1000));
  fireEvent.keyDown(window, { key: 'a' });
  act(() => vi.advanceTimersByTime(IDLE_LOCK_MS - 1000));
  expect(onLock).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(1000));
  expect(onLock).toHaveBeenCalledTimes(1);
});

it('does nothing when disabled', () => {
  const onLock = vi.fn();
  renderHook(() => useIdleLock(onLock, { enabled: false }));
  act(() => vi.advanceTimersByTime(IDLE_LOCK_MS * 2));
  expect(onLock).not.toHaveBeenCalled();
});
