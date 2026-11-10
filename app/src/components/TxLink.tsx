import { config } from '../config';

export function shorten(s: string, head = 8, tail = 6): string {
  return s.length <= head + tail + 1 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`;
}

export function TxLink({ hash, label }: { hash: string; label?: string }) {
  return (
    <a className="mono" href={`${config.explorerUrl}/txns/${hash}`} target="_blank" rel="noreferrer">
      {label ?? shorten(hash)}
    </a>
  );
}

export function BlockLink({ block }: { block: number | string }) {
  return (
    <a className="mono" href={`${config.explorerUrl}/blocks/${block}`} target="_blank" rel="noreferrer">
      {block}
    </a>
  );
}
