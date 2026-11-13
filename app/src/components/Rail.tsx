import { Fragment } from 'react';
import { TIMELINE_NODES } from '../copy';

/**
 * The five steps of a sale as dots on a line: Sealed, Closed, Checked, Opened, Settled. `at` = the current node;
 * `complete` marks it done too (a settled sale); `failed` stops the line red at `at` (a cancelled sale). The steps are
 * named for a screen reader in `label`; nothing is painted as text (the home card prints its own active step).
 */
export function Rail({ at, complete = false, failed = false, label }: { at: number; complete?: boolean; failed?: boolean; label: string }) {
  return (
    <span className={failed ? 'rail5 failed' : 'rail5'} role="img" aria-label={label}>
      {TIMELINE_NODES.map((name, i) => {
        const state = i < at || (i === at && complete) ? 'done' : i === at ? (failed ? 'x' : 'now') : 'next';
        return (
          <Fragment key={name}>
            {i > 0 ? <span className={i <= at && !(failed && i > at) ? 'rs on' : 'rs'} /> : null}
            <span className={`rn ${state}`} />
          </Fragment>
        );
      })}
    </span>
  );
}
