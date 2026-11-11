import { useRef, useState } from 'react';
import { priceUnitLabel } from '../lib/amounts';
import { fieldOfError, submitDecision, validateBid, type BidValidation } from '../lib/bidFlow';
import { tokenLabel } from '../lib/format';
import type { Sale } from '../lib/views';

export interface BidFormValues {
  p: bigint;
  q: bigint;
  B: bigint;
}

/**
 * Price, size and escrow. Validation runs on submit against the sale and chain time. A bid with warnings needs a
 * second click on the same values, so the warning is read before the wizard moves on.
 */
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
  /** Counts submits, so a repeated identical error is a new alert node and is announced again. */
  const [attempt, setAttempt] = useState(0);
  const [warned, setWarned] = useState<string | null>(null);
  const inputs = { price: useRef<HTMLInputElement>(null), size: useRef<HTMLInputElement>(null), escrow: useRef<HTMLInputElement>(null) };
  const unit = priceUnitLabel(tokenLabel(sale.token), sale.lotExp);

  const submit = (ev: React.FormEvent) => {
    ev.preventDefault();
    const res = validateBid({ priceText: price, sizeText: size, escrowText: escrow, sale, nowNs });
    setCheck(res);
    setAttempt((n) => n + 1);
    const next = submitDecision(res, warned);
    if (next.action === 'reject') {
      const first = !res.ok ? res.errors.map(fieldOfError).find((f) => f !== null) : null;
      if (first) inputs[first].current?.focus();
      return;
    }
    if (next.action === 'confirm') {
      setWarned(next.key);
      return;
    }
    setWarned(null);
    if (res.ok) onSubmit({ p: res.p, q: res.q, B: res.B });
  };

  const errors = check && !check.ok ? check.errors : [];
  const fieldError = (f: 'price' | 'size' | 'escrow') => errors.find((e) => fieldOfError(e) === f);
  const fieldProps = (f: 'price' | 'size' | 'escrow') => ({
    id: `bid-${f}`,
    ref: inputs[f],
    'aria-invalid': fieldError(f) ? (true as const) : undefined,
    'aria-describedby': fieldError(f) ? `bid-${f}-error` : undefined,
  });
  const confirming = check?.ok === true && check.warnings.length > 0 && warned !== null;

  return (
    <form onSubmit={submit} className="stack" autoComplete="off">
      <label className="field">
        <span>Price ({unit})</span>
        <input {...fieldProps('price')} inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="3.60" disabled={disabled} />
      </label>
      <label className="field">
        <span>Size: most you will spend (USDC)</span>
        <input {...fieldProps('size')} inputMode="decimal" value={size} onChange={(e) => setSize(e.target.value)} placeholder="3" disabled={disabled} />
      </label>
      <label className="field">
        <span>Escrow: USDC locked with the bid (public; at least 1)</span>
        <input {...fieldProps('escrow')} inputMode="decimal" value={escrow} onChange={(e) => setEscrow(e.target.value)} placeholder="5" disabled={disabled} />
      </label>
      <p className="small muted">
        Whatever you do not spend at the clearing price is refunded. If no one reveals your bid before the deadline (the keeper normally does; you can too,
        gasless), 10% stays in the contract&apos;s NEAR Intents balance; no Tender method pays it to anyone, the seller included.
      </p>
      {errors.map((e) => {
        const f = fieldOfError(e);
        return (
          <p key={`${attempt}:${e}`} id={f ? `bid-${f}-error` : undefined} className="result bad" role="alert">
            {e}
          </p>
        );
      })}
      {check?.ok
        ? check.warnings.map((w) => (
            <p key={w} className="note" role="note">
              {w}
            </p>
          ))
        : null}
      <div>
        <button type="submit" className="primary" disabled={disabled}>
          {confirming ? 'Continue anyway' : 'Continue'}
        </button>
      </div>
    </form>
  );
}
