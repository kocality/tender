import type { KeyboardEvent, FocusEvent } from 'react';
import { config } from '../config';
import { PRIVACY_PLAIN, TRUST_LINE, networkStatus } from '../copy';
import { useContractMissing } from '../lib/contractStatus';
import { Rich } from './Rich';

/** A `<details>` popover closes on Escape (focus back on its summary) and when focus leaves it. */
export const popoverHandlers = {
  onKeyDown(e: KeyboardEvent<HTMLDetailsElement>) {
    if (e.key !== 'Escape' || !e.currentTarget.open) return;
    e.currentTarget.open = false;
    e.currentTarget.querySelector('summary')?.focus();
  },
  onBlur(e: FocusEvent<HTMLDetailsElement>) {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) e.currentTarget.open = false;
  },
};

/**
 * The network in one pill: MAINNET ("Live on NEAR mainnet", once the contract answers there) or TESTNET (today's build).
 * What it rests on (no audit, team seller, the testnet copy of NEAR Intents, the MPC threshold) sits in a popover that is
 * in the page from the start, so a reader or a search finds it on every page. The footer's badge (`up`, opens upward)
 * carries the full text (the testnet copy's id and version) and the exact TRUST_LINE; a badge at the top of a page says
 * the same in plain words, with no ids. `missing` = the page itself
 * already read that the contract is not there.
 */
export function NetworkBadge({ up = false, missing = false }: { up?: boolean; missing?: boolean }) {
  const probed = useContractMissing();
  const s = networkStatus(config.network, missing ? true : probed);
  return (
    <details className={up ? 'netbadge up' : 'netbadge'} data-net={s.tone} {...popoverHandlers}>
      <summary>
        <span className="dot" aria-hidden="true" />
        {s.badge}
        <svg className="chev" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M3 4.5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </summary>
      <div className="pop">
        <p>{up ? s.footer : s.plain}</p>
        <p>
          <Rich text={up ? TRUST_LINE : PRIVACY_PLAIN} />
        </p>
        <p>
          <a href="#/trust">
            Who can see your bid<span aria-hidden="true">{' →'}</span>
          </a>
        </p>
      </div>
    </details>
  );
}
