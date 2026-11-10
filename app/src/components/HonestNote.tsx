import type { ReactNode } from 'react';

export function HonestNote({ children }: { children: ReactNode }) {
  return (
    <p className="note" role="note">
      {children}
    </p>
  );
}
