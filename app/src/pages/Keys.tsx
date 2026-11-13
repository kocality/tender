import { Loading, ReadError } from '../components/Feedback';
import { TxLink } from '../components/TxLink';
import { config } from '../config';
import { KEY_ERR_RULE, cancelledLabel } from '../copy';
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
      <p className="eyebrow">Proof · every key request</p>
      <h1>Key ledger</h1>
      <p className="lead">
        Every time the contract asked NEAR&apos;s key network for a sale&apos;s key, it wrote a line here first. A sale that missed its public conditions has no
        line: its key was never asked for.
      </p>
      <p className="small muted">
        Why it matters: bids can only be opened with a sale&apos;s key, so this list shows which sales&apos; keys the contract ever asked for, and when. Anyone
        can match each line with the receipt the NearBlocks explorer indexes for <code>request_app_private_key</code>, or run <code>pnpm verify --keys</code>.
      </p>
    </header>
  );
}

function KeysBody({ data }: { data: KeysData }) {
  const check = receiptCheck(data.rows, data.receipts);
  const receiptCount = data.receipts?.length ?? 0;
  return (
    <>
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
                  <td>{entry.outcome}</td>
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
      <p className="small">{`NearBlocks: ${receiptCount} ${receiptCount === 1 ? 'receipt' : 'receipts'} (${check})`}</p>
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
