import { PUBLIC_FROM_START, ROLES, TOP_LIMITS } from '../copy';
import { Rich } from './Rich';

/** Who can see what, by role: the home band and `#/trust` show the same list. */
export function RoleList() {
  return (
    <dl className="roles">
      {ROLES.map((r) => (
        <div key={r.who} className="role">
          <dt>{r.who}</dt>
          <dd>
            <Rich text={r.text} />
            {r.small ? (
              <span className="role-small">
                <Rich text={r.small} />
              </span>
            ) : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function PublicList() {
  return (
    <ul className="public-list">
      {PUBLIC_FROM_START.map(([what, value]) => (
        <li key={what}>
          <span>{what}</span>
          <span>{value}</span>
        </li>
      ))}
    </ul>
  );
}

/** The three limits a visitor reads first. `short` keeps the title and the first sentence. */
export function TopLimits() {
  return (
    <ol className="limit-list">
      {TOP_LIMITS.map((l) => {
        const [first, ...rest] = l.text.split(/(?<=\.) /);
        return (
          <li key={l.title}>
            <strong>{l.title}</strong> <span className="limit-text">{first}</span>
            {rest.length > 0 ? <span className="limit-more"> {rest.join(' ')}</span> : null}
          </li>
        );
      })}
    </ol>
  );
}
