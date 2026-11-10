import { useMemo, useState } from 'react';
import { config } from '../config';
import type { DecryptResult } from '../lib/decrypt';
import { revealBatch } from '../lib/near-tx';
import { pollBid, relay } from '../lib/relay';
import { batches, revealWindowOpen, revealable, toRevealItems, unrevealable } from '../lib/revealFilter';
import { buildSelfReveal } from '../lib/selfReveal';
import { recoveryFor } from '../lib/bidFlow';
import { simulateIntents } from '@tender/intents';
import type { Bid, Sale } from '../lib/views';
import { ensureNear } from '../wallets/near';
import { walletErrorMessage, type IntentSigner } from '../wallets/types';
import { TxLink } from './TxLink';
import { WalletPicker } from './WalletPicker';

/** Reveal all (NEAR wallet pays gas) and Reveal my bid (gasless, Intents transfer through the relayer). */
export function RevealPanel({ sale, bids, decrypted, nowNs }: { sale: Sale; bids: Bid[]; decrypted: DecryptResult | null; nowNs: bigint }) {
  const [signer, setSigner] = useState<IntentSigner | null>(null);
  const [busy, setBusy] = useState<'all' | 'mine' | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [hashes, setHashes] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const open = revealWindowOpen(sale, nowNs);
  const items = useMemo(() => revealable(decrypted, bids), [decrypted, bids]);
  const blocked = useMemo(() => unrevealable(decrypted, bids), [decrypted, bids]);
  const mine = signer ? items.filter((i) => i.bidder === signer.signerId) : [];
  const enabled = open && decrypted?.keyOk === true;

  const revealAll = async () => {
    setBusy('all');
    setError(null);
    setLog([]);
    setHashes([]);
    try {
      await ensureNear();
      const groups = batches(toRevealItems(items));
      for (const [i, g] of groups.entries()) {
        setLog((l) => [...l, `Batch ${i + 1} of ${groups.length}: waiting for the wallet…`]);
        const hash = await revealBatch(sale.id, g);
        if (hash) setHashes((h) => [...h, hash]);
        setLog((l) => [...l.slice(0, -1), `Batch ${i + 1} of ${groups.length} sent (${g.length} bids).`]);
      }
    } catch (e) {
      setError(walletErrorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const revealMine = async () => {
    if (!signer) return;
    setBusy('mine');
    setError(null);
    setLog([]);
    setHashes([]);
    try {
      const payload = await buildSelfReveal({
        signerId: signer.signerId,
        contract: config.tenderContractId,
        quoteToken: sale.quoteToken,
        sale: sale.id,
        items: toRevealItems(mine),
      });
      const signed = await signer.sign(payload);
      const sim = await simulateIntents(config.rpcUrls, config.intentsContractId, [signed]);
      if (!sim.ok) {
        const r = recoveryFor(sim.kind, sim.message);
        setError(
          r.to === 'fund'
            ? 'This account holds no USDC in NEAR Intents. The gasless reveal needs 0.000001 USDC there; it is returned right away.'
            : r.message,
        );
        return;
      }
      const { txHash } = await relay([signed]);
      setHashes([txHash]);
      setLog(['Reveal relayed, waiting for the contract…']);
      const want = new Set(mine.map((m) => m.idx));
      const stored = await pollBid((bs) => (bs.filter((b) => want.has(b.idx) && b.state === 'Revealed').length === want.size ? bs[0] : undefined), sale.id);
      setLog([stored ? 'Revealed on chain.' : 'Not revealed yet: the contract may have refunded the transfer (see tx logs).']);
    } catch (e) {
      setError(walletErrorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  if (sale.state !== 'Keyed') return null;
  return (
    <section className="card" style={{ marginTop: 16 }} aria-label="Reveal">
      <h2 style={{ marginTop: 0 }}>Reveal</h2>
      <p className="small muted">
        Revealing publishes a bid&apos;s price, size and salt so the contract can check them against the commitment. Unrevealed bids get 90% of their
        escrow back; the other 10% goes to the revealed bidders pro rata, never to the seller.
      </p>
      {!open ? <p className="note">The reveal window is closed. Only finalize is left.</p> : null}
      {!decrypted ? <p className="small muted">Decrypt the bids first.</p> : null}
      {decrypted && !decrypted.keyOk ? (
        <p className="result bad" role="alert">
          Key check failed. Reveal is disabled.
        </p>
      ) : null}
      <div className="row">
        <button type="button" className="primary" onClick={revealAll} disabled={!enabled || items.length === 0 || busy !== null}>
          {busy === 'all' ? 'Revealing…' : `Reveal all (NEAR wallet, gas)${items.length ? ` · ${items.length}` : ''}`}
        </button>
      </div>
      <h3 style={{ marginTop: 16 }}>Reveal my bid (gasless)</h3>
      <WalletPicker signer={signer} onConnect={setSigner} />
      <div style={{ marginTop: 8 }}>
        <button type="button" onClick={revealMine} disabled={!enabled || !signer || mine.length === 0 || busy !== null}>
          {busy === 'mine' ? 'Waiting for wallet…' : `Reveal my bid${mine.length === 1 ? '' : 's'} (gasless)${mine.length ? ` · ${mine.length}` : ''}`}
        </button>
        {signer && decrypted?.keyOk && mine.length === 0 ? <p className="small muted">No sealed bid of {signer.signerId} can be revealed.</p> : null}
      </div>
      {blocked.length > 0 ? (
        <p className="note" role="note">
          Bids {blocked.map((i) => `#${i}`).join(', ')} cannot be revealed. Unrevealed bids will be penalized 10% (paid to
          revealed bidders, never to the seller).
        </p>
      ) : null}
      {log.map((l) => (
        <p key={l} className="small" role="status">
          {l}
        </p>
      ))}
      {hashes.map((h) => (
        <p key={h} className="small">
          transaction <TxLink hash={h} />
        </p>
      ))}
      {error ? (
        <p className="result bad" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
