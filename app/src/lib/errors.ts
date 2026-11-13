// One place that turns every failure the app can meet into one sentence: what happened and what to do next.
// Errors are matched by shape (name, code, status), so this file imports no wallet, relay or 1Click module.

/** Intents panics (`classifyIntentsError`) and relay outcomes. Same names as `IntentsErrorKind` and `RelayError.kind`. */
const KIND_TEXT: Record<string, string> = {
  insufficient_balance: 'The Intents account does not hold enough USDC for this escrow. Add funds, then sign again.',
  invalid_signature: 'NEAR Intents did not accept the wallet signature. Sign again; if it repeats, reconnect the wallet.',
  public_key_not_registered: 'Register this key with NEAR Intents (one-time, 1 yoctoNEAR), then continue.',
  deadline_expired: 'The signature expired before it was sent. Sign again and send it right away.',
  deadline_gt_nonce: 'The signature deadline is later than its nonce allows. Sign again.',
  nonce_used: 'This signed bid was already sent and cannot run twice. The page checks the chain for it and will not ask for a second signature.',
  nonce_expired: 'The nonce of this signature expired. Sign again.',
  invalid_nonce: 'NEAR Intents rejected the nonce of this signature. Sign again; if it repeats, reload the page.',
  invalid_salt: 'The Intents salt changed while you were signing. Sign again.',
  wrong_verifying_contract: 'The payload was signed for another Intents contract than this page uses. Check the network and sign again.',
  execute_unknown: 'The relayer sent the bid but the answer was lost, so it may still land until its signature expires. The page checks the chain; do not fund or seal again meanwhile.',
  already_stored: 'The chain already shows this sealed bid as stored, so the relayer did not send it again. The page confirms it from the chain.',
  bid_seq: 'You already have more bids in this sale than when this one was prepared, so the contract would refund it. The page shows which bids you have.',
  busy: 'The relayer is busy. Wait 30 seconds, then try again.',
  unconfigured: 'No relayer is configured for this page. Run `pnpm relay:local`, or relay the signed payload yourself.',
  unavailable: 'The relayer is not reachable. Check your connection and try again, or relay the signed payload yourself.',
};

/** 1Click swap statuses (F14). */
const STATUS_TEXT: Record<string, string> = {
  KNOWN_DEPOSIT_TX: '1Click saw the deposit transaction and is waiting for it to confirm.',
  PENDING_DEPOSIT: 'Waiting for the deposit to reach 1Click. This page checks again by itself.',
  INCOMPLETE_DEPOSIT: 'The deposit is below the quoted amount. Get a new quote and try again.',
  PROCESSING: 'Deposit received, 1Click is swapping it. This usually takes less than a minute.',
  SUCCESS: 'Done: the funds arrived.',
  REFUNDED: '1Click refunded the amount. Get a new quote and try again.',
  FAILED: 'The swap failed and 1Click returns the amount. Get a new quote and try again.',
};

export const WALLET_DECLINED = 'You declined the request in your wallet. Nothing was sent; click again when you are ready.';
export const WALLET_BUSY = 'Your wallet already has a request open. Finish or reject it in the wallet, then try again.';
export const RPC_UNAVAILABLE = 'RPC unavailable, retrying';
const NETWORK_TEXT = 'A network service (NEAR RPC or 1Click) is not answering. Check your connection and try again in a moment.';

/** One sentence for a 1Click status, e.g. `humanStatus('INCOMPLETE_DEPOSIT')`. Unknown statuses are returned as they are. */
export function humanStatus(status: string): string {
  return Object.hasOwn(STATUS_TEXT, status) ? STATUS_TEXT[status]! : status;
}

interface ErrorShape {
  name?: unknown;
  code?: unknown;
  status?: unknown;
  kind?: unknown;
  message?: unknown;
  panicMsg?: unknown;
  cause?: unknown;
}

function messageOf(e: unknown): string {
  if (typeof e === 'string') return e;
  if (typeof e === 'object' && e !== null && typeof (e as ErrorShape).message === 'string') return (e as { message: string }).message;
  return '';
}

const REJECTED_RE = /user (rejected|denied|declined|cancell?ed|closed)|rejected the request|request (was )?rejected/i;

/** MetaMask and Phantom reject with code 4001; viem wraps it as `UserRejectedRequestError`; NEAR wallets only send text. */
export function isUserRejection(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return REJECTED_RE.test(messageOf(e));
  const s = e as ErrorShape;
  if (s.code === 4001 || s.code === 'ACTION_REJECTED' || s.code === 'USER_REJECTED') return true;
  if (typeof s.name === 'string' && /UserRejected/i.test(s.name)) return true;
  if (REJECTED_RE.test(messageOf(e))) return true;
  return s.cause !== undefined && s.cause !== e && isUserRejection(s.cause);
}

const NETWORK_RE = /failed to fetch|networkerror|load failed|fetch failed|network request failed|timed? ?out|aborted|econn|enotfound|HTTP \d{3}/i;

/** A transport problem (offline, DNS, timeout, HTTP error) rather than an answer from a contract or service. */
export function isNetworkFailure(e: unknown): boolean {
  if (typeof e === 'object' && e !== null) {
    const name = (e as ErrorShape).name;
    if (name === 'TimeoutError' || name === 'AbortError') return true;
  }
  return NETWORK_RE.test(messageOf(e));
}

/** The sale contract account, or its code, is not on this network (yet): the RPC answers UNKNOWN_ACCOUNT or CodeDoesNotExist. */
export function isNotDeployed(message: string): boolean {
  return /UNKNOWN_ACCOUNT|CodeDoesNotExist|NO_CONTRACT_CODE|account \S+ does not exist|contract code .* not (deployed|found)/i.test(message);
}

/** The text a polled read shows when it fails. Contract-level problems (panic, missing account) are not "RPC unavailable". */
export function isRpcUnavailable(message: string): boolean {
  return !/panic|wasm execution|does not exist|CodeDoesNotExist/i.test(message);
}

function oneClickText(status: number, message: string): string {
  if (status === 429) return '1Click is rate-limiting requests. Wait a minute, then try again.';
  if (status >= 500) return '1Click is unavailable right now. Try again in a minute.';
  if (status === 400) return `1Click rejected this request (${message.replace(/^1Click \d+: /, '')}). Change the amount or the address and try again.`;
  return message;
}

/**
 * Any failure → one sentence for the user. `input` is an Error, a wallet rejection object, a kind
 * (`'insufficient_balance'`, `'busy'`, ...) or a 1Click status. `detail` is the raw text shown for kind `other`.
 * Unknown errors keep their own message: it is better to show the cause than to hide it.
 */
export function humanError(input: unknown, detail?: string): string {
  if (typeof input === 'string') {
    if (Object.hasOwn(KIND_TEXT, input)) return KIND_TEXT[input]!;
    if (Object.hasOwn(STATUS_TEXT, input)) return STATUS_TEXT[input]!;
    if (input === 'other') return detail && detail !== '' ? detail : 'NEAR Intents refused the request. Reload the page and try again.';
  }
  if (isUserRejection(input)) return WALLET_DECLINED;
  if (typeof input === 'object' && input !== null) {
    const s = input as ErrorShape;
    if (s.code === -32002) return WALLET_BUSY;
    if (s.name === 'RelayError' && typeof s.kind === 'string') return humanError(s.kind, messageOf(input));
    if (s.name === 'OneClickError' && typeof s.status === 'number') return oneClickText(s.status, messageOf(input));
    if (s.name === 'ViewPanic' && typeof s.panicMsg === 'string') return `The contract refused the read: ${s.panicMsg}.`;
  }
  const msg = messageOf(input);
  const panic = /Smart contract panicked: (.*)$/s.exec(msg);
  if (panic) return `The contract refused the call: ${panic[1]!.trim()}. Reload the page to see the current sale state.`;
  if (isNetworkFailure(input)) return NETWORK_TEXT;
  return msg !== '' ? msg : 'The request failed. Try again.';
}
