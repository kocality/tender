import { useEffect, useState } from 'react';
import { NEAR_INTENTS } from '../copy';
import { ORIGIN_CHAIN_NAME, ORIGIN_TOKEN_ADDRESS, isTerminal, quoteShortfall, type DepositOrigin, type QuoteResponse, type StatusResponse } from '../lib/oneclick';
import { humanStatus } from '../lib/errors';
import { formatUsdc } from '../lib/format';
import { CopyButton } from './CopyButton';
import { QrCode } from './QrCode';

/** "expired", "12:05" under an hour, "3h 20m" under a day, "3d 0h 29m" beyond (a 1Click deposit window is 72 hours). */
export function remainingText(deadline: string | undefined, nowMs: number): string | null {
  if (!deadline) return null;
  const left = Math.floor((Date.parse(deadline) - nowMs) / 1000);
  if (Number.isNaN(left)) return null;
  if (left <= 0) return 'expired';
  const d = Math.floor(left / 86400);
  const h = Math.floor((left % 86400) / 3600);
  const m = Math.floor((left % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}:${String(left % 60).padStart(2, '0')}`;
}

/** The address stops being useful once the quote expired without a deposit under way; PENDING_DEPOSIT means none arrived yet. */
export function quoteLapsed(left: string | null, status: StatusResponse | null): boolean {
  return left === 'expired' && (!status || status.status === 'PENDING_DEPOSIT');
}

/** The deposit instructions of one 1Click quote: exact chain, token, amount and address, plus live status. */
export function DepositBox({
  origin,
  quote,
  status,
  need,
  onSubmitTx,
  onNewQuote,
}: {
  origin: DepositOrigin;
  quote: QuoteResponse;
  status: StatusResponse | null;
  /** Micro-USDC the Intents account still needs; the quote's guaranteed minimum is checked against it. */
  need?: bigint;
  onSubmitTx: (txHash: string) => Promise<void> | void;
  onNewQuote: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  const [tx, setTx] = useState('');
  const [sentTx, setSentTx] = useState(false);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const q = quote.quote;
  const chain = ORIGIN_CHAIN_NAME[origin];
  const left = remainingText(q.deadline, now);
  const failed = status && isTerminal(status.status) && status.status !== 'SUCCESS';
  const lapsed = quoteLapsed(left, status);
  const address = lapsed ? '' : (q.depositAddress ?? '');
  const short = need === undefined ? 0n : quoteShortfall(q.minAmountOut, need);

  return (
    <div className="deposit">
      <p>
        <strong>Send USDC on {chain}</strong>
      </p>
      <dl className="kv">
        <dt>Chain</dt>
        <dd>{chain}</dd>
        <dt>Token</dt>
        <dd>
          USDC <span className="mono">{ORIGIN_TOKEN_ADDRESS[origin]}</span>
        </dd>
        <dt>Send exactly</dt>
        <dd>
          <strong>{q.amountInFormatted ?? formatUsdc(BigInt(q.amountIn))} USDC</strong> (less is not swapped, more is refunded)
        </dd>
        <dt>To address</dt>
        <dd>
          {lapsed ? (
            'this quote expired; get a new quote for a fresh address'
          ) : (
            <>
              <span className="mono">{address}</span> <CopyButton text={address} />
            </>
          )}
        </dd>
        {q.depositMemo ? (
          <>
            <dt>Memo</dt>
            <dd className="mono">{q.depositMemo}</dd>
          </>
        ) : null}
        <dt>You receive</dt>
        <dd>
          at least {formatUsdc(BigInt(q.minAmountOut))} USDC in your {NEAR_INTENTS} account (about {q.timeEstimate ?? '?'} s)
        </dd>
        {left ? (
          <>
            <dt>Quote valid</dt>
            <dd>{left}</dd>
          </>
        ) : null}
      </dl>
      {short > 0n ? (
        <p className="note" role="note">
          This quote guarantees only {formatUsdc(BigInt(q.minAmountOut))} USDC, {formatUsdc(short)} less than the {formatUsdc(need!)} USDC your Intents
          account still needs. Get a new quote, or expect to top up after the swap.
        </p>
      ) : null}
      {address ? <QrCode text={address} label={`QR code of the ${chain} deposit address`} /> : null}
      <div className="field">
        <label htmlFor="deposit-tx">Optional: paste your transaction hash to speed up detection</label>
        <span className="row">
          <input id="deposit-tx" value={tx} onChange={(e) => setTx(e.target.value)} placeholder="0x… or signature" />
          <button
            type="button"
            onClick={() => void Promise.resolve(onSubmitTx(tx.trim())).then(() => setSentTx(true), () => {})}
            disabled={tx.trim() === ''}
          >
            I sent it
          </button>
        </span>
      </div>
      <p className="small" role="status">
        1Click status: <strong>{status?.status ?? 'waiting for your deposit'}</strong>
        {status ? <span className="muted"> · {humanStatus(status.status)}</span> : null}
        {lapsed ? ' · quote expired' : ''}
        {sentTx ? ' · transaction hash sent to 1Click' : ''}
      </p>
      {failed ? (
        <p className="result bad" role="alert">
          {humanStatus(status.status)}
          {status.swapDetails?.refundReason ? ` (${status.swapDetails.refundReason})` : ''} Any deposit is refunded to your {chain} wallet.{' '}
          <button type="button" onClick={onNewQuote}>
            Get a new quote
          </button>
        </p>
      ) : null}
      {lapsed ? (
        <button type="button" onClick={onNewQuote}>
          Get a new quote
        </button>
      ) : null}
    </div>
  );
}
