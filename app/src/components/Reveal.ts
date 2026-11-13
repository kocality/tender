import { useEffect, useRef, useState } from 'react';

/** Motion runs only in a browser that can tell what is on screen, and never under reduced motion. */
export function motionOk(): boolean {
  return typeof window !== 'undefined' && typeof IntersectionObserver !== 'undefined' && !(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false);
}

/**
 * Raises a block 14 px into place (styles.css `.rv`; it is never invisible) the first time it scrolls into view. Anything already
 * on screen, every block under reduced motion, and every block without IntersectionObserver is never hidden at all.
 */
export function useReveal<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !motionOk()) return undefined;
    const box = el.getBoundingClientRect();
    if (box.top < window.innerHeight && box.bottom > 0) return undefined;
    el.classList.add('rv');
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      el.classList.add('in');
      observer.disconnect();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return ref;
}

/** `false` until the block has been on screen for `delay` ms, then `true` for good; `true` at once when motion is off. */
export function useDoneOnView<T extends HTMLElement>(delay: number) {
  const ref = useRef<T>(null);
  const [done, setDone] = useState(() => !motionOk());
  useEffect(() => {
    const el = ref.current;
    if (done || !el) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        observer.disconnect();
        timer = setTimeout(() => setDone(true), delay);
      },
      { threshold: 0.5 },
    );
    observer.observe(el);
    return () => {
      observer.disconnect();
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return [ref, done] as const;
}
