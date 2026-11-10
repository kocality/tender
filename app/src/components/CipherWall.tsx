import { originBadge } from '../copy';
import { fromBase64, toHex } from '@tender/intents';
import { formatUsdc, shortId } from '../lib/format';
import type { Bid } from '../lib/views';
import { BlockLink } from './TxLink';

function ctPreview(ctB64: string): string {
  try {
    return toHex(fromBase64(ctB64)).slice(0, 48);
  } catch {
    return '(unreadable ciphertext)';
  }
}

/** Every bid as the chain stores it: a 48 hex character prefix of the 160-byte ciphertext, never a price. */
export function CipherWall({ bids }: { bids: Bid[] }) {
  if (bids.length === 0) return <p className="muted small">No bids yet. Sealed bids appear here as soon as they are stored on chain.</p>;
  return (
    <div className="wall">
      {bids.map((b) => (
        <div key={b.idx} className={`cipher ${b.state === 'Revealed' ? 'revealed' : b.state === 'Penalized' ? 'penalized' : ''}`}>
          <div className="row small">
            <strong>#{b.idx}</strong>
            <span className="mono">{shortId(b.bidder, 8, 6)}</span>
            <span>{formatUsdc(b.escrow)} USDC</span>
          </div>
          <div className="ct">{ctPreview(b.ct)}</div>
          <div className="row small muted">
            <span>{originBadge(b.origin)}</span>
            <span>
              block <BlockLink block={b.block.toString()} />
            </span>
            <span>{b.state}</span>
          </div>
        </div>
      ))}
    </div>
  );
}
