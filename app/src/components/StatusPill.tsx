import type { ReactNode } from 'react';

export type Tone = 'ok' | 'warn' | 'bad' | 'accent' | 'neutral';

export function StatusPill({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={tone === 'neutral' ? 'pill' : `pill ${tone}`}>{children}</span>;
}
