import { useState } from 'react';
import { priceUnitLabel } from '../lib/amounts';
import { validateBid, type BidValidation } from '../lib/bidFlow';
import { tokenLabel } from '../lib/format';
import type { Sale } from '../lib/views';

export interface BidFormValues {
  p: bigint;
  q: bigint;
  B: bigint;
}

/** Price, size and escrow. Validation runs on submit against the sale and chain time; warnings never block. */
export function BidForm({
  sale,
  nowNs,
  disabled,
  onSubmit,
}: {
  sale: Sale;
  nowNs: bigint;
  disabled: boolean;
  onSubmit: (v: BidFormValues) => void;
}) {
  const [price, setPrice] = useState('');
  const [size, setSize] = useState('');
  const [escrow, setEscrow] = useState('');
  const [check, setCheck] = useState<BidValidation | null>(null);
  const unit = priceUnitLabel(tokenLabel(sale.token), sale.lotExp);

  const submit = (ev: React.FormEvent) => {
    ev.preventDefault();
    const res = validateBid({ priceText: price, sizeText: size, escrowText: escrow, sale, nowNs });
    setCheck(res);
    if (res.ok) onSubmit({ p: res.p, q: res.q, B: res.B });
  };

  return (
    <form onSubmit={submit} className="stack" autoComplete="off">
      <label className="field">
        <span>Price ({unit})</span>
        <input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="3.60" disabled={disabled} />
      </label>
      <label className="field">
        <span>Size: most you will spend (USDC)</span>
        <input inputMode="decimal" value={size} onChange={(e) => setSize(e.target.value)} placeholder="3" disabled={disabled} />
      </label>
      <label className="field">
        <span>Escrow: USDC locked with the bid (at least 1)</span>
        <input inputMode="decimal" value={escrow} onChange={(e) => setEscrow(e.target.value)} placeholder="3" disabled={disabled} />
      </label>
      <p className="small muted">
        Whatever you do not spend at the clearing price is refunded. If you never reveal, 10% of the escrow is forfeited to the bidders who did
        (never to the seller).
      </p>
      {check && !check.ok
        ? check.errors.map((e) => (
            <p key={e} className="result bad" role="alert">
              {e}
            </p>
          ))
        : null}
      {check?.ok
        ? check.warnings.map((w) => (
            <p key={w} className="note" role="note">
              {w}
            </p>
          ))
        : null}
      <div>
        <button type="submit" className="primary" disabled={disabled}>
          Continue
        </button>
      </div>
    </form>
  );
}
