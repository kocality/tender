// Persistent UI text. The honest-claims rule applies to every string in this app.

import { config } from './config';
import { formatUsdc } from './lib/format';
import type { Sale } from './lib/views';

/** How the app names NEAR Intents. Testnet has no intents.near: a testnet build talks to the project's own copy (JUDGES row T11), and says so wherever it names it. */
export const NEAR_INTENTS = config.network === 'testnet' ? 'NEAR Intents (our testnet copy)' : 'NEAR Intents';

/** Testnet only (null on mainnet): 1Click is mainnet only, so on testnet funds cannot leave the project's testnet copy. Replaces the "Withdraw moves it to another chain" sentence. */
export const WITHDRAW_TESTNET: string | null =
  config.network === 'testnet' ? `Withdrawals to other chains work on mainnet through 1Click; on testnet your funds stay in ${NEAR_INTENTS}.` : null;

export const TRUST_LINE =
  "Privacy rests on NEAR's MPC threshold (11 of 16 nodes on 2026-11-10; `pnpm verify` prints the live value). We add no TEE and no committee of our own; the MPC nodes additionally run in attested TEEs. Resharing does not revoke old shares, so the condition is fewer than 11 of the parties that hold or ever held a share of the domain-2 key.";

export const OPEN_RULE =
  "At close anyone can call open(). The locked contract asks NEAR's MPC network for the sale's key only if the sale's public open conditions hold: total escrow ≥ min_escrow and distinct bidders ≥ min_bidders. These conditions read public escrow, not sealed prices.";

export const HOSTED_BUNDLE =
  'If this hosted page were malicious it could leak your price before sealing, or swap the sealed bid you paste. Run the app locally, or seal with `pnpm seal:bid`, paste the result below and check that the cm in your wallet prompt equals the cm it printed. Paste only output you produced yourself.';

/** The penalty as the contract applies it: the 10% stays in the contract's NEAR Intents balance and no Tender method pays it out. Every screen that mentions the penalty says this. */
export const PENALTY_RULE =
  `When at least one bid in the sale is revealed, an unrevealed bid gets 90% of its escrow back (100% if no bid is revealed). The other 10% stays in the contract's ${NEAR_INTENTS} balance. No Tender method pays it to anyone: not to the seller, not to other bidders, not to us. Like any Intents balance, intents.near's own admin roles could move it.`;

/** Why a relayed bid can be missing from the sale: the contract refunds it with one of these reasons (the refund event is in the transaction logs). */
export const NOT_STORED_CAUSES =
  `Usual causes: the bid arrived after close, the sale is full (maximum bids or escrow cap), the bid came from the sale's own seller account (refund reason seller_bid), or the message is over 2048 bytes (refund reason msg_too_long; this page never sends one that long). A refund lands in your ${NEAR_INTENTS} balance; Withdraw moves it out.`;

/** Intents balances credited to the contract outside a bid or reveal message cannot be moved again (the contract has no admin method). */
export const UNRECOVERABLE_TRANSFER =
  'Only place bids through this page or `pnpm seal:bid`. A plain Intents transfer to the contract without a bid message credits the contract and cannot be recovered: it has no admin method.';

export const VERIFY_KEYS_LINE = 'Check it: `pnpm verify --keys`';

/** TRUST_LINE in plain words: what a visitor reads first; the exact wording sits one click behind it. */
export const PRIVACY_PLAIN =
  "Before a sale opens, reading a bid would take 11 of the computers that hold, or ever held, a piece of NEAR's key working together (11 of 16 on 2026-11-10; `pnpm verify` prints today's count), or a bad copy of the page the bid was sealed with.";

/**
 * What the network badge says (components/NetworkBadge.tsx): `badge` is its pill, `footer` its popover. It follows the
 * build's network. On mainnet, `contractMissing` is `null` until the contract has been read: the pill claims nothing then.
 */
export function networkStatus(
  network: 'mainnet' | 'testnet',
  contractMissing: boolean | null = false,
): { label: string; text: string; footer: string; plain: string; badge: string; tone: 'live' | 'testnet' | 'missing' | 'pending' } {
  const common = 'No audit. Only our team can create sales, and we are the seller in every one of them. The chain shown on a bid is declared by the bidder, not proven.';
  const team = 'No audit, and our team is the seller in every sale.';
  if (network === 'testnet') {
    const intents = `NEAR Intents here is our own testnet copy, ${config.intentsContractId}, running the same intents 0.4.5 contract code.`;
    return {
      label: 'Testnet demo',
      text: 'test tokens only, no real money',
      footer: `Test tokens only, no real money. ${intents} ${common}`,
      plain: `Test tokens only, no real money. ${team}`,
      badge: 'Testnet · test tokens only',
      tone: 'testnet',
    };
  }
  if (contractMissing === null) return { label: 'Mainnet', text: 'checking the sale contract', footer: common, plain: team, badge: 'NEAR mainnet', tone: 'pending' };
  if (contractMissing) {
    return {
      label: 'Mainnet',
      text: 'the sale contract is not live yet',
      footer: `The sale contract is not live yet; once it is, bids move real USDC. ${common}`,
      plain: `The sale contract is not live yet. ${team}`,
      badge: 'Mainnet · not live',
      tone: 'missing',
    };
  }
  return { label: 'Mainnet', text: 'real USDC · no audit · team-funded demo sales', footer: `Bids move real USDC. ${common}`, plain: `Bids move real USDC. ${team}`, badge: 'Live on NEAR mainnet', tone: 'live' };
}

const ORIGIN_NAMES = { base: 'Base', arb: 'Arbitrum', sol: 'Solana', near: 'NEAR' } as const;

/** Chain badge text. The origin is declared by the bidder, never proof of where the funds came from (C7). */
export function originBadge(origin: string | null | undefined): string {
  const name = Object.hasOwn(ORIGIN_NAMES, origin ?? '') ? ORIGIN_NAMES[origin as keyof typeof ORIGIN_NAMES] : undefined;
  return name ? `via ${name} (self-declared)` : 'origin not declared';
}

/** The only place the "never requested" label may be produced: Cancelled with zero key requests. */
export function cancelledLabel(state: string, keyRequests: string | number | bigint): string | null {
  if (state !== 'Cancelled') return null;
  const n = BigInt(keyRequests);
  if (n === 0n) return 'Cancelled · 0 key requests · never requested (sealed unless the MPC threshold colludes)';
  return `Cancelled after ${n} key requests · may be decryptable`;
}

export const TRY_RESULT = {
  insufficientBalance: 'signature valid · insufficient balance (simulation only, nothing was sent)',
  notRegistered:
    `signature valid · this NEAR key is not registered in ${NEAR_INTENTS} yet (named accounts register once; implicit and EVM/Solana accounts don't need to)`,
  otherAccount: 'the signature was made by a different account than the one shown (switch the wallet back to it, or reconnect)',
  funded: 'signature valid · this account holds funds; simulation only, nothing was sent',
} as const;

/** What an `Err` row of the key ledger can mean (the contract checks the MPC answer against its pinned key before it stores it). */
export const KEY_ERR_RULE =
  "Err: the MPC network answered with an error, or with a key the contract refused because it failed the pairing check against the pinned MPC key and the sale's app_id. Nothing was stored, the sale stays Open and open() may be asked again; if no key ever arrives, the sale is cancelled at close + 24 h and every bid is refunded in full.";

// ---- Landing, trust page and twin copy. `**x**` marks the words a component sets in bold (see components/Rich.tsx). ----

export const HOME = {
  title: 'Bid on tokens without showing your price.',
  sentence: 'Public deposits, sealed prices, one price for every winner.',
  ctaSales: 'See both sales',
  ctaBid: 'Bid on a sale',
  /** The free practice signature (#/try): nothing is sent. */
  ctaTry: 'Try it free',
  /** The example card's screen-reader description (never shown): who asks for the key, and when. */
  steps: [
    "Your browser seals your price with the sale's lock before you send it.",
    "Only the sale's key opens it. The locked sale contract is the only account that can get that key from NEAR's key network, and it asks only after close, if the sale's public conditions hold.",
    'Then anyone can open the bids, and every winner pays the same price.',
  ],
  /** Under the example card: the two exceptions to "sealed" in plain words; `heroWhy` links to the exact wording on #/trust. */
  heroCaveat: "Two ways a price could leak: 11 of NEAR's key holders, past or present, working together, or a tampered copy of this page.",
  heroWhy: 'Why these two',
  howTitle: 'Sealed, checked, opened. One price.',
  howLead: 'Your deposit is public from the start; your price is not, until the sale opens.',
  /** The five tiles of section 01: a title and at most one short line each; the visual carries the rest. */
  bento: {
    seal: { title: 'Sealed in your browser', line: 'Encrypted before it leaves your device.' },
    chains: {
      title: 'USDC from four chains',
      line: 'Bid from Base, Arbitrum, Solana or NEAR.',
      /** 1Click is mainnet only: a testnet build bids with test USDC already in our Intents copy. */
      testnet: 'Base, Arbitrum, Solana or NEAR on mainnet; test USDC here.',
    },
    gate: { title: 'Opened only if public conditions hold', line: 'Short on deposits or bidders: cancelled, refunded, key never requested.' },
    price: { title: 'One price for every winner', line: 'Every winner pays the same price.' },
    roles: { title: 'Who sees your price' },
  },
  /** Below the twin cards: where the numbers come from (the network is added by the page). */
  liveCaption: 'Live from NEAR',
  missingLead: 'Then two run here side by side: one set up to open, one set up to miss its conditions.',
  noOpenSale: 'No sale is taking bids right now. You can still sign a practice bid with your own wallet: it is free and nothing is sent.',
  liveNote: 'We are the seller in these sales and funded them; we also run the keeper (the bot that reveals bids), the relayer (which pays the network fee for bids) and this page.',
  tryTitle: 'Try it in a minute.',
  /** #/try, under the wallet cards: the check that needs no wallet. */
  tryNoWallet: "No wallet? Open a finished sale's bids yourself",
} as const;

/**
 * The worked example on the home page's card (an example, labelled as one: never live data). Prices in USDC per NEAR,
 * `size` = the most the bidder spends, in USDC. `__tests__/example-sale.test.tsx` clears it with `@tender/clearing` and
 * checks `clearing`, so the card cannot show a wrong price.
 */
export const HERO_EXAMPLE = {
  supply: '1.5',
  reserve: '3.00',
  minEscrow: '5.00',
  minBidders: 3,
  bids: [
    { who: 'Bea', chain: 'base', deposit: '5.00', price: '3.90', size: '4' },
    { who: 'Sam', chain: 'sol', deposit: '3.00', price: '3.20', size: '3' },
    { who: 'A NEAR bidder', chain: 'near', deposit: '3.00', price: '3.60', size: '2' },
  ],
  clearing: '3.60',
  /** Bea and the NEAR bidder win; Sam bid below the clearing price. */
  winners: [0, 2],
} as const;

/** "Who sees your price", as a grid: the deposit column is public for everyone; the price column per role. Short form of ROLES. */
export const EYE_GRID: { who: string; price: 'yes' | 'no' | 'lock'; hint?: string }[] = [
  { who: 'You', price: 'yes' },
  { who: 'Other bidders', price: 'no' },
  { who: 'The seller', price: 'lock', hint: 'Today the seller is us: the same exception as Tender (us)' },
  { who: 'Tender (us)', price: 'lock', hint: 'Unless this page is a bad copy that reads your price before sealing it' },
  { who: "NEAR's key network", price: 'lock', hint: 'Unless 11 of its key holders, past or present, work together' },
  { who: 'Everyone, if it opens', price: 'yes' },
];

/** What section 02 of the home page promises, from what the twin sales did: "its key was never asked for" appears only when such a sale exists. */
export function twinHeading(
  sales: Pick<Sale, 'id' | 'state' | 'keyRequests' | 'closeNs'>[],
  demoFailSales: string[],
  nowNs: bigint,
  network: string,
): { before: string; accent: string; after: string; lead: string } {
  const opened = sales.some((s) => s.state === 'Keyed' || s.state === 'Finalized');
  const neverAsked = sales.some((s) => s.state === 'Cancelled' && s.keyRequests === 0);
  // "Read live from the chain" is the caption under the cards (HOME.liveCaption).
  if (opened && neverAsked) {
    // "We set" only when the sale that missed is one the team configured to miss (config.demoFailSales).
    const ours = sales.some((s) => s.state === 'Cancelled' && s.keyRequests === 0 && demoFailSales.includes(s.id));
    return {
      before: 'Both',
      accent: 'endings',
      after: ', side by side.',
      lead: ours
        ? 'One met its conditions and opened; we set the other to miss them, so its key was never asked for.'
        : 'One met its public conditions and opened; the other missed them, so its key was never asked for.',
    };
  }
  // A sale we set up to miss its conditions that is still taking bids: the sentence is about what is planned, and says so.
  const planned = sales.some((s) => demoFailSales.includes(s.id) && s.state === 'Open' && nowNs < s.closeNs);
  if (planned && sales.length > 1) {
    return {
      before: 'Both',
      accent: 'endings',
      after: ', side by side.',
      lead: 'One is set up to open; the other to miss its conditions, so its key is never asked for.',
    };
  }
  return { before: 'Real sales, read', accent: 'live.', after: '', lead: `${sales.length === 1 ? 'A sale' : 'Sales'} on NEAR ${network}, read live from the chain.` };
}

/** Who can see what, by role. Shared by the home band and `#/trust`; `short` is the home band on a phone, with the same exceptions. */
export const ROLES: { who: string; text: string; small?: string; short?: string }[] = [
  { who: 'You', text: '**Your price and amount, always.**' },
  { who: 'Other bidders', text: 'Your deposit, your account and the time. **Not your price.**' },
  {
    who: 'The seller',
    text: 'The same as other bidders. The seller cannot open bids early either. Today the seller is us, so our exception below applies too.',
    short: 'The same as other bidders. **Not your price.** Today the seller is us: our exception below applies too.',
  },
  {
    who: 'Tender (us)',
    text: "The same. **We cannot get the key**: if we ask, NEAR's network gives us a different key that opens nothing. Only the locked sale contract gets the right one, and nobody can change that contract, us included: it has no owner key and no upgrade method.",
    small:
      'One exception: this page is our code. A bad version could read your price before sealing it. Developers who would rather not trust it can seal on their own machine with `pnpm seal:bid`.',
    short: 'The same. **We cannot get the key.** One exception: this page is our code, and a bad version could read your price before sealing it (`pnpm seal:bid` seals without it).',
  },
  {
    who: "NEAR's key network",
    text: "Holds, in pieces, the master key every sale's key comes from. Reading bids early would take 11 of the parties that hold, or ever held, a piece, working together.",
    small: "Technically an MPC (multi-party computation) network: 11 of 16 nodes on 2026-11-10; `pnpm verify` prints today's count. If they did work together, nothing on chain would show it.",
    short: "**Not your price**, unless 11 of its key holders, past or present, work together. Nothing on chain would show it.",
  },
  { who: 'Everyone, if it opens', text: 'Every bid, once the sale opens. That is how anyone can check the price.' },
];

/** What is public before the key is released (README "Trust and limits"). */
export const PUBLIC_FROM_START: [string, string][] = [
  ["Each bid's deposit", 'amount'],
  ['Who bid, and when', 'account, time'],
  ['Total deposits, number of bidders', 'two numbers'],
  ['The deposit transactions on the paying chain', 'public'],
  ['Chain the bid came from', 'stated by the bidder'],
];

/** The three limits a visitor should read first; `#/trust` lists all eleven. */
export const TOP_LIMITS: { title: string; text: string }[] = [
  {
    title: 'The opening rule counts money and people, not prices.',
    text: 'Someone with enough USDC can push a weak sale over its conditions with low bids, get refunded, and make every bid open. Extra accounts are cheap.',
  },
  {
    title: 'A bidder can keep a last look.',
    text: `Someone can seal a bid our keeper cannot open, watch the other bids open, then reveal it from their own copy or not. It costs 10% of their deposit, which stays in the contract's balance on ${NEAR_INTENTS}, the NEAR contract that holds every deposit; no Tender method pays it out. On a big sale with few bids it can still pay: the penalty prices it, it does not prevent it.`,
  },
  {
    title: 'A seller can bid on their own sale.',
    text: 'Under another account we cannot stop it. Its price becomes public when the bids open, but nothing ties it to the seller; the minimum price is the protection.',
  },
];

/** The other eight limits of README "Trust and limits", plain first; `technical` keeps the README wording where the plain text leaves it out. */
export const MORE_LIMITS: { title: string; text: string; technical?: string }[] = [
  {
    title: 'A bidder can prove their bid to someone else.',
    text: 'The salt (the random part sealed with each bid) lets a bidder prove a bid to someone who pays for it (no receipt-freeness, unlike MACI).',
  },
  {
    title: 'Bids in a sale that never opened are not deleted.',
    text: "When a sale misses its conditions, its key is never asked for, but its sealed bids are not erased: they stay public, still locked. 11 of NEAR's key holders, past or present, working together could still open them, and so could anyone who one day breaks NEAR's master key.",
    technical:
      "\"Never requested\" means the contract never asked for the key. The ciphertexts stay on chain, so the MPC threshold still covers them, cancelled sales included, and a future compromise of NEAR's domain-2 master key would decrypt every stored bid. A sale cancelled after a request is an exception.",
  },
  {
    title: "NEAR can change its key network's master key.",
    text: 'If NEAR changes its domain-2 key, the contract refuses a key that fails its check against the pinned one; the sale is then cancelled and refunded. Details: `docs/protocol.md`, "Key request".',
  },
  {
    title: 'A refunded bid can still be read later.',
    text: "A refunded bid is not stored, but its ciphertext stays in public transaction history and decrypts if that sale's key is released. Our CLI and app narrow this; other signers are not covered.",
  },
  {
    title: 'Bidding twice from two devices costs a fee.',
    text: "A deliberate second bid is allowed, and this page asks you to confirm it first. A second 1Click deposit from another browser or device while a sent bid's outcome is unclear (up to 10 minutes) gets one of the two bids refunded (bid_seq); the deposit stays in your Intents account and you lose 1Click's fee. Software that does not number its bids is not covered.",
  },
  {
    title: 'A sale holds at most 64 bids.',
    text: 'At most 64 bids per sale, 1 USDC minimum each, so refunded below-reserve bids can crowd a sale out.',
  },
  {
    title: 'Some tokens have a highest possible price.',
    text: 'A token with 9 or fewer decimals has a price ceiling; wNEAR (24 decimals) and JAMBO (18) have none in practice.',
  },
  {
    title: 'No audit, and only our team creates sales.',
    text: 'No audit. Sale creation is restricted to the team.',
  },
];

/** README "Trust and limits", the table "You rely on": plain sentence, what breaks, and the README row verbatim. */
export const RELY_ON: { plain: string; breaks: string; technical: string }[] = [
  {
    plain: "NEAR's key network. If fewer than 11 of the parties that hold or ever held a piece cooperate, nobody reads a bid early.",
    breaks: 'Bids are read early, and nothing on chain shows it. Deposits stay in the contract.',
    technical: 'The MPC threshold: bids unreadable before release.',
  },
  {
    plain: 'Only the sale contract can get the right key. It was created without keys and cannot be upgraded.',
    breaks: 'Someone else could request the key and read the bids early.',
    technical:
      'app_id is derived from the calling account. The contract is created keyless, with no upgrade method. Every sale path carries a random seed generated after the contract existed. This is the only-requester rule.',
  },
  {
    plain: 'The contract only asks for a key when the public conditions hold, and the published build is the one running.',
    breaks: 'A sale could be decrypted without meeting its conditions.',
    technical: 'Contract open() and the reproducible build: the open-conditions rule.',
  },
  {
    plain: "NEAR's key network answers, with the key the contract pinned when it was created.",
    breaks: 'No key is stored; the sale can be cancelled and every bid refunded.',
    technical: "NEAR MPC liveness, and its domain-2 key staying the one pinned when the contract was created: a key that decrypts the bids arrives.",
  },
  {
    plain: 'Someone reveals the bids in time, within the reveal window after the key is out. Our keeper, a bot we run, normally does; you can too, without paying a network fee.',
    breaks: 'An unrevealed bid can pay the 10% penalty.',
    technical: 'Someone revealing within the window: bids get revealed.',
  },
  {
    plain: `${NEAR_INTENTS}, the NEAR contract that holds your balance, checks every signature.`,
    breaks: 'Bids or transfers could be forged.',
    technical: 'intents.near signature checks: bidder identity and amounts.',
  },
  {
    plain: `The admins of ${NEAR_INTENTS} leave balances where the contract put them.`,
    breaks: 'They could move any Intents balance, the penalty pool included.',
    technical: 'intents.near admin roles: the penalty pool and escrow stay where the contract put them.',
  },
  {
    plain: '1Click, the bridge service that moves USDC between chains, does its job.',
    breaks: "A stuck swap follows 1Click's own refund flow, outside the contract.",
    technical: '1Click and its bridges: cross-chain in and out; fees are recorded in `docs/protocol.md`.',
  },
  {
    plain: 'This page seals your bid honestly.',
    breaks: 'A bad version could leak your price before sealing. Seal locally with `pnpm seal:bid`.',
    technical: 'Our hosted JavaScript bundle: encryption in your browser.',
  },
  {
    plain: 'Nobody, for sending your bid. Our relayer (the server that pays the network fee to send a signed bid) is a convenience: anyone can send one.',
    breaks: 'If our relayer refuses you, anyone else can send your signed bid.',
    technical: 'execute_intents is permissionless.',
  },
];

export const SELLER_STEPS = [
  'The team writes `sales/<n>.json`: token, amount, close time, minimum price, minimum deposits, minimum bidders.',
  'The team creates the sale from the command line.',
  'Everyone watches deposits and the bidder count fill in, never prices.',
  'After close, anyone presses Open or Cancel.',
  'After the reveal window, anyone presses Finalize: USDC to the seller, unsold tokens back.',
];

/** The public conditions a closed sale missed, in words: "1 USDC deposited, 5 needed". Met conditions are not listed. */
function missedConditions(sale: Pick<Sale, 'escrowTotal' | 'minEscrow' | 'bidders' | 'minBidders'>): string[] {
  const out: string[] = [];
  if (sale.escrowTotal < sale.minEscrow) out.push(`${formatUsdc(sale.escrowTotal)} USDC deposited, ${formatUsdc(sale.minEscrow)} needed`);
  if (sale.bidders < sale.minBidders) out.push(`${sale.bidders} ${sale.bidders === 1 ? 'bidder' : 'bidders'}, ${sale.minBidders} needed`);
  return out;
}

/** The verdict sentence on a twin card, generated from the chain numbers. */
export function twinVerdict(
  sale: Pick<Sale, 'state' | 'closeNs' | 'escrowTotal' | 'minEscrow' | 'bidders' | 'minBidders' | 'keyRequests' | 'payoutsDone' | 'payoutsTotal'>,
  nowNs: bigint,
): string {
  const esc = formatUsdc(sale.escrowTotal);
  const minEsc = formatUsdc(sale.minEscrow);
  const times = (k: number) => `${k} ${k === 1 ? 'time' : 'times'}`;
  const missed = missedConditions(sale);
  const refunds = sale.payoutsDone < sale.payoutsTotal ? 'every bid is being refunded in full' : 'every bid was refunded in full';
  switch (sale.state) {
    case 'Open':
      if (nowNs < sale.closeNs) {
        return `Taking sealed bids. ${esc} USDC from ${sale.bidders} ${sale.bidders === 1 ? 'bidder' : 'bidders'} so far; it needs ${minEsc} USDC and ${sale.minBidders} bidders to open.`;
      }
      if (missed.length === 0) {
        return `Closed and met both conditions: ${esc} USDC (needed ${minEsc}) from ${sale.bidders} bidders (needed ${sale.minBidders}). Anyone can press Open.`;
      }
      return `Closed below its conditions: ${missed.join('; ')}. Anyone can cancel it; every bid is then refunded in full.`;
    case 'Opening':
      return `Closed and met both conditions: ${esc} USDC (needed ${minEsc}) from ${sale.bidders} bidders (needed ${sale.minBidders}). The key has been asked for.`;
    case 'Keyed':
      return `Met both conditions. Key requested ${times(sale.keyRequests)}; the bids can be opened by anyone.`;
    case 'Finalized':
      return `Met both conditions. Key requested ${times(sale.keyRequests)}; the key was released and one price was set.`;
    case 'Cancelled':
      if (sale.keyRequests > 0) {
        return `Cancelled after ${sale.keyRequests} key ${sale.keyRequests === 1 ? 'request' : 'requests'}: no key arrived in time. ${refunds[0]!.toUpperCase()}${refunds.slice(1)}.`;
      }
      return missed.length > 0
        ? `Missed its conditions: ${missed.join('; ')}. Its key was never asked for; ${refunds}.`
        : `Cancelled: nobody opened it within 24 hours of close. Its key was never asked for; ${refunds}.`;
  }
}

export const TIMELINE_NODES = ['Sealed', 'Closed', 'Checked', 'Opened', 'Settled'] as const;

/**
 * Where a sale is on the five-node line. `at` = index of the current node; a Cancelled sale stops at Checked and
 * branches off, labelled by whether its key was ever requested.
 */
export function timelineStage(sale: Pick<Sale, 'state' | 'closeNs' | 'keyRequests'>, nowNs: bigint): { at: number; branch: string | null } {
  switch (sale.state) {
    case 'Open':
      return { at: nowNs < sale.closeNs ? 0 : 1, branch: null };
    case 'Opening':
      return { at: 2, branch: null };
    case 'Keyed':
      return { at: 3, branch: null };
    case 'Finalized':
      return { at: 4, branch: null };
    case 'Cancelled':
      return {
        at: 2,
        branch: sale.keyRequests === 0 ? 'Cancelled · key never requested' : `Cancelled after ${sale.keyRequests} key ${sale.keyRequests === 1 ? 'request' : 'requests'}`,
      };
  }
}

/** What this browser found when it opened a sale's bids (lib/openCheck.ts), in one or two sentences. */
export function openCheckLine(c: { total: number; opened: number; lastLook: number[]; closed: number[] }): string {
  const ids = (xs: number[]) => xs.map((i) => `#${i}`).join(', ');
  if (c.opened === c.total) return `Checked in your browser: all ${c.total} bids open and match what their bidders stored.`;
  let out = `Checked in your browser: ${c.opened} of ${c.total} bids open and match what their bidders stored.`;
  if (c.lastLook.length > 0) {
    const one = c.lastLook.length === 1;
    out += ` Bid${one ? '' : 's'} ${ids(c.lastLook)} ${one ? 'does' : 'do'} not open, yet ${one ? 'it was' : 'they were'} revealed from the owner's own copy after the key made the other bids public: the last-look case in our limits.`;
  }
  if (c.closed.length > 0) {
    const one = c.closed.length === 1;
    out += ` Bid${one ? '' : 's'} ${ids(c.closed)} ${one ? 'does' : 'do'} not open and ${one ? 'was' : 'were'} not revealed.`;
  }
  return out;
}
