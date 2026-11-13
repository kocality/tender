import { useMemo, useState } from 'react';
import { config } from '../config';
import { NEAR_INTENTS, PENALTY_RULE } from '../copy';
import { itemsFromBidFiles } from '../lib/bidFile';
import type { DecryptResult } from '../lib/decrypt';
import { formatCountdown, formatNsUtc } from '../lib/format';
import { addIntentsKey, revealBatch } from '../lib/near-tx';
import { pollBid, relay } from '../lib/relay';
import { batches, revealWindowOpen, revealable, sendRevealBatches, toRevealItems, unrevealable } from '../lib/revealFilter';
import { buildSelfReveal } from '../lib/selfReveal';
import { canRegisterKey, recoveryFor } from '../lib/bidFlow';
import { simulateIntents, type MultiPayload, type RevealItem } from '@tender/intents';
import { getAllBids, type Bid, type Sale } from '../lib/views';
import { ensureNear } from '../wallets/near';
import { walletErrorMessage, type IntentSigner } from '../wallets/types';
import { FinalizeButton } from './FinalizeButton';
import { TxLink } from './TxLink';
import { WalletPicker } from './WalletPicker';

/** Reveal all (NEAR wallet pays gas) and Reveal my bid (gasless, Intents transfer through the relayer). */
export function RevealPanel({ sale, bids, decrypted, nowNs }: { sale: Sale; bids: Bid[]; decrypted: DecryptResult | null; nowNs: bigint }) {
  const [signer, setSigner] = useState<IntentSigner | null>(null);
  const [busy, setBusy] = useState<'all' | 'mine' | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [hashes, setHashes] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  /** A signed self-reveal (and the bids it reveals) that waits for its NEAR key to be registered with Intents. */
  const [needsKey, setNeedsKey] = useState<{ signed: MultiPayload; group: RevealItem[] } | null>(null);
  /** Saved `pnpm seal:bid` files: picked from disk or pasted. */
  const [fileTexts, setFileTexts] = useState<string[]>([]);
  const [pasted, setPasted] = useState('');

  const open = revealWindowOpen(sale, nowNs);
  const items = useMemo(() => revealable(decrypted, bids), [decrypted, bids]);
  const blocked = useMemo(() => unrevealable(decrypted, bids), [decrypted, bids]);
  const mine = signer ? items.filter((i) => i.bidder === signer.signerId) : [];
  // A bid file needs no decryption: its commitment is rechecked against the bid the contract holds.
  const fromFiles = useMemo(
    () => itemsFromBidFiles([...fileTexts, pasted].filter((t) => t.trim() !== ''), bids, { saleId: sale.id, contract: config.tenderContractId, network: config.network }),
    [fileTexts, pasted, bids, sale.id],
  );
  const fileMine = signer ? fromFiles.items.filter((i) => i.bidder === signer.signerId) : [];
  const enabled = open && decrypted?.keyOk === true;
  const allRevealed = sale.bids > 0 && sale.revealed >= sale.bids;

  const pickFiles = async (files: FileList | null) => setFileTexts(await Promise.all([...(files ?? [])].map((f) => f.text())));

  const revealAll = async (list: RevealItem[]) => {
    setBusy('all');
    setError(null);
    setLog([]);
    setHashes([]);
    try {
      await ensureNear();
      await sendRevealBatches({
        saleId: sale.id,
        groups: batches(toRevealItems(list)),
        load: getAllBids,
        send: revealBatch,
        onWaiting: (i, n) => setLog((l) => [...l, `Batch ${i + 1} of ${n}: waiting for the wallet…`]),
        onSent: (i, n, count, hash) => {
          if (hash) setHashes((h) => [...h, hash]);
          setLog((l) => [...l.slice(0, -1), `Batch ${i + 1} of ${n} sent (${count} bids).`]);
        },
        onSkipped: (i, n) => setLog((l) => [...l, `Batch ${i + 1} of ${n}: already revealed by someone else, skipped.`]),
      });
    } catch (e) {
      setError(walletErrorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  /** Simulate, relay and follow one signed self-reveal. A key that is not registered stops here with a Register button. */
  const submitSigned = async (signed: MultiPayload, group: RevealItem[]): Promise<boolean> => {
    const sim = await simulateIntents(config.rpcUrls, config.intentsContractId, [signed]);
    if (!sim.ok) {
      const r = recoveryFor(sim.kind, sim.message, signed.standard);
      if (r.to === 'register_key' && canRegisterKey(signed, signer?.signerId)) setNeedsKey({ signed, group });
      setError(
        r.to === 'fund'
          ? `This account holds no USDC in ${NEAR_INTENTS}. The gasless reveal needs 0.000001 USDC there; it is returned right away.`
          : r.message,
      );
      return false;
    }
    setNeedsKey(null);
    const { txHash } = await relay([signed]);
    setHashes((h) => [...h, txHash]);
    setLog((l) => [...l, 'Reveal relayed, waiting for the contract…']);
    const want = new Set(group.map((m) => m.idx));
    const stored = await pollBid((bs) => (bs.filter((b) => want.has(b.idx) && b.state === 'Revealed').length === want.size ? bs[0] : undefined), sale.id);
    setLog((l) => [
      ...l.slice(0, -1),
      stored === 'unknown'
        ? 'Could not confirm: the RPC did not answer. The reveal may still have gone through; check again in a minute.'
        : stored
          ? 'Revealed on chain.'
          : 'Not revealed yet: the contract may have refunded the transfer (see tx logs).',
    ]);
    return stored !== null && stored !== 'unknown';
  };

  /** One signed transfer per 8 bids: the contract refunds a self-reveal with more items (MAX_SELF_REVEAL_ITEMS), and the relayer takes one intent per signature. */
  const revealMine = async (list: (RevealItem & { bidder: string })[]) => {
    if (!signer) return;
    setBusy('mine');
    setError(null);
    setNeedsKey(null);
    setLog([]);
    setHashes([]);
    try {
      for (const group of batches(toRevealItems(list))) {
        const payload = await buildSelfReveal({
          signerId: signer.signerId,
          contract: config.tenderContractId,
          quoteToken: sale.quoteToken,
          sale: sale.id,
          items: group,
        });
        if (!(await submitSigned(await signer.sign(payload), group))) break;
      }
    } catch (e) {
      setError(walletErrorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const registerKey = async () => {
    if (!needsKey || needsKey.signed.standard !== 'nep413') return;
    setBusy('mine');
    setError(null);
    try {
      await addIntentsKey(needsKey.signed.public_key);
      await submitSigned(needsKey.signed, needsKey.group);
    } catch (e) {
      setError(walletErrorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  if (sale.state !== 'Keyed') return null;
  return (
    <section className="card pad" aria-label="Reveal">
      <h2>Reveal</h2>
      <p className="small muted">
        Revealing publishes a bid&apos;s price, size and salt so the contract can check them against the commitment. {PENALTY_RULE}
      </p>
      {sale.revealDeadlineNs !== null ? (
        <p className="small">
          Reveal deadline {formatNsUtc(sale.revealDeadlineNs)}
          {open ? ` · ${formatCountdown(sale.revealDeadlineNs - nowNs)} left` : ' · passed'}
        </p>
      ) : null}
      {!open ? (
        <p className="note">
          The reveal window is closed. Anyone can finalize: it settles the sale and pays out up to 8 bids per call.
        </p>
      ) : null}
      {allRevealed || !open ? <FinalizeButton saleId={sale.id} /> : null}
      {!decrypted ? <p className="small muted">Decrypt the bids first.</p> : null}
      {decrypted && !decrypted.keyOk ? (
        <p className="result bad" role="alert">
          Key check failed. Reveal is disabled.
        </p>
      ) : null}
      <div className="row">
        <button type="button" className="primary" onClick={() => revealAll(items)} disabled={!enabled || items.length === 0 || busy !== null}>
          {busy === 'all' ? 'Revealing…' : `Reveal all (NEAR wallet, gas)${items.length ? ` · ${items.length}` : ''}`}
        </button>
      </div>
      <details className="fold more-ways">
        <summary>More ways to reveal</summary>
        <h3>Reveal my bid (gasless)</h3>
        <WalletPicker signer={signer} onConnect={setSigner} showOrigin={false} />
        <div style={{ marginTop: 8 }}>
          <button type="button" onClick={() => revealMine(mine)} disabled={!enabled || !signer || mine.length === 0 || busy !== null}>
            {busy === 'mine' ? 'Waiting for wallet…' : `Reveal my bid${mine.length === 1 ? '' : 's'} (gasless)${mine.length ? ` · ${mine.length}` : ''}`}
          </button>
          {signer && decrypted?.keyOk && mine.length === 0 ? <p className="small muted">No sealed bid of {signer.signerId} can be revealed.</p> : null}
        </div>
        <h3>Reveal from my bid file</h3>
        <p className="small muted">
          For a bid that cannot be decrypted here. Pick the files <code>pnpm seal:bid</code> saved in <code>~/.tender/bids</code>, or paste one. They are read in this
          browser and never uploaded, and each is checked against the bid on chain before anything is sent.
        </p>
        <label className="field">
          <span>Bid files</span>
          <input type="file" multiple accept="application/json,.json" onChange={(e) => pickFiles(e.target.files)} disabled={busy !== null} />
        </label>
        <label className="field">
          <span>Or paste one bid file</span>
          <textarea rows={3} value={pasted} onChange={(e) => setPasted(e.target.value)} spellCheck={false} disabled={busy !== null} />
        </label>
        {fromFiles.notes.map((n) => (
          <p key={n} className="small" role="note">
            {n}
          </p>
        ))}
        <div className="row">
          <button type="button" className="primary" onClick={() => revealAll(fromFiles.items)} disabled={!open || fromFiles.items.length === 0 || busy !== null}>
            {busy === 'all' ? 'Revealing…' : `Reveal file bids (NEAR wallet, gas)${fromFiles.items.length ? ` · ${fromFiles.items.length}` : ''}`}
          </button>
          <button type="button" onClick={() => revealMine(fileMine)} disabled={!open || !signer || fileMine.length === 0 || busy !== null}>
            {busy === 'mine' ? 'Waiting for wallet…' : `Reveal file bids (gasless)${fileMine.length ? ` · ${fileMine.length}` : ''}`}
          </button>
        </div>
      </details>
      {blocked.length > 0 ? (
        <p className="note" role="note">
          Bids {blocked.map((i) => `#${i}`).join(', ')} cannot be revealed. If they are still unrevealed when the window ends, each loses 10% of its escrow. That 10%
          stays in the contract&apos;s {NEAR_INTENTS} balance; no Tender method pays it to anyone, the seller included. If you sealed one of them yourself, reveal it from its bid file above.
        </p>
      ) : null}
      <div role="status">
        {log.map((l, i) => (
          <p key={i} className="small">
            {l}
          </p>
        ))}
      </div>
      {hashes.map((h) => (
        <p key={h} className="small">
          transaction <TxLink hash={h} />
        </p>
      ))}
      {needsKey ? (
        <div style={{ marginTop: 8 }}>
          <button type="button" className="primary" onClick={() => void registerKey()} disabled={busy !== null}>
            Register this key with {NEAR_INTENTS} · 1 yoctoNEAR
          </button>
        </div>
      ) : null}
      {error ? (
        <p className="result bad" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
