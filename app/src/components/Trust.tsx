import { PUBLIC_FROM_START, ROLES } from '../copy';
import { Rich } from './Rich';

/** Who can see what, by role: the home band and `#/trust` show the same list. `phoneShort` (home band): on a phone each
 * role is one short sentence that keeps its exception; the full wording stays on `#/trust`. */
export function RoleList({ phoneShort = false }: { phoneShort?: boolean }) {
  return (
    <dl className={phoneShort ? 'roles roles-phone' : 'roles'}>
      {ROLES.map((r) => (
        <div key={r.who} className="role">
          <dt>{r.who}</dt>
          <dd>
            <span className={phoneShort && (r.short || r.small) ? 'role-full' : undefined}>
              <Rich text={r.text} />
              {r.small ? (
                <span className="role-small">
                  <Rich text={r.small} />
                </span>
              ) : null}
            </span>
            {phoneShort && (r.short || r.small) ? (
              <span className="role-short">
                <Rich text={r.short ?? r.text} />
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
