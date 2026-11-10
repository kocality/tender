import { STEPS, type Step } from '../lib/bidFlow';

/** The wizard's steps in order; the current one is marked for screen readers too. */
export function StepList({ current }: { current: Step }) {
  const at = STEPS.findIndex((s) => s.id === current);
  return (
    <ol className="steps" aria-label="Bid steps">
      {STEPS.map((s, i) => (
        <li key={s.id} className={i < at ? 'done' : i === at ? 'current' : ''} aria-current={i === at ? 'step' : undefined}>
          {s.label}
        </li>
      ))}
    </ol>
  );
}
