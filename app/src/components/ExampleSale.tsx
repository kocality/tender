import { useEffect, useRef, useState } from 'react';
import { HERO_EXAMPLE, HOME, TIMELINE_NODES } from '../copy';
import DecryptedText from '../fx/DecryptedText';
import StatusMark, { type StatusMarkStatus } from '../fx/StatusMark';
import { ChainGlyph } from './ChainGlyph';
import { Rail } from './Rail';
import { motionOk } from './Reveal';

export type Ending = 'opened' | 'cancelled';
type Phase = 'sealed' | 'closed' | 'checking' | 'key' | 'open' | 'settled' | 'cancelled';

/** Each phase and how long it holds before the next (ms). The last phase holds: nothing loops. */
const SEQUENCE: Record<Ending, [Phase, number][]> = {
  opened: [
    ['sealed', 1000],
    ['closed', 700],
    ['checking', 800],
    ['key', 700],
    ['open', 1500],
    ['settled', 0],
  ],
  cancelled: [
    ['sealed', 1000],
    ['closed', 700],
    ['checking', 800],
    ['cancelled', 0],
  ],
};
const END: Record<Ending, Phase> = { opened: 'settled', cancelled: 'cancelled' };
const RAIL_AT: Record<Phase, number> = { sealed: 0, closed: 1, checking: 2, key: 3, open: 3, settled: 4, cancelled: 2 };
const MARK: Record<Phase, [StatusMarkStatus, string]> = {
  sealed: ['pending', 'sealed'],
  closed: ['pending', 'sealed'],
  checking: ['running', 'checking'],
  key: ['done', 'key released'],
  open: ['done', 'key released'],
  settled: ['done', 'key released'],
  cancelled: ['failed', 'key never requested'],
};

const canPlay = (play: boolean) => play && motionOk();

/** What a screen reader hears once a play the visitor started has ended (each phase in between stays silent). */
const OUTCOME: Record<Ending, string> = {
  opened: `Opened: key released, every winner pays one price, ${HERO_EXAMPLE.clearing} USDC.`,
  cancelled: 'Cancelled: key never requested, every deposit refunded.',
};

/** Every deposit in the example, added up: each bar is one bid's share of it. */
const TOTAL = HERO_EXAMPLE.bids.reduce((t, b) => t + Number(b.deposit), 0);

/** The button that switches endings asks the question the other ending answers. */
const OTHER: Record<Ending, string> = { opened: 'Too few bids?', cancelled: 'Enough bids?' };

const KeyGlyph = () => (
  <svg className="key-glyph" viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
    <circle cx="5" cy="8" r="3.2" fill="none" stroke="currentColor" strokeWidth="1.8" />
    <path d="M8.2 8H14M12 8v2.6M14 8v2" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
  </svg>
);

const SealLock = () => (
  <svg className="seal-lock" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
    <rect x="3" y="7" width="10" height="7" rx="2" fill="currentColor" />
    <path d="M5 7V5a3 3 0 0 1 6 0v2" fill="none" stroke="currentColor" strokeWidth="1.6" />
  </svg>
);

/** Won (check) or below the price (dash), once the price is set; named for screen readers, no visible words. */
const Outcome = ({ win }: { win: boolean }) => (
  <svg className={win ? 'exmark won' : 'exmark lost'} viewBox="0 0 16 16" width="16" height="16" role="img" aria-label={win ? 'won' : 'below the price, refunded'}>
    {win ? (
      <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    ) : (
      <path d="M4.5 8h7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    )}
  </svg>
);

/**
 * The home page's example sale, labelled EXAMPLE: three sealed bids (deposits public, prices sealed), the close, the
 * check of the public conditions, then one of two endings. `opened`: the key is released, the prices decrypt and one
 * price is set (3.60, cleared by `@tender/clearing` in a test). `cancelled`: only one bid arrived, the check fails, the
 * key is never requested and the deposit is refunded. It plays once when it scrolls into view and holds its last state;
 * without IntersectionObserver, under reduced motion, or with `play={false}` it shows the last state at once.
 */
export function ExampleSale({ ending: first = 'opened', play = true }: { ending?: Ending; play?: boolean }) {
  const ref = useRef<HTMLElement>(null);
  const [ending, setEnding] = useState<Ending>(first);
  const [run, setRun] = useState(0);
  const [phase, setPhase] = useState<Phase>(() => (canPlay(play) ? 'sealed' : END[first]));

  useEffect(() => {
    if (!canPlay(play)) {
      setPhase(END[ending]);
      return undefined;
    }
    const timers: ReturnType<typeof setTimeout>[] = [];
    const start = () => {
      let at = 0;
      for (const [p, hold] of SEQUENCE[ending]) {
        timers.push(setTimeout(() => setPhase(p), at));
        at += hold;
      }
    };
    setPhase('sealed');
    // The first play waits until the card is on screen; Replay and Other ending start at once.
    let observer: IntersectionObserver | null = null;
    if (run === 0 && ref.current) {
      observer = new IntersectionObserver(
        (entries) => {
          if (!entries.some((e) => e.isIntersecting)) return;
          observer?.disconnect();
          start();
        },
        { threshold: 0.4 },
      );
      observer.observe(ref.current);
    } else start();
    return () => {
      observer?.disconnect();
      timers.forEach(clearTimeout);
    };
  }, [ending, run, play]);

  const [status, label] = MARK[phase];
  const at = RAIL_AT[phase];
  const opened = phase === 'open' || phase === 'settled';
  const settled = phase === 'settled';
  const cancelled = phase === 'cancelled';
  const keyOut = phase === 'key' || opened;
  const railLabel = cancelled ? 'Cancelled · refunded' : TIMELINE_NODES[at];
  const sealed = !(opened && ending === 'opened');
  return (
    <figure ref={ref} className={`excard ending-${ending} phase-${phase}`} aria-label="Example sale" aria-describedby="excard-desc">
      <p id="excard-desc" hidden>
        {HOME.steps.join(' ')}
      </p>
      <div className="excard-head">
        <span className="tag ex-pill">Example</span>
        <span className="keystate" aria-live="off">
          {keyOut ? <KeyGlyph /> : null}
          <StatusMark status={status} label={label} size={16} fontSize={13} />
        </span>
      </div>
      <div className="excard-cols" aria-hidden="true">
        <span />
        <span />
        <span>Deposit</span>
        <span>Price</span>
      </div>
      <div className="excard-rows">
        {HERO_EXAMPLE.bids.map((b, i) => {
          const absent = ending === 'cancelled' && i !== 1;
          const win = settled && (HERO_EXAMPLE.winners as readonly number[]).includes(i);
          const out = settled && !win;
          const pct = (Number(b.deposit) / TOTAL) * 100;
          // In this ending these bids never arrived: the row says so, so it does not read as a loading placeholder.
          if (absent)
            return (
              <div key={b.who} className="exrow empty" aria-hidden="true">
                <span className="no-bid">no bid</span>
              </div>
            );
          return (
            <div key={b.who} className={`exrow${win ? ' win' : ''}${out ? ' out' : ''}`}>
              {win || out ? <Outcome win={win} /> : <span className={`av av${i}`} aria-hidden="true" />}
              <span className="exchain">
                <ChainGlyph chain={b.chain} label={`${b.who}, ${b.chain === 'base' ? 'Base' : b.chain === 'sol' ? 'Solana' : 'NEAR'}`} />
                {/* This deposit's share of all deposits: public from the start (the opening check counts the total, not one bid). */}
                <span className="depbar" aria-hidden="true">
                  <span style={{ width: `${cancelled ? 0 : pct}%` }} />
                </span>
              </span>
              <span className="dep mono">{b.deposit}</span>
              <span className="price mono">
                {sealed ? <SealLock /> : null}
                <DecryptedText text={b.price} revealed={!sealed} delay={phase === 'open' ? i * 420 : 0} sealedLabel="price sealed" />
              </span>
            </div>
          );
        })}
      </div>
      <div className="excard-foot">
        <span className="exrail">
          <Rail at={at} complete={settled} failed={cancelled} label={cancelled ? 'Sealed, closed, checked, then cancelled' : `Step ${at + 1} of 5: ${railLabel}`} />
          {/* Once settled, the full green rail and the price say it: the step name steps aside (first screen ≤ 50 words). */}
          {settled ? null : <span className={cancelled ? 'rail-name bad' : 'rail-name'}>{railLabel}</span>}
        </span>
        <span className={settled ? 'pstar on' : 'pstar'}>
          {/* An example's price is plain text: a number that moves on this page is always one read from the chain. */}
          {settled ? (
            <>
              <span className="mono">{HERO_EXAMPLE.clearing}</span> <span className="pstar-l">USDC · one price</span>
            </>
          ) : null}
        </span>
        <span className="excard-actions">
          {/* Under reduced motion there is nothing to replay: the card shows its last state. */}
          {canPlay(play) ? (
            <button type="button" className="icon-btn" aria-label="Replay" onClick={() => setRun((r) => r + 1)}>
              <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
                <path d="M3.5 8a4.5 4.5 0 1 0 1.4-3.3M3.5 2.5v2.6h2.6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          ) : null}
          <button
            type="button"
            className="btn ghost btn-sm"
            onClick={() => {
              setEnding((e) => (e === 'opened' ? 'cancelled' : 'opened'));
              setRun((r) => r + 1);
            }}
          >
            {OTHER[ending]}
          </button>
        </span>
      </div>
      <span className="sr-only" aria-live="polite">
        {run > 0 && (settled || cancelled) ? OUTCOME[ending] : ''}
      </span>
    </figure>
  );
}
