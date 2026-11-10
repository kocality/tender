import { config } from '../config';
import { RPC_UNAVAILABLE, isRpcUnavailable } from '../lib/errors';

/** Shown while the initial read is under way; the page keeps its place so nothing jumps when data arrives. */
export function Loading({ what }: { what: string }) {
  return (
    <div className="card skeleton" role="status">
      <p className="muted" style={{ margin: 0 }}>
        {`Loading ${what}…`}
      </p>
      <span className="skeleton-line" />
      <span className="skeleton-line short" />
    </div>
  );
}

/**
 * A failed read. A transport failure says "RPC unavailable, retrying" (polled pages do retry); a contract-level problem
 * names the contract. `stale` = older data is still on the page.
 */
export function ReadError({ error, stale = false, retrying = true }: { error: string | null; stale?: boolean; retrying?: boolean }) {
  if (!error) return null;
  const rpc = isRpcUnavailable(error);
  const head = rpc ? (retrying ? RPC_UNAVAILABLE : 'RPC unavailable. Reload the page to try again.') : `Could not read ${config.tenderContractId}`;
  return (
    <div className="note" role="status">
      <strong>{head}</strong>
      {stale ? ' Showing the last data that was read.' : ''}
      <div className="small debug-only mono">{error.length > 240 ? `${error.slice(0, 240)}…` : error}</div>
    </div>
  );
}

export function NotFound({ what = 'page', back = '#/', backLabel = 'Back to the twin sales' }: { what?: string; back?: string; backLabel?: string }) {
  return (
    <div>
      <h1>Not found</h1>
      <p className="muted">{`There is no ${what} at this address.`}</p>
      <p>
        <a href={back}>{backLabel}</a>
      </p>
    </div>
  );
}
