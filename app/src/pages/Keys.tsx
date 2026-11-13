import { Loading, ReadError } from '../components/Feedback';
import { NetworkBadge } from '../components/NetworkBadge';
import { Rich } from '../components/Rich';
import { StatTile } from '../components/StatTile';
import { TxLink } from '../components/TxLink';
import StatusMark, { type StatusMarkStatus } from '../fx/StatusMark';
import { config } from '../config';
import { KEY_ERR_RULE, VERIFY_KEYS_LINE, cancelledLabel } from '../copy';
import { formatNsUtc } from '../lib/format';
import { receiptCheck } from '../lib/ledger';
import type { KeysData } from '../lib/loaders';
import { loadKeys } from '../lib/loaders';
import { usePolling } from '../lib/usePolling';
import type { Sale } from '../lib/views';

const STATE_PLAIN: Record<Exclude<Sale['state'], 'Cancelled'>, string> = {
  Open: 'taking bids, or closed and waiting to be opened',
  Opening: 'key being asked for',
  Keyed: 'key public',
  Finalized: 'finished and paid out',
};

/** One line per sale: how many key requests the contract recorded for it. A cancelled sale gets the pinned label. */
export function saleSummary(sale: Sale): string {
  const label = cancelledLabel(sale.state, sale.keyRequests);
  if (label !== null) return label;
  return `${sale.keyRequests} key ${sale.keyRequests === 1 ? 'request' : 'requests'} · ${STATE_PLAIN[sale.state as Exclude<Sale['state'], 'Cancelled'>]}`;
}

function KeysHead() {
  return (
    <header className="page-head">
      <NetworkBadge />
      <h1>Key ledger</h1>
      <p className="lead">Every key the contract ever asked for, written on chain before the request.</p>
      <details className="fold">
        <summary>Why it matters</summary>
        <p className="small">
          Every time the contract asked NEAR&apos;s key network for a sale&apos;s key, it wrote a line here first. A sale that missed its public conditions has no
          line: its key was never asked for.
        </p>
        <p className="small muted">
          Bids can only be opened with a sale&apos;s key, so this list shows which sales&apos; keys the contract ever asked for, and when. Anyone can match each
          line with the receipt the NearBlocks explorer indexes for <code>request_app_private_key</code>, or run <code>pnpm verify --keys</code>.
        </p>
      </details>
    </header>
  );
}

const MARK: Record<string, StatusMarkStatus> = { Ok: 'done', Err: 'failed' };

function KeysBody({ data }: { data: KeysData }) {
  const check = receiptCheck(data.rows, data.receipts);
  const receiptCount = data.receipts?.length ?? 0;
  const keyed = data.sales.filter((s) => s.key !== null).length;
  const errs = data.rows.filter((r) => r.entry.outcome === 'Err').length;
  return (
    <>
      <div className="stats keys-stats">
        <StatTile value={String(data.rows.length)} label={data.rows.length === 1 ? 'key request' : 'key requests'} />
        <StatTile value={String(keyed)} label={keyed === 1 ? 'sale with a key' : 'sales with a key'} />
        <StatTile value={String(errs)} label={errs === 1 ? 'failed request' : 'failed requests'} />
      </div>
      <p className="small">
        Key network (MPC): <code>{data.mpc}</code> version <strong>{data.mpcVersion ?? 'unavailable'}</strong>
      </p>
      {data.receipts === null ? (
        <p className="note info">
          NearBlocks unavailable (rate limit) · state ledger shown. NearBlocks is rate-limiting us right now; the ledger below is read from the contract&apos;s own
          state.
        </p>
      ) : null}
      <div className="card table-wrap" tabIndex={0} role="region" aria-label="Key ledger table, scrolls sideways on small screens">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>sale</th>
              <th>block</th>
              <th>time UTC</th>
              <th>outcome</th>
              <th>MPC receipt</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="muted">
                  No key request recorded yet: the contract has not asked NEAR&apos;s MPC network for any sale key.
                </td>
              </tr>
            ) : (
              data.rows.map(({ entry, receipt }) => (
                <tr key={entry.i.toString()}>
                  <td>{entry.i.toString()}</td>
                  <td>
                    <a className="cell-link" href={`#/sale/${entry.sale}`} aria-label={`Sale ${entry.sale}`}>
                      {entry.sale}
                    </a>
                  </td>
                  <td>
                    <a className="mono" href={`${config.explorerUrl}/blocks/${entry.block}`} target="_blank" rel="noreferrer">
                      {entry.block.toString()}
                    </a>
                  </td>
                  <td>{formatNsUtc(entry.ns)}</td>
                  <td>
                    <StatusMark status={MARK[entry.outcome] ?? 'running'} label={entry.outcome} size={15} fontSize={13} />
                  </td>
                  <td>
                    {receipt ? (
                      <TxLink hash={receipt.txHash} label={receipt.receiptId.slice(0, 10) + '…'} />
                    ) : (
                      <span className="muted">not indexed yet</span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <p className="small">
        {`NearBlocks: ${receiptCount} ${receiptCount === 1 ? 'receipt' : 'receipts'} (${check})`} · <Rich text={VERIFY_KEYS_LINE} />
      </p>
      {data.rows.some((r) => r.entry.outcome === 'Ok') ? <p className="small muted">Ok: NEAR&apos;s key network answered, and the contract checked and stored the key.</p> : null}
      {data.rows.some((r) => r.entry.outcome === 'Err') ? <p className="small">{KEY_ERR_RULE}</p> : null}
      <h2>Per sale</h2>
      <ul className="per-sale">
        {data.sales.map((s) => (
          <li key={s.id}>
            <a href={`#/sale/${s.id}`} className="per-sale-link">
              {`Sale #${s.id}`}
            </a>
            <span>{saleSummary(s)}</span>
          </li>
        ))}
      </ul>

    </>
  );
}

export function KeysView({ data }: { data: KeysData }) {
  return (
    <div className="wrap page">
      <KeysHead />
      <KeysBody data={data} />
    </div>
  );
}

export function Keys() {
  const { data, error, loading } = usePolling(loadKeys, 0, []); // one NearBlocks request per page load, never polled (V3)
  return (
    <div className="wrap page">
      <KeysHead />
      <ReadError error={error} stale={data !== null} retrying={false} compact />
      {loading && !data ? <Loading what="key ledger" /> : null}
      {data ? <KeysBody data={data} /> : null}
    </div>
  );
}
