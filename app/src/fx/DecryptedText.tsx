// Adapted from React Bits (https://github.com/DavidHDev/react-bits), src/ts-default/TextAnimations/DecryptedText/DecryptedText.tsx
// at commit 9d9c687dc4f55b23539aa5417b703078047efa74. Copyright (c) 2026 David Haz. MIT + Commons Clause License Condition v1.0:
// see LICENSES/react-bits.txt. Modified by Tender contributors: no motion/react dependency; controlled by a `revealed`
// prop instead of hover, click or view triggers; only the sequential scramble effect; and while sealed it draws a fixed
// number of glyphs chosen by position only, so nothing on the page (glyphs, widths or hidden text) is derived from a
// value that is still sealed. Each cell is 1ch wide (Tender sets every number in a monospaced face).

import { useEffect, useLayoutEffect, useRef, useState } from 'react';

const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

const isSpace = (char: string) => /\s/.test(char);

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false);

export interface DecryptedTextProps {
  /** The value, shown once `revealed`. */
  text: string;
  revealed: boolean;
  /** Also play the reveal when the component mounts already revealed (a result that has just arrived). */
  animateOnMount?: boolean;
  /** Milliseconds before the reveal starts. */
  delay?: number;
  /** Milliseconds per tick. */
  speed?: number;
  /** Scrambled ticks before the first character lands. */
  maxIterations?: number;
  characters?: string;
  /** Glyphs drawn while sealed. */
  sealedLength?: number;
  /** Accessible name while sealed. */
  sealedLabel?: string;
  className?: string;
  encryptedClassName?: string;
}

export default function DecryptedText({
  text,
  revealed,
  animateOnMount = false,
  delay = 0,
  speed = 60,
  maxIterations = 6,
  characters = '░▒▓█◆◇',
  sealedLength = 4,
  sealedLabel = 'sealed',
  className = '',
  encryptedClassName = '',
}: DecryptedTextProps) {
  const pool = Array.from(characters);
  const [frame, setFrame] = useState<{ shown: string[]; revealed: boolean[] } | null>(null);
  const wasRevealed = useRef<boolean | null>(null);

  useIsomorphicLayoutEffect(() => {
    const first = wasRevealed.current === null;
    const before = wasRevealed.current;
    wasRevealed.current = revealed;
    const play = revealed && (first ? animateOnMount : before === false);
    if (!play || prefersReducedMotion()) {
      setFrame(null);
      return undefined;
    }
    const chars = Array.from(text);
    const mask = chars.map(isSpace);
    const queue = chars.map((_, i) => i).filter((i) => !mask[i]);
    const glyph = () => pool[Math.floor(Math.random() * pool.length)] ?? '';
    const paint = () => setFrame({ shown: chars.map((c, i) => (mask[i] ? c : glyph())), revealed: mask.slice() });
    paint();
    let tick = 0;
    let timer: ReturnType<typeof setInterval> | undefined;
    const start = setTimeout(() => {
      timer = setInterval(() => {
        tick += 1;
        if (tick > maxIterations) {
          const index = queue.shift();
          if (index !== undefined) mask[index] = true;
        }
        if (queue.length === 0) {
          clearInterval(timer);
          setFrame(null);
          return;
        }
        paint();
      }, Math.max(16, speed));
    }, delay);
    return () => {
      clearTimeout(start);
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealed, text]);

  if (!revealed) {
    return (
      <span className={`decrypted sealed ${encryptedClassName}`.trim()} role="img" aria-label={sealedLabel}>
        {Array.from({ length: sealedLength }, (_, i) => (
          <span key={i} className="dt-cell" aria-hidden="true">
            {pool[(i * 7 + 3) % pool.length]}
          </span>
        ))}
      </span>
    );
  }
  if (!frame) return <span className={`decrypted ${className}`.trim()}>{text}</span>;
  return (
    <span className="decrypted running">
      <span className="sr-only">{text}</span>
      <span aria-hidden="true">
        {frame.shown.map((c, i) => (
          <span key={i} className={frame.revealed[i] ? `dt-cell on ${className}`.trim() : `dt-cell ${encryptedClassName}`.trim()}>
            {c}
          </span>
        ))}
      </span>
    </span>
  );
}
