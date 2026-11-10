import { TxLink } from '../components/TxLink';
import { config } from '../config';
import { cancelledLabel } from '../copy';
import { formatNsUtc } from '../lib/format';
import { receiptCheck } from '../lib/ledger';
import type { KeysData } from '../lib/loaders';
import { loadKeys } from '../lib/loaders';
import { usePolling } from '../lib/usePolling';
import type { Sale } from '../lib/views';

/** One line per sale: how many key requests the contract recorded for it. */
export function saleSummary(sale: Sale): string {
  const label = cancelledLabel(sale.state, sale.keyRequests);
  if (label !== null) {
    return sale.keyRequests === 0
      ? `sale ${sale.id}: 0 requests · Cancelled · never requested (sealed unless the MPC threshold colludes)`
      : `sale ${sale.id}: ${sale.keyRequests} requests · Cancelled · may be decryptable`;
  }
  return `sale ${sale.id}: ${sale.keyRequests} ${sale.keyRequests === 1 ? 'request' : 'requests'} · ${sale.state}`;
}

export function KeysView({ data }: { data: KeysData }) {
  const check = receiptCheck(data.rows, data.receipts);
  const receiptCount = data.receipts?.length ?? 0;
  return (
    <div>
      <h1>Key ledger</h1>
      <p className="muted">
        The contract writes every MPC key request to its own on-chain ledger before it makes the call. Each row below can be matched with the
        receipt NearBlocks indexes for <code>request_app_private_key</code>.
      </p>
      <p>
        MPC network: <code>{data.mpc}</code> version <strong>{data.mpcVersion ?? 'unavailable'}</strong>
      </p>
      {data.receipts === null ? <p className="note">NearBlocks unavailable (rate limit) · state ledger shown</p> : null}
      <div className="card table-wrap">
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
                  No key request recorded.
                </td>
              </tr>
            ) : (
              data.rows.map(({ entry, receipt }) => (
                <tr key={entry.i.toString()}>
                  <td>{entry.i.toString()}</td>
                  <td>
                    <a href={`#/sale/${entry.sale}`}>{entry.sale}</a>
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
      <h2>Per sale</h2>
      <ul>
        {data.sales.map((s) => (
          <li key={s.id}>{saleSummary(s)}</li>
        ))}
      </ul>
      <p className="small">
        {`NearBlocks: ${receiptCount} ${receiptCount === 1 ? 'receipt' : 'receipts'} (${check})`}
      </p>
    </div>
  );
}

export function Keys() {
  const { data, error, loading } = usePolling(loadKeys, 0, []) // one NearBlocks request per page load, never polled (V3);
  return (
    <>
      {error ? <p className="note">Could not read {config.tenderContractId}: {error}</p> : null}
      {loading && !data ? <p className="muted">Loading key ledger…</p> : null}
      {data ? <KeysView data={data} /> : null}
    </>
  );
}
