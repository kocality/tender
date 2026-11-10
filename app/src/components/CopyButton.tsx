import { useState } from 'react';

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const onClick = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setState('copied');
    } catch {
      setState('failed');
    }
    setTimeout(() => setState('idle'), 1500);
  };
  return (
    <>
      <button type="button" onClick={onClick}>
        {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : label}
      </button>
      <span className="sr-only" role="status">
        {state === 'copied' ? 'Copied to the clipboard' : state === 'failed' ? 'Copy failed, select the text and copy it yourself' : ''}
      </span>
    </>
  );
}
