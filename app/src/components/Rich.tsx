import type { ReactNode } from 'react';

/** Copy strings mark bold words with `**` and commands with backticks; this sets them, nothing else. */
export function Rich({ text }: { text: string }): ReactNode {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/).map((part, i) =>
    part.startsWith('**') ? <strong key={i}>{part.slice(2, -2)}</strong> : part.startsWith('`') ? <code key={i}>{part.slice(1, -1)}</code> : part,
  );
}
