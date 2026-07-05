import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDebouncedCallback } from './useDebouncedCallback';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('useDebouncedCallback', () => {
  it('invokes only once after rapid calls settle', () => {
    const spy = vi.fn();
    const { result } = renderHook(() => useDebouncedCallback(spy, 500));
    act(() => {
      result.current('a');
      result.current('b');
      result.current('c');
    });
    expect(spy).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('c');
  });

  it('resets the timer on each call', () => {
    const spy = vi.fn();
    const { result } = renderHook(() => useDebouncedCallback(spy, 500));
    act(() => {
      result.current('a');
      vi.advanceTimersByTime(400);
      result.current('b');
      vi.advanceTimersByTime(400);
    });
    // Still not called — 400ms then another 400ms, but timer reset at 400ms.
    expect(spy).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(spy).toHaveBeenCalledOnce();
    expect(spy).toHaveBeenCalledWith('b');
  });

  it('uses the latest callback identity, not a stale closure', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { result, rerender } = renderHook(({ fn }) => useDebouncedCallback(fn, 100), {
      initialProps: { fn: first },
    });
    act(() => {
      result.current('x');
    });
    rerender({ fn: second });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith('x');
  });
});
