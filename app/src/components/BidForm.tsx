import { useRef, useState } from 'react';
import { priceUnitLabel } from '../lib/amounts';
import { fieldOfError, submitDecision, validateBid, type BidValidation } from '../lib/bidFlow';
import { PENALTY_RULE } from '../copy';
import { tokenSymbol } from '../lib/format';
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
  onDraft,
}: {
  sale: Sale;
  nowNs: bigint;
  disabled: boolean;
  onSubmit: (v: BidFormValues) => void;
  /** The raw field text as it is typed, for the "Who sees what" panel. Nothing is validated or sent. */
  onDraft?: (d: { price: string; size: string; escrow: string }) => void;
}) {
  const [price, setPrice] = useState('');
  const [size, setSize] = useState('');
  const [escrow, setEscrow] = useState('');
  const [check, setCheck] = useState<BidValidation | null>(null);
  /** Counts submits, so a repeated identical error is a new alert node and is announced again. */
  const [attempt, setAttempt] = useState(0);
  const [warned, setWarned] = useState<string | null>(null);
  const inputs = { price: useRef<HTMLInputElement>(null), size: useRef<HTMLInputElement>(null), escrow: useRef<HTMLInputElement>(null) };
  const token = tokenSymbol(sale.token);
  const unit = priceUnitLabel(token, sale.lotExp);
  const edit = (f: 'price' | 'size' | 'escrow', v: string) => {
    const next = { price, size, escrow, [f]: v };
    if (f === 'price') setPrice(v);
    else if (f === 'size') setSize(v);
    else setEscrow(v);
    onDraft?.(next);
  };

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
      <div className="field">
        <label htmlFor="bid-price" className="field-label">
          <span>Your price</span>
          <span className="tag sealed-tag">Sealed</span>
        </label>
        <input {...fieldProps('price')} inputMode="decimal" value={price} onChange={(e) => edit('price', e.target.value)} placeholder="3.60" disabled={disabled} />
        <p className="help">
          In {unit}. The most you would pay. Every winner pays the same final price, which can be lower.
        </p>
      </div>
      <div className="field">
        <label htmlFor="bid-size" className="field-label">
          <span>Most you will spend (USDC)</span>
          <span className="tag sealed-tag">Sealed</span>
        </label>
        <input {...fieldProps('size')} inputMode="decimal" value={size} onChange={(e) => edit('size', e.target.value)} placeholder="3" disabled={disabled} />
        <p className="help">You get {token} worth up to this much, at the final price.</p>
      </div>
      <div className="field">
        <label htmlFor="bid-escrow" className="field-label">
          <span>Deposit, USDC (public; at least 1)</span>
          <span className="tag public-tag">Public</span>
        </label>
        <input {...fieldProps('escrow')} inputMode="decimal" value={escrow} onChange={(e) => edit('escrow', e.target.value)} placeholder="5" disabled={disabled} />
        <p className="help">
          Everyone sees this number. Set it above what you will spend, so your amount stays sealed; anything you do not spend comes back to you once your bid is
          revealed (the keeper normally does it). If your bid is never revealed, 10% of this deposit can stay in the contract; no Tender method pays it to anyone.
        </p>
      </div>
      <details className="fold callout">
        <summary>If your bid is never revealed</summary>
        <p className="small">
          Whatever you do not spend at the clearing price is refunded. If no one reveals your bid before the deadline (the keeper normally does; you can too,
          gasless), 10% stays in the contract&apos;s NEAR Intents balance; no Tender method pays it to anyone, the seller included.
        </p>
        <p className="small muted">{PENALTY_RULE}</p>
      </details>
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
      <div className="row">
        <button type="submit" className="primary" disabled={disabled}>
          {confirming ? 'Continue anyway' : 'Continue'}
        </button>
        <span className="small muted">Nothing is sent yet.</span>
      </div>
    </form>
  );
}
