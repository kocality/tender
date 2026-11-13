import { STEPS, type Step } from '../lib/bidFlow';

/** Relaying is part of "Sign once" on screen: the rail shows six steps. */
const RAIL = STEPS.filter((s) => s.id !== 'relay');
const SUB: Partial<Record<Step, string>> = { fund: 'skipped if you have enough', seal: 'in this browser' };

/**
 * The wizard's steps in order; the current one is marked for screen readers too, finished ones say "(done)" so the
 * state is not carried by colour alone. `failed` = the bid ended without being confirmed stored (`doneLabel` names why).
 */
export function StepList({ current, failed = false, doneLabel }: { current: Step; failed?: boolean; doneLabel?: string }) {
  const at = RAIL.findIndex((s) => s.id === (current === 'relay' ? 'sign' : current));
  const label = (s: (typeof RAIL)[number], i: number) => (failed && i === at && s.id === 'done' ? (doneLabel ?? 'Not stored') : s.label);
  return (
    <div className="rail">
      {/* Phones show this line instead of the list below, so screen readers there read it too; only the bar is decoration. */}
      <p className="rail-mobile small">
        <span className="mono">{`Step ${at + 1} of ${RAIL.length}`}</span> · {label(RAIL[at]!, at)}
        <span className="rail-bar" aria-hidden="true">
          {RAIL.map((s, i) => (
            <i key={s.id} className={i < at ? 'd' : i === at ? (failed ? 'f' : 'c') : undefined} />
          ))}
        </span>
      </p>
      <ol className="steps" aria-label="Bid steps">
        {RAIL.map((s, i) => (
          <li key={s.id} className={i < at ? 'done' : i === at ? (failed ? 'current failed' : 'current') : ''} aria-current={i === at ? 'step' : undefined}>
            <span className="n mono" aria-hidden="true">
              {i < at ? '✓' : i + 1}
            </span>
            <span>
              {label(s, i)}
              {i < at ? <span className="sr-only"> (done)</span> : null}
              {SUB[s.id] && i >= at ? <span className="sub">{SUB[s.id]}</span> : null}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
