import { useState } from 'react';
import { parsePastedBid, sealCommand, type PastedBid } from '../lib/pasteSealed';

/** Use a bid sealed offline with `pnpm seal:bid`: the browser never sees the price. Salt, if present, is ignored. */
export function PasteSealedBid({
  saleId,
  signerId,
  disabled,
  onSubmit,
}: {
  saleId: string;
  signerId: string | null;
  disabled: boolean;
  onSubmit: (bid: PastedBid) => void;
}) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saltIgnored, setSaltIgnored] = useState(false);

  const submit = (ev: React.FormEvent) => {
    ev.preventDefault();
    const res = parsePastedBid(text, saleId);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    if (signerId && res.bid.signer && res.bid.signer !== signerId) {
      setError(`This bid was sealed for ${res.bid.signer}, but the connected account is ${signerId}.`);
      return;
    }
    setError(null);
    setSaltIgnored(res.bid.saltIgnored);
    onSubmit(res.bid);
  };

  return (
    <form onSubmit={submit} className="stack">
      <label className="field">
        <span>
          JSON printed by <code>pnpm seal:bid</code>
        </span>
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={5} spellCheck={false} disabled={disabled} />
      </label>
      <p className="small muted">
        This <code>cm</code> must have been computed for signer <span className="mono">{signerId ?? '<connect a wallet first>'}</span>. If not, re-run:
      </p>
      <pre className="payload">{sealCommand(saleId, signerId ?? '<signerId>')}</pre>
      {saltIgnored ? <p className="note">salt is not used or sent</p> : null}
      {error ? (
        <p className="result bad" role="alert">
          {error}
        </p>
      ) : null}
      <div>
        <button type="submit" className="primary" disabled={disabled || signerId === null}>
          Use this sealed bid
        </button>
      </div>
    </form>
  );
}
