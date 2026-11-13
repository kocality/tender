import type { ReactNode } from 'react';
import { TIMELINE_NODES, timelineStage } from '../copy';
import type { Sale } from '../lib/views';

/**
 * The five steps every sale goes through: Sealed → Closed → Checked → Opened → Settled. A Cancelled sale stops at
 * Checked and branches off (the label is shown under that step on the full line; a card prints the pinned label itself). `facts` puts one line under each node (sale page); `mini` is the compact card version.
 */
export function Timeline({ sale, nowNs, facts, mini = false }: { sale: Sale; nowNs: bigint; facts?: ReactNode[]; mini?: boolean }) {
  const { at, branch } = timelineStage(sale, nowNs);
  return (
    <div className={mini ? 'timeline mini' : branch ? 'timeline branched' : 'timeline'}>
      <ol aria-label={`Where sale ${sale.id} is`}>
        {TIMELINE_NODES.map((name, i) => {
          const state = branch !== null && i > at ? 'skipped' : i < at || (i === at && sale.state === 'Finalized') ? 'done' : i === at ? 'now' : 'next';
          return (
            <li key={name} className={state} aria-current={i === at ? 'step' : undefined}>
              <span className="node" aria-hidden="true" />
              <span className="tl-name">
                {mini ? null : <span className="tl-n mono">{i + 1}</span>}
                {name}
                {state === 'done' ? <span className="sr-only"> (done)</span> : state === 'skipped' ? <span className="sr-only"> (not reached)</span> : null}
              </span>
              {facts?.[i] ? <span className="tl-fact">{facts[i]}</span> : null}
              {/* The branch sits under the step where the sale stopped, so it reads as that step's outcome. */}
              {branch && !mini && i === at ? <span className="tl-branch">{branch}</span> : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
