import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ftBalance, intentsBalances } from "./lib/chain.js";
import { formatDryRunStep, parseCommon, planHeader, type CallStep } from "./lib/cli.js";
import { SALE_TAGS, type SaleTag, type Step } from "./lib/evidence.js";
import { makeAccount, sendStep, explorer } from "./lib/send.js";
import { view, type Network } from "./lib/rpc.js";
import { getConfig, getSale, getSales, type SaleView } from "./lib/views.js";
import { fromUnits, toUnits } from "./lib/units.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ONECLICK_TOKENS = "https://1click.chaindefuser.com/v0/tokens";
const MAX_ESCROW_TOTAL = 1_000_000_000_000n; // micro-USDC per sale, contract/src/sale.rs (relayer/test/sale.test.ts reads it from there)

export interface SaleSpec {
  tag: SaleTag;
  id: string;
  contract: string;
  seller: string;
  token_id: string;
  amount: string; // base units, or "intents_balance"
  wrap_near?: string;
  close: { relative_secs?: number; utc?: string; utc_fallback?: string };
  create_at_utc?: string;
  msg: {
    op: "create"; reveal_secs: string; reserve: string; min_escrow: string; min_bidders: number;
    quote_token: string; max_bids: number; decimals: number; lot_exp: number;
  };
}

export interface SaleOpts {
  network: Network;
  contract: string;
  seller: string;
  intents: string;
  wrap: string; // wrap.near on mainnet
  quoteToken?: string;
  fallback: boolean;
  allowIdMismatch: boolean;
  reserveOverride?: string;
  again?: boolean; // create a sale identical to an Open one on purpose
}

export interface SaleState {
  nowMs: number;
  nextId: string | null; // null = the contract does not exist yet / view unavailable
  intentsBalance: bigint; // seller's Intents balance of the sale token
  wrapFtBalance: bigint; // seller's wrap.near fungible-token balance
  wrapRegistered: boolean; // storage_balance_of(seller) is not null
  price?: { price: string; updatedAt: string }; // JAMBO USD price from 1Click, decimal string
  decimals?: { token: number | null; quote: number | null }; // ft_metadata().decimals of the sale token and of the quote token; null = unreadable; absent = not checked
  existing?: SaleView[]; // the contract's sales; absent = not checked
}

export interface SalePlan {
  steps: CallStep[];
  stepKinds: Step[];
  createMsg: Record<string, unknown>;
  saleId: string; // the id the new sale gets: the spec id, or the contract's next id under --allow-id-mismatch
  closeNs: bigint;
  amount: bigint;
  tokenId: string;
  problems: string[];
  notes: string[];
}

/** A JSON number token such as 0.00019385281604366526 or 1.5e-7 -> exact decimal digits and scale (value = digits / 10^scale). */
export function parseDecimal(token: string): { digits: bigint; scale: number } {
  const m = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(token.trim());
  if (!m) throw new Error(`not a decimal number: "${token}"`);
  const frac = m[2] ?? "";
  let scale = frac.length - Number(m[3] ?? 0);
  let digits = BigInt((m[1] as string) + frac);
  if (scale < 0) {
    digits *= 10n ** BigInt(-scale);
    scale = 0;
  }
  return { digits, scale };
}

/** floor(price_usd * 10^lot_exp * 10^6 * 0.9): micro-USDC per 10^lot_exp tokens, 90% of the 1Click price. String math, no floats. */
export function reserveFromPrice(price: string, lotExp: number): bigint {
  const { digits, scale } = parseDecimal(price);
  return (digits * 9n * 10n ** BigInt(lotExp + 6)) / (10n * 10n ** BigInt(scale));
}

export function closeNs(spec: SaleSpec, nowMs: number, fallback: boolean): bigint {
  const c = spec.close;
  if (c.relative_secs !== undefined) return (BigInt(nowMs) + BigInt(c.relative_secs) * 1000n) * 1_000_000n;
  const utc = fallback ? c.utc_fallback : c.utc;
  if (!utc) throw new Error(fallback ? `sale ${spec.tag} has no utc_fallback` : `sale ${spec.tag} has no close time`);
  const ms = Date.parse(utc);
  if (Number.isNaN(ms)) throw new Error(`bad close time "${utc}"`);
  return BigInt(ms) * 1_000_000n;
}

const near = (yocto: bigint) => `${fromUnits(yocto, 24)} NEAR`;

/** Pure. Anything that stops a real send goes into `problems`; a dry-run still prints the plan. */
export function planSale(spec: SaleSpec, o: SaleOpts, st: SaleState): SalePlan {
  const problems: string[] = [];
  const notes: string[] = [];
  const steps: CallStep[] = [];
  const stepKinds: Step[] = [];
  const net = o.network;
  const tokenId = spec.token_id === "nep141:wrap.near" ? `nep141:${o.wrap}` : spec.token_id;
  const isWrap = tokenId === `nep141:${o.wrap}`;

  if (st.nextId === null) notes.push(`next sale id: account ${o.contract} does not exist yet (dry-run continues with id check skipped)`);
  else if (st.nextId !== spec.id && !o.allowIdMismatch) {
    problems.push(`next sale id on ${o.contract} is ${st.nextId} but sale ${spec.tag} is id ${spec.id}; create sales in order #0, #1, #2, #3 (M16) or pass --allow-id-mismatch`);
  } else notes.push(`next sale id: ${st.nextId}${st.nextId !== spec.id ? ` (spec id ${spec.id}, --allow-id-mismatch)` : ""}`);

  // close_ns and the C6 window
  const close = closeNs(spec, st.nowMs, o.fallback);
  const nowNs = BigInt(st.nowMs) * 1_000_000n;
  if (close < nowNs + 300n * 1_000_000_000n) problems.push(`close ${new Date(Number(close / 1_000_000n)).toISOString()} is less than 300 s from now (C6)`);
  if (close > nowNs + 30n * 86_400n * 1_000_000_000n) problems.push(`close ${new Date(Number(close / 1_000_000n)).toISOString()} is more than 30 days from now (C6)`);
  if (spec.create_at_utc) notes.push(`planned creation time: ${spec.create_at_utc}`);

  // decimals + lot_exp must stay inside the contract's create window (refund reason decimals_plus_lot_exp)
  const scaleExp = spec.msg.decimals + spec.msg.lot_exp;
  if (scaleExp < 20 || scaleExp > 26) problems.push(`decimals + lot_exp is ${scaleExp}, create needs 20 to 26 (the contract refunds with decimals_plus_lot_exp)`);

  // The contract cannot read ft_metadata in mt_on_transfer, so a wrong declared `decimals` would shift every price unit by 10^k and still verify (X12-03)
  if (st.decimals) {
    const asset = (id: string) => id.replace(/^nep141:/, "");
    const check = (what: string, got: number | null, want: number) => {
      if (got === null) (net === "mainnet" ? problems : notes).push(`cannot read ft_metadata of ${what}; its decimals ${want} are unchecked`);
      else if (got !== want) problems.push(`${what} has decimals ${got} in ft_metadata but the sale says ${want}; every price and amount would be off by 10^${Math.abs(got - want)}`);
    };
    check(asset(tokenId), st.decimals.token, spec.msg.decimals);
    check(`the quote token ${asset(o.quoteToken ?? spec.msg.quote_token)}`, st.decimals.quote, 6);
  }

  // contract/src/sale.rs MAX_ESCROW_TOTAL: validate_bid refuses a bid that takes a sale's escrow above it
  if (BigInt(spec.msg.min_escrow) > MAX_ESCROW_TOTAL) notes.push(`min_escrow ${spec.msg.min_escrow} is above the contract's per-sale escrow cap ${MAX_ESCROW_TOTAL}: this sale can never open and ends by cancel (intended for the twin's failed half)`);

  // reserve
  let reserve = spec.msg.reserve;
  if (o.reserveOverride !== undefined) {
    reserve = o.reserveOverride;
    notes.push(`reserve overridden by --reserve: ${reserve}`);
  } else if (reserve.startsWith("auto:")) {
    if (!st.price) problems.push("reserve is auto:oneclick_x0.9 but the 1Click price is unavailable; pass --reserve <micro-USDC per 10^lot_exp tokens>");
    else {
      reserve = reserveFromPrice(st.price.price, spec.msg.lot_exp).toString();
      notes.push(`reserve auto: JAMBO $${st.price.price} at ${st.price.updatedAt} → 0.9 × … = ${reserve} micro-USDC per ${10 ** spec.msg.lot_exp} JAMBO`);
    }
  }

  // amount
  let amount: bigint;
  if (spec.amount === "intents_balance") amount = st.intentsBalance;
  else amount = BigInt(spec.amount);
  if (spec.wrap_near !== undefined && toUnits(spec.wrap_near, 24) !== amount) problems.push(`wrap_near ${spec.wrap_near} does not equal amount ${spec.amount}`);

  const missing = amount > st.intentsBalance ? amount - st.intentsBalance : 0n;
  if (!isWrap && (missing > 0n || amount === 0n)) {
    problems.push(`${o.seller} holds ${st.intentsBalance} of ${tokenId} in Intents, the sale needs ${amount > 0n ? amount : "a positive amount"}: run H-JAMBO first`);
  } else if (amount === 0n) problems.push("sale amount is 0");
  if (missing > 0n && isWrap) {
    if (!st.wrapRegistered) {
      steps.push({ signer: o.seller, receiver: o.wrap, method: "storage_deposit", args: { account_id: o.seller, registration_only: true }, deposit: "0.00125 NEAR", gasTgas: 30, network: net });
      stepKinds.push("storage");
    }
    const wrapNeeded = missing > st.wrapFtBalance ? missing - st.wrapFtBalance : 0n;
    if (wrapNeeded > 0n) {
      steps.push({ signer: o.seller, receiver: o.wrap, method: "near_deposit", args: {}, deposit: near(wrapNeeded), gasTgas: 30, network: net });
      stepKinds.push("fund");
    }
    steps.push({ signer: o.seller, receiver: o.wrap, method: "ft_transfer_call", args: { receiver_id: o.intents, amount: missing.toString(), msg: "" }, deposit: "1 yoctoNEAR", gasTgas: 100, network: net });
    stepKinds.push("fund");
  } else if (isWrap) notes.push("wrap steps skipped: the Intents balance already covers the amount");

  // C5 create msg, field order fixed
  const m = spec.msg;
  const createMsg = {
    op: "create",
    close_ns: close.toString(),
    reveal_secs: m.reveal_secs,
    reserve,
    min_escrow: m.min_escrow,
    min_bidders: m.min_bidders,
    quote_token: o.quoteToken ?? m.quote_token,
    max_bids: m.max_bids,
    decimals: m.decimals,
    lot_exp: m.lot_exp,
  };
  steps.push({
    signer: o.seller, receiver: o.intents, method: "mt_transfer_call",
    args: { receiver_id: o.contract, token_id: tokenId, amount: amount.toString(), approval: null, memo: null, msg: JSON.stringify(createMsg) },
    deposit: "1 yoctoNEAR", gasTgas: 100, network: net,
  });
  stepKinds.push("create");
  const saleId = o.allowIdMismatch && st.nextId !== null ? st.nextId : spec.id;

  // A create whose answer was lost and is then re-run makes a second sale with the same terms; the bids split between the two.
  const twin = (st.existing ?? []).find((s) =>
    (s.state === "Open" || s.state === "Opening") && s.seller === o.seller && s.token === tokenId && s.supply === amount.toString()
    && (spec.close.relative_secs !== undefined || s.close_ns === close.toString())
    && s.reserve === reserve && s.min_escrow === m.min_escrow && s.min_bidders === m.min_bidders && s.max_bids === m.max_bids
    && s.quote_token === createMsg.quote_token && s.decimals === m.decimals && s.lot_exp === m.lot_exp && s.reveal_secs === m.reveal_secs);
  if (twin) {
    if (o.again) notes.push(`--again: sale ${twin.id} is already Open with the same terms; creating another on purpose`);
    else problems.push(`sale ${twin.id} on ${o.contract} is already Open with the same seller, token, supply, close and terms; pass --again to create another`);
  }
  return { steps, stepKinds, createMsg, saleId, closeNs: close, amount, tokenId, problems, notes };
}

export function loadSpec(tag: string, dir = resolve(ROOT, "sales")): SaleSpec {
  if (!(SALE_TAGS as readonly string[]).includes(tag) || ["lock", "spike", "ops"].includes(tag)) throw new Error(`--sale must be one of R|0|1|2|3, got "${tag}"`);
  return JSON.parse(readFileSync(resolve(dir, `${tag}.json`), "utf8")) as SaleSpec;
}

/** The id the next sale gets = get_config().sales; null when the account (or its code) does not exist yet. */
async function nextSaleId(network: Network, contract: string): Promise<string | null> {
  try {
    return (await getConfig(network, contract)).sales;
  } catch (e) {
    if (/UNKNOWN_ACCOUNT|CodeDoesNotExist|does not exist/.test((e as Error).message)) return null;
    throw e;
  }
}

async function jamboPrice(): Promise<{ price: string; updatedAt: string } | undefined> {
  try {
    const res = await fetch(ONECLICK_TOKENS, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const entry = /\{[^{}]*"assetId"\s*:\s*"nep141:jambo-1679\.meme-cooking\.near"[^{}]*\}/.exec(text)?.[0];
    const price = entry && /"price"\s*:\s*([0-9.eE+-]+)/.exec(entry)?.[1];
    const updatedAt = entry && /"priceUpdatedAt"\s*:\s*"([^"]+)"/.exec(entry)?.[1];
    if (!price || !updatedAt) throw new Error("JAMBO entry not found");
    return { price, updatedAt };
  } catch (e) {
    console.warn(`WARN 1Click /v0/tokens: ${(e as Error).message}`);
    return undefined;
  }
}

const usage = `usage:
  tsx scripts/sale.ts --sale <R|0|1|2|3> [--network mainnet|testnet] [--contract <override>] [--close fallback] [--allow-id-mismatch] [--again] [--yes]
    [--seller <id>] [--intents <id>] [--wrap <id>] [--quote-token <nep141:...>] [--reserve <n>]
  Dry-run unless --yes. Testnet needs --seller, --intents, --wrap and --quote-token for the M3 copies.`;

export async function main(argv: string[]): Promise<number> {
  const { common, values } = parseCommon(argv, {
    sale: { type: "string" }, close: { type: "string" }, "allow-id-mismatch": { type: "boolean" }, again: { type: "boolean" }, seller: { type: "string" },
    intents: { type: "string" }, wrap: { type: "string" }, "quote-token": { type: "string" }, reserve: { type: "string" },
  });
  const str = (k: string) => values[k] as string | undefined;
  if (!str("sale")) {
    console.error(usage);
    return 2;
  }
  try {
    const spec = loadSpec(str("sale") as string);
    const network = common.network;
    const o: SaleOpts = {
      network,
      contract: str("contract") ?? spec.contract,
      seller: str("seller") ?? spec.seller,
      intents: str("intents") ?? (network === "mainnet" ? (process.env.INTENTS_CONTRACT_ID ?? "intents.near") : (process.env.INTENTS_CONTRACT_ID as string)),
      wrap: str("wrap") ?? (network === "mainnet" ? "wrap.near" : "wrap.testnet"),
      quoteToken: str("quote-token"),
      fallback: str("close") === "fallback",
      allowIdMismatch: values["allow-id-mismatch"] === true,
      again: values.again === true,
      reserveOverride: str("reserve"),
    };
    if (!o.intents || (network === "testnet" && o.intents === "intents.near")) throw new Error("--intents <testnet Intents copy> is required on testnet");
    if (str("close") !== undefined && str("close") !== "fallback") throw new Error("--close only accepts fallback");

    const tokenId = spec.token_id === "nep141:wrap.near" ? `nep141:${o.wrap}` : spec.token_id;
    const nextId = await nextSaleId(network, o.contract);
    const [intentsBalance] = await intentsBalances(network, o.intents, o.seller, [tokenId]);
    const isWrap = tokenId === `nep141:${o.wrap}`;
    let wrapFtBalance = 0n;
    let wrapRegistered = true;
    if (isWrap) {
      wrapFtBalance = await ftBalance(network, o.wrap, o.seller);
      wrapRegistered = (await view<unknown>(network, o.wrap, "storage_balance_of", { account_id: o.seller })) !== null;
    }
    const decimalsOf = async (assetId: string): Promise<number | null> => {
      if (!assetId.startsWith("nep141:")) return null;
      try {
        const meta = await view<{ decimals?: unknown }>(network, assetId.slice("nep141:".length), "ft_metadata", {});
        return typeof meta?.decimals === "number" ? meta.decimals : null;
      } catch {
        return null; // a testnet mock without ft_metadata, or an RPC problem: planSale decides what that means
      }
    };
    const decimals = { token: await decimalsOf(tokenId), quote: await decimalsOf(o.quoteToken ?? spec.msg.quote_token) };
    const needsPrice = o.reserveOverride === undefined && spec.msg.reserve.startsWith("auto:");
    const plan = planSale(spec, o, {
      nowMs: Date.now(), nextId, existing: nextId === null ? [] : await getSales(network, o.contract, common.rpc), intentsBalance: intentsBalance as bigint, wrapFtBalance, wrapRegistered, price: needsPrice ? await jamboPrice() : undefined, decimals,
    });

    for (const n of plan.notes) console.log(n);
    console.log(`close_ns ${plan.closeNs} (${new Date(Number(plan.closeNs / 1_000_000n)).toISOString()}), amount ${plan.amount}, token ${plan.tokenId}`);
    console.log(planHeader(!common.yes || common.dryRunFlag));
    plan.steps.forEach((s, i) => console.log(formatDryRunStep(i + 1, plan.steps.length, s)));
    for (const p of plan.problems) console.log(`BLOCKED: ${p}`);
    if (!common.yes || common.dryRunFlag) return plan.problems.length ? 1 : 0;
    if (plan.problems.length) return 2;
    if (nextId === null) throw new Error(`${o.contract} does not exist, refusing to send`);

    const account = makeAccount(network, o.seller, common.rpc);
    const { recordTx } = await import("./record.js");
    for (let i = 0; i < plan.steps.length; i++) {
      const s = plan.steps[i] as CallStep;
      const r = await sendStep(account, s, common.rpc);
      console.log(`tx=${r.hash} status=${r.ok ? "SuccessValue" : "Failure"} block=${r.block} url=${explorer(network, r.hash)}`);
      if (network === "mainnet" && !common.noRecord) {
        try {
          await recordTx({ network, sale: spec.tag, step: plan.stepKinds[i] as Step, txHash: r.hash, signer: o.seller, contract: o.contract, chain: "near" });
        } catch (e) {
          console.warn(`WARN recording failed (run scripts/record.ts by hand within 2 h, D4-01): ${(e as Error).message}`);
        }
      }
      if (!r.ok) {
        console.error(`FAIL step ${i + 1}/${plan.steps.length} ${s.method}: ${JSON.stringify(r.status).slice(0, 400)}`);
        return 1;
      }
      if (i === plan.steps.length - 1) {
        const sale = await getSale(network, o.contract, plan.saleId);
        const good = sale && sale.seller === o.seller && sale.close_ns === plan.closeNs.toString() && sale.supply === plan.amount.toString();
        if (good) console.log(`OK sale ${plan.saleId} created`);
        else {
          const refund = r.logs.filter((l) => /refund/i.test(l));
          console.error(`FAIL sale ${plan.saleId} not found or differs from the request; contract log: ${refund.join(" | ") || r.logs.join(" | ") || "(no log)"}`);
          return 1;
        }
      }
    }
    return 0;
  } catch (e) {
    console.error(`error: ${(e as Error).message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
