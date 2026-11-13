import { config } from '../config';
import { RPC_UNAVAILABLE, isNotDeployed, isRpcUnavailable } from '../lib/errors';

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
 * A failed read, in plain words, with the raw cause folded behind "Technical details". A transport failure says "RPC
 * unavailable, retrying" (polled pages do retry); a missing contract says so and offers what still works; any other
 * contract-level problem names the contract. `stale` = older data is still on the page.
 */
export function ReadError({
  error,
  stale = false,
  retrying = true,
  compact = false,
}: {
  error: string | null;
  stale?: boolean;
  retrying?: boolean;
  /** Pages other than the home page: one line and the two ways forward, not the full explanation. */
  compact?: boolean;
}) {
  if (!error) return null;
  const notDeployed = isNotDeployed(error);
  const raw = (
    <details className="fold tech debug-only">
      <summary>Technical details</summary>
      {notDeployed ? <p className="small">NEAR&apos;s answer, as it came: there is no account with this name on this network.</p> : null}
      <p className="small mono">{error.length > 400 ? `${error.slice(0, 400)}…` : error}</p>
    </details>
  );
  if (notDeployed) {
    return (
      <div className="card pad empty-state" role="status">
        <p className="eyebrow">{`NEAR ${config.network}`}</p>
        <p className="empty-title">{`The sale contract is not live on NEAR ${config.network} yet.`}</p>
        {compact ? (
          <p className="muted">Until it is, the worked example shows a whole sale, and you can sign a practice bid for free.</p>
        ) : (
          <p className="muted">
            There is nothing to read at <span className="mono">{config.tenderContractId}</span> yet, so this part of the page stays empty until it is deployed.
            The worked example on the home page shows a whole sale, and you can sign a practice bid with your own wallet today: it is free and nothing is sent.
          </p>
        )}
        <p className="empty-actions">
          <a className="btn" href="#/?at=how">
            Follow the worked example
          </a>
          <a className="btn primary" href="#/try">
            Try signing (free)
          </a>
        </p>
        {raw}
      </div>
    );
  }
  const rpc = isRpcUnavailable(error);
  const head = rpc ? (retrying ? RPC_UNAVAILABLE : 'RPC unavailable. Reload the page to try again.') : `Could not read ${config.tenderContractId}.`;
  return (
    <div className="note info read-error" role="status">
      <strong>{head}</strong>
      {stale ? ' Showing the last data that was read.' : ''}
      {!rpc ? ' Reload the page to try again.' : ''}
      {raw}
    </div>
  );
}

export function NotFound({ what = 'page', back = '#/', backLabel = 'Back to the home page' }: { what?: string; back?: string; backLabel?: string }) {
  return (
    <div className="wrap page">
      <header className="page-head">
        <p className="eyebrow">Error 404</p>
        <h1>Not found</h1>
        <p className="lead">{`There is no ${what} at this address.`}</p>
      </header>
      <p>
        <a className="btn" href={back}>
          {backLabel}
        </a>
      </p>
    </div>
  );
}
