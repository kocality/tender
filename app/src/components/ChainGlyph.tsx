/** A small chain mark (Base, Arbitrum, Solana, NEAR). Decoration next to a name or a self-declared origin: it never proves where funds came from. */
export function ChainGlyph({ chain, label }: { chain: string; label?: string }) {
  const shape =
    chain === 'base' ? (
      <circle cx="6" cy="6" r="4.2" fill="currentColor" />
    ) : chain === 'arb' ? (
      <path d="M6 1.6 10.6 10H1.4z" fill="currentColor" />
    ) : chain === 'sol' ? (
      <path d="M2.5 3h7.5L8.5 4.8H1zM3.5 5.1H11L9.5 6.9H2zM2.5 7.2h7.5L8.5 9H1z" fill="currentColor" />
    ) : chain === 'near' ? (
      <path d="M3.4 9.4V2.6l5.2 6.8V2.6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    ) : (
      <circle cx="6" cy="6" r="3" fill="none" stroke="currentColor" strokeWidth="1.4" />
    );
  return (
    <span className={`chain-glyph ${chain}`} role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
        {shape}
      </svg>
    </span>
  );
}
