import type { ReactNode } from 'react';
import { config } from '../config';

/** A repository file a copy string names in backticks (`docs/protocol.md`, `README.md`, `JUDGES.md`). */
const REPO_FILE = /^(README\.md|JUDGES\.md|docs\/[a-z-]+\.md)$/;

/** Copy strings mark bold words with `**` and commands with backticks; this sets them, nothing else. A backticked
 * repository file becomes a link into the source when the build knows the repository URL (VITE_REPO_URL). */
export function Rich({ text }: { text: string }): ReactNode {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/).map((part, i) => {
    if (part.startsWith('**')) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (!part.startsWith('`')) return part;
    const code = part.slice(1, -1);
    return config.repoUrl && REPO_FILE.test(code) ? (
      <a key={i} href={`${config.repoUrl}/blob/main/${code}`} target="_blank" rel="noreferrer">
        <code>{code}</code>
      </a>
    ) : (
      <code key={i}>{code}</code>
    );
  });
}
