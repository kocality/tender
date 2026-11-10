import { STEPS, type Step } from '../lib/bidFlow';

/**
 * The wizard's steps in order; the current one is marked for screen readers too, finished ones say "(done)" so the
 * state is not carried by colour alone. `failed` = the bid ended without being confirmed stored (`doneLabel` names why).
 */
export function StepList({ current, failed = false, doneLabel }: { current: Step; failed?: boolean; doneLabel?: string }) {
  const at = STEPS.findIndex((s) => s.id === current);
  return (
    <ol className="steps" aria-label="Bid steps">
      {STEPS.map((s, i) => (
        <li key={s.id} className={i < at ? 'done' : i === at ? (failed ? 'current failed' : 'current') : ''} aria-current={i === at ? 'step' : undefined}>
          {failed && i === at && s.id === 'done' ? (doneLabel ?? 'Not stored') : s.label}
          {i < at ? <span className="sr-only"> (done)</span> : null}
        </li>
      ))}
    </ol>
  );
}
