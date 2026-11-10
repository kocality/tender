import { useEffect, useState } from 'react';
import { ORIGIN_CHAIN_NAME, ORIGIN_TOKEN_ADDRESS, isTerminal, type DepositOrigin, type QuoteResponse, type StatusResponse } from '../lib/oneclick';
import { humanStatus } from '../lib/errors';
import { formatUsdc } from '../lib/format';
import { CopyButton } from './CopyButton';
import { QrCode } from './QrCode';

function remainingText(deadline: string | undefined, nowMs: number): string | null {
  if (!deadline) return null;
  const left = Math.floor((Date.parse(deadline) - nowMs) / 1000);
  if (Number.isNaN(left)) return null;
  if (left <= 0) return 'expired';
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
}

/** The deposit instructions of one 1Click quote: exact chain, token, amount and address, plus live status. */
export function DepositBox({
  origin,
  quote,
  status,
  onSubmitTx,
  onNewQuote,
}: {
  origin: DepositOrigin;
  quote: QuoteResponse;
  status: StatusResponse | null;
  onSubmitTx: (txHash: string) => void;
  onNewQuote: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  const [tx, setTx] = useState('');
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const q = quote.quote;
  const chain = ORIGIN_CHAIN_NAME[origin];
  const left = remainingText(q.deadline, now);
  const failed = status && isTerminal(status.status) && status.status !== 'SUCCESS';
  const address = q.depositAddress ?? '';

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
          <span className="mono">{address}</span> <CopyButton text={address} />
        </dd>
        {q.depositMemo ? (
          <>
            <dt>Memo</dt>
            <dd className="mono">{q.depositMemo}</dd>
          </>
        ) : null}
        <dt>You receive</dt>
        <dd>
          at least {formatUsdc(BigInt(q.minAmountOut))} USDC in your NEAR Intents account (about {q.timeEstimate ?? '?'} s)
        </dd>
        {left ? (
          <>
            <dt>Quote valid</dt>
            <dd>{left}</dd>
          </>
        ) : null}
      </dl>
      {address ? <QrCode text={address} label={`QR code of the ${chain} deposit address`} /> : null}
      <label className="field">
        <span>Optional: paste your transaction hash to speed up detection</span>
        <span className="row">
          <input value={tx} onChange={(e) => setTx(e.target.value)} placeholder="0x… or signature" aria-label="Deposit transaction hash" />
          <button type="button" onClick={() => onSubmitTx(tx.trim())} disabled={tx.trim() === ''}>
            I sent it
          </button>
        </span>
      </label>
      <p className="small" role="status">
        1Click status: <strong>{status?.status ?? 'waiting for your deposit'}</strong>
        {status ? <span className="muted"> · {humanStatus(status.status)}</span> : null}
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
      {left === 'expired' && !status ? (
        <button type="button" onClick={onNewQuote}>
          Get a new quote
        </button>
      ) : null}
    </div>
  );
}
