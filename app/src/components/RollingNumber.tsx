import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { motionOk } from './Reveal';

/** How long the per-digit spans stay mounted: the last digit's delay plus the 600 ms rise (styles.css `.roll-d`). */
const ROLL_MS = 1100;

const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * A number read from the chain. Its digits rise into place once when it first comes into view, and again only when a
 * new read changes it: no intermediate values are ever drawn, and the separators stay still. The rest of the time it
 * is plain text (one word per number for a reader or a word count). Under reduced motion, or without
 * IntersectionObserver, it never moves.
 */
export function RollingNumber({ value, className }: { value: string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [rolling, setRolling] = useState(false);
  const last = useRef(value);

  useIsoLayoutEffect(() => {
    const el = ref.current;
    if (!el || !motionOk()) return undefined;
    const box = el.getBoundingClientRect();
    // Already on screen: roll before the first paint, so the number is never drawn and then hidden.
    if (box.top < window.innerHeight && box.bottom > 0) {
      setRolling(true);
      return undefined;
    }
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      observer.disconnect();
      setRolling(true);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (last.current === value) return;
    last.current = value;
    if (motionOk()) setRolling(true);
  }, [value]);

  useEffect(() => {
    if (!rolling) return undefined;
    const timer = setTimeout(() => setRolling(false), ROLL_MS);
    return () => clearTimeout(timer);
  }, [rolling, value]);

  let d = 0;
  return (
    <span ref={ref} className={className ? `rolling ${className}` : 'rolling'}>
      {rolling ? (
        <span key={value} className="roll" aria-label={value}>
          {[...value].map((c, i) =>
            /\d/.test(c) ? (
              <span key={i} className="roll-d" aria-hidden="true" style={{ animationDelay: `${(d++) * 70}ms` }}>
                {c}
              </span>
            ) : (
              <span key={i} aria-hidden="true">
                {c}
              </span>
            ),
          )}
        </span>
      ) : (
        value
      )}
    </span>
  );
}
