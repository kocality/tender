import { useEffect, useState } from 'react';
import { config } from '../config';
import { isNotDeployed } from './errors';
import { getConfig } from './views';

let probe: Promise<boolean> | null = null;

/**
 * Whether the sale contract is missing on this network, for the footer's status line: one `get_config` read per page
 * load, mainnet only (the testnet line is the same either way). `false` until it answers, and after a failed read that
 * is not "no contract here".
 */
export function useContractMissing(): boolean {
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    if (config.network !== 'mainnet') return;
    let alive = true;
    probe ??= getConfig().then(
      () => false,
      (e: unknown) => {
        const gone = isNotDeployed(e instanceof Error ? e.message : String(e));
        if (!gone) probe = null; // a transport failure: ask again on the next mount
        return gone;
      },
    );
    void probe.then((m) => alive && setMissing(m));
    return () => {
      alive = false;
    };
  }, []);
  return missing;
}
