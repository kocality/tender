import { EYE_GRID } from '../copy';

const Seen = () => (
  <svg className="eye-ic seen" viewBox="0 0 16 16" role="img" aria-label="sees it">
    <path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const Hidden = ({ hint }: { hint?: string }) => (
  <svg className="eye-ic hidden" viewBox="0 0 16 16" role="img" aria-label={hint ? `does not see it. ${hint}` : 'does not see it'}>
    {hint ? <title>{hint}</title> : null}
    <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>
);
const Lock = ({ hint }: { hint?: string }) => (
  <svg className="eye-ic lock" viewBox="0 0 16 16" role="img" aria-label={`does not see it. ${hint ?? ''}`.trim()}>
    {hint ? <title>{hint}</title> : null}
    <rect x="3" y="7" width="10" height="7" rx="2" fill="currentColor" />
    <path d="M5 7V5a3 3 0 0 1 6 0v2" fill="none" stroke="currentColor" strokeWidth="1.6" />
  </svg>
);

/**
 * Who sees what, as a grid: every role sees the deposit (lit), the price column says who sees the price. The two
 * exceptions are a hover title and the accessible name of their cell; the sentences behind them are one click away
 * (RoleList on the home tile's fold, and #/trust).
 */
export function EyeGrid() {
  return (
    <div className="eyegrid-wrap">
      <table className="eyegrid">
        <thead>
          <tr>
            <td />
            <th scope="col">Deposit</th>
            <th scope="col">Price</th>
          </tr>
        </thead>
        <tbody>
          {EYE_GRID.map((r) => (
            <tr key={r.who} className={`eye-${r.price}`}>
              <th scope="row">{r.who}</th>
              <td>
                <Seen />
              </td>
              <td>{r.price === 'yes' ? <Seen /> : r.price === 'lock' ? <Lock hint={r.hint} /> : <Hidden hint={r.hint} />}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {/* The one mark a stranger cannot read alone: a lock is a no, with an exception behind it (hover, or the fold). */}
      <p className="eye-legend small">
        <svg className="eye-ic lock" viewBox="0 0 16 16" aria-hidden="true">
          <rect x="3" y="7" width="10" height="7" rx="2" fill="currentColor" />
          <path d="M5 7V5a3 3 0 0 1 6 0v2" fill="none" stroke="currentColor" strokeWidth="1.6" />
        </svg>
        No, with one exception
      </p>
    </div>
  );
}
