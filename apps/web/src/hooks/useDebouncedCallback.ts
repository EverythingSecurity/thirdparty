import { useEffect, useMemo, useRef } from 'react';

/**
 * Debounce a callback — returns a stable-identity function that delays
 * invoking `fn` until `delay` ms have elapsed since the last call.
 *
 * Autosave use case (vendor portal): PATCH /vendor/responses/:qid should not
 * fire on every keystroke; ~500ms is a good balance between "immediate save"
 * and "one round-trip per idea".
 */
export function useDebouncedCallback<A extends unknown[]>(
  fn: (...args: A) => void,
  delay: number,
): (...args: A) => void {
  const ref = useRef(fn);
  useEffect(() => {
    ref.current = fn;
  }, [fn]);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  return useMemo(
    () =>
      (...args: A) => {
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => ref.current(...args), delay);
      },
    [delay],
  );
}
