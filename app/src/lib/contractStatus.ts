import { useEffect, useState } from 'react';
import { config } from '../config';
import { isNotDeployed } from './errors';
import { getConfig } from './views';

let probe: Promise<boolean | null> | null = null;

/**
 * Whether the sale contract is missing on this network, for the network badge: one `get_config` read per page load,
 * mainnet only (the testnet badge is the same either way, so testnet answers `false` at once). On mainnet `null` until
 * the read answers, and after a read that failed in transport, so the badge claims nothing it has not read.
 */
export function useContractMissing(): boolean | null {
  const [missing, setMissing] = useState<boolean | null>(config.network === 'mainnet' ? null : false);
  useEffect(() => {
    if (config.network !== 'mainnet') return;
    let alive = true;
    probe ??= getConfig().then(
      () => false,
      (e: unknown) => {
        if (isNotDeployed(e instanceof Error ? e.message : String(e))) return true;
        probe = null; // a transport failure: not known, ask again on the next mount
        return null;
      },
    );
    void probe.then((m) => alive && setMissing(m));
    return () => {
      alive = false;
    };
  }, []);
  return missing;
}
