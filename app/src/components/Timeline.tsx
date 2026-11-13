import { TIMELINE_NODES, timelineStage } from '../copy';
import type { Sale } from '../lib/views';

/**
 * The five steps every sale goes through: Sealed → Closed → Checked → Opened → Settled. A Cancelled sale stops at
 * Checked and branches off (the label is shown on the full line; a card prints the pinned label itself). `facts` puts one line under each node (sale page); `mini` is the compact card version.
 */
export function Timeline({ sale, nowNs, facts, mini = false }: { sale: Sale; nowNs: bigint; facts?: (string | null)[]; mini?: boolean }) {
  const { at, branch } = timelineStage(sale, nowNs);
  return (
    <div className={mini ? 'timeline mini' : 'timeline'}>
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
            </li>
          );
        })}
      </ol>
      {branch && !mini ? <p className="tl-branch">{branch}</p> : null}
    </div>
  );
}
