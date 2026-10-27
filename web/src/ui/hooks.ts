/** Small React helpers used across the UI. */
import { useEffect, useRef, useState } from 'react';

/** Smoothly animate a number towards `target` (used so numbers glide when you switch views). */
export function useTween(target: number, ms = 600): number {
  const [value, setValue] = useState(target);
  const fromRef = useRef(target);
  const valueRef = useRef(target);
  valueRef.current = value;

  useEffect(() => {
    if (!Number.isFinite(target)) {
      setValue(target);
      return;
    }
    const reduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const from = Number.isFinite(valueRef.current) ? valueRef.current : target;
    if (reduce || from === target) {
      setValue(target);
      return;
    }
    fromRef.current = from;
    const t0 = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - t0) / ms);
      const k = 1 - (1 - t) ** 3; // ease-out
      setValue(fromRef.current + (target - fromRef.current) * k);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);

  return value;
}

/** localStorage that never throws (private windows, blocked storage, previews). */
export const safeStorage = {
  get(key: string): string | null {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      /* storage unavailable: the app works without it */
    }
  },
};

/** Keep a ref that always holds the latest value (for event handlers registered once). */
export function useLatest<T>(value: T) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

export function useMediaQuery(query: string): boolean {
  const [match, setMatch] = useState(() => (typeof window !== 'undefined' ? window.matchMedia(query).matches : false));
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMatch(mq.matches);
    mq.addEventListener('change', on);
    on();
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return match;
}
