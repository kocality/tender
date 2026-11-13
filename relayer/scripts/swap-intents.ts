import { pathToFileURL } from "node:url";
import { KeyPair } from "near-api-js";
import { ftBalance, nearNative } from "./lib/chain.js";
import { formatDryRunStep, parseCommon, planHeader, type CallStep, type Common } from "./lib/cli.js";
import type { Step } from "./lib/evidence.js";
import {
  TOKEN, approx, listTokens, pollStatus, postQuote, swapQuoteBody, type Fetch, type Quote, type StatusBody, type TokenInfo,
} from "./lib/oneclick.js";
import { view } from "./lib/rpc.js";
import { explorer, type Sent } from "./lib/send.js";
import { liveTransferEnv, signTransfer, type TransferEnv } from "./lib/transfer.js";
import { fromUnits, toUnits } from "./lib/units.js";

// Inside one Intents account: swap a token for another through 1Click (H-JAMBO), or send a token to another account (H-TOPUP, D4-21).

const usage = `usage:
  tsx scripts/swap-intents.ts --from nep141:wrap.near --to nep141:jambo-1679.meme-cooking.near --amount 1.2 [--signer tenderseal.near] [--yes]
  tsx scripts/swap-intents.ts --transfer-to <account> --token <nep141:id> --amount <decimal> [--signer tenderseal.near] [--yes]
  Dry-run unless --yes. The swap needs mainnet (1Click); the signer's key must be registered in intents.near (H-INTENTS-KEYS).`;

// Known tokens, used only if 1Click's /v0/tokens cannot be read.
const FALLBACK: TokenInfo[] = [
  { assetId: TOKEN.wnear, symbol: "wNEAR", decimals: 24 },
  { assetId: TOKEN.jambo, symbol: "JAMBO", decimals: 18 },
  { assetId: TOKEN.usdcNear, symbol: "USDC", decimals: 6 },
];

const GAS_RESERVE = 35n * 10n ** 22n; // 0.35 NEAR kept in the account after wrapping, for the 300 Tgas calls
const ACCOUNT_RE = /^(?:0x[0-9a-f]{40}|[0-9a-f]{64}|[a-z0-9][a-z0-9._-]{1,63})$/;

export interface SwapEnv extends TransferEnv {
  fetch: Fetch;
  tokens(): Promise<TokenInfo[]>;
  nativeBalance(account: string): Promise<bigint | null>;
  ftState(contract: string, account: string): Promise<{ registered: boolean; ft: bigint }>;
}

export function liveSwapEnv(c: Common): SwapEnv {
  return {
    ...liveTransferEnv(c),
    fetch,
    async tokens() {
      try {
        return await listTokens();
      } catch {
        return FALLBACK;
      }
    },
    nativeBalance: (a) => nearNative(c.network, a, { rpc: c.rpc }),
    async ftState(contract, account) {
      const registered = (await view<unknown>(c.network, contract, "storage_balance_of", { account_id: account })) !== null;
      return { registered, ft: registered ? await ftBalance(c.network, contract, account) : 0n };
    },
  };
}

export interface FundingState {
  intentsBalance: bigint; // signer's Intents balance of the `from` token
  wrapFt: bigint; // signer's wrap.near NEP-141 balance
  wrapRegistered: boolean;
  nativeBalance: bigint | null;
}

/** Pure. How to get `need` of the `from` token into the signer's Intents account. Only wNEAR can be made on the spot. */
export function planFunding(o: { signer: string; intents: string; from: string; wrap: string; need: bigint; network: Common["network"] }, st: FundingState) {
  const steps: CallStep[] = [];
  const kinds: Step[] = [];
  const problems: string[] = [];
  const notes: string[] = [];
  const missing = o.need > st.intentsBalance ? o.need - st.intentsBalance : 0n;
  if (missing === 0n) {
    notes.push(`Intents ${o.from} balance ${st.intentsBalance} already covers ${o.need}: no funding steps`);
    return { steps, kinds, problems, notes };
  }
  if (o.from !== `nep141:${o.wrap}`) {
    problems.push(`${o.signer} holds ${st.intentsBalance} of ${o.from} in Intents, the swap needs ${o.need}: deposit it first`);
    return { steps, kinds, problems, notes };
  }
  if (!st.wrapRegistered) {
    steps.push({ signer: o.signer, receiver: o.wrap, method: "storage_deposit", args: { account_id: o.signer, registration_only: true }, deposit: "0.00125 NEAR", gasTgas: 30, network: o.network });
    kinds.push("storage");
  }
  const wrapNeeded = missing > st.wrapFt ? missing - st.wrapFt : 0n;
  if (wrapNeeded > 0n) {
    steps.push({ signer: o.signer, receiver: o.wrap, method: "near_deposit", args: {}, deposit: `${fromUnits(wrapNeeded, 24)} NEAR`, gasTgas: 30, network: o.network });
    kinds.push("fund");
    if (st.nativeBalance === null) problems.push(`${o.signer} does not exist on ${o.network} yet (G-ACCT)`);
    else if (st.nativeBalance < wrapNeeded + GAS_RESERVE) problems.push(`${o.signer} holds ${fromUnits(st.nativeBalance, 24)} NEAR, wrapping ${fromUnits(wrapNeeded, 24)} plus 0.35 for gas needs more (H-03)`);
  }
  steps.push({ signer: o.signer, receiver: o.wrap, method: "ft_transfer_call", args: { receiver_id: o.intents, amount: missing.toString(), msg: "" }, deposit: "1 yoctoNEAR", gasTgas: 100, network: o.network });
  kinds.push("fund");
  return { steps, kinds, problems, notes };
}

/** One-line dry quote for the human to read. */
export function dryQuoteLine(q: Quote, from: TokenInfo, to: TokenInfo, amount: bigint): string {
  return `dry quote: ${fromUnits(amount, from.decimals)} ${from.symbol} → ~${approx(BigInt(q.quote.amountOut), to.decimals)} ${to.symbol} (min ~${approx(BigInt(q.quote.minAmountOut), to.decimals)}), ~${q.quote.timeEstimate ?? "?"} s`;
}

export interface SwapDeps { env?: (c: Common) => SwapEnv; out?: (l: string) => void; err?: (l: string) => void }

export async function main(argv: string[], deps: SwapDeps = {}): Promise<number> {
  const out = deps.out ?? ((l) => console.log(l));
  const err = deps.err ?? ((l) => console.error(l));
  let parsed;
  try {
    parsed = parseCommon(argv, {
      from: { type: "string" }, to: { type: "string" }, amount: { type: "string" }, signer: { type: "string" },
      "transfer-to": { type: "string" }, token: { type: "string" }, intents: { type: "string" }, wrap: { type: "string" },
    });
  } catch (e) {
    err(`error: ${(e as Error).message}\n${usage}`);
    return 2;
  }
  const { common, values } = parsed;
  const str = (k: string) => values[k] as string | undefined;
  const network = common.network;
  const signer = (str("signer") ?? process.env.TENDER_TEAM_ACCOUNT_ID ?? "tenderseal.near").toLowerCase();
  const intents = str("intents") ?? process.env.INTENTS_CONTRACT_ID ?? "intents.near";
  const wrap = str("wrap") ?? (network === "mainnet" ? "wrap.near" : "wrap.testnet");
  const transferTo = str("transfer-to");
  if (!str("amount") || (transferTo ? !str("token") : !str("from") || !str("to"))) {
    err(`error: missing arguments\n${usage}`);
    return 2;
  }
  if (!transferTo && network !== "mainnet") {
    err("error: the swap runs on mainnet only (1Click has no testnet)");
    return 2;
  }
  const env = (deps.env ?? liveSwapEnv)(common);

  try {
    const tokens = await env.tokens();
    const find = (id: string) => {
      const t = tokens.find((x) => x.assetId === id) ?? FALLBACK.find((x) => x.assetId === id);
      if (!t) throw new Error(`token ${id} is not in 1Click's token list`);
      return t;
    };
    const secret = env.secretKey(signer);
    const publicKey = secret ? KeyPair.fromString(secret).getPublicKey().toString() : null;
    const record = async (step: Step, tx: string, note: string, oneclick?: string) => {
      if (network !== "mainnet" || common.noRecord) return;
      try {
        await env.record({ sale: "ops", step, txHash: tx, signer, note, oneclick });
      } catch (e) {
        err(`WARN recording failed (run scripts/record.ts by hand within 2 h, D4-01): ${(e as Error).message}`);
      }
    };
    const show = (r: Sent) => out(`tx=${r.hash} status=${r.ok ? "SuccessValue" : "Failure"} block=${r.block} url=${explorer(network, r.hash)}`);
    /** key registration: a blocking problem when a real send is asked for, otherwise a note */
    const keyProblems = async (problems: string[], notes: string[]) => {
      if (!secret || !publicKey) {
        (common.dryRun ? notes : problems).push(`no key for ${signer} on ${network}${common.dryRun ? ": signature and simulate_intents are skipped" : " (looked in the near-credentials directory)"}`);
        return;
      }
      if (!(await env.intentsKeys(intents, signer)).includes(publicKey)) problems.push(`run H-INTENTS-KEYS for ${signer}: ${publicKey} is not registered in ${intents} (intents.add_public_key, 1 yocto)`);
    };

    // ---------------- plain transfer (H-TOPUP) ----------------
    if (transferTo) {
      if (!ACCOUNT_RE.test(transferTo)) throw new Error(`--transfer-to "${transferTo}" is not a NEAR account id, a 64-hex implicit account or a lowercase 0x address`);
      const tokenId = str("token") as string;
      const tok = find(tokenId);
      const amount = toUnits(str("amount") as string, tok.decimals);
      if (amount < 1n) throw new Error("--amount must be positive");
      const problems: string[] = [];
      const notes: string[] = [];
      const have = await env.balance(intents, signer, tokenId);
      out(`${signer} Intents ${tok.symbol}: ${fromUnits(have, tok.decimals)} · sending ${fromUnits(amount, tok.decimals)} to ${transferTo}`);
      if (have < amount) problems.push(`${signer} holds ${have} of ${tokenId} in Intents, the transfer needs ${amount}`);
      await keyProblems(problems, notes);
      let signed: Awaited<ReturnType<typeof signTransfer>> | null = null;
      if (secret && problems.length === 0) {
        signed = await signTransfer(env, { signer, intents, receiver: transferTo, tokenId, amount });
        const sim = await env.simulate(intents, signed.mp);
        out(`simulate_intents: ${sim.ok ? "ok" : `${sim.kind}: ${sim.message}`}`);
        if (!sim.ok) problems.push(`simulate_intents failed (${sim.kind})`);
      }
      for (const n of notes) out(n);
      out(planHeader(common.dryRun));
      out(`[1/1] signer=${signer} receiver=${intents} method=execute_intents deposit=0 NEAR gas=300 Tgas`);
      out(`      transfer=${amount} of ${tokenId} to ${transferTo} (no msg), nep413-signed by ${signer}`);
      for (const p of problems) out(`BLOCKED: ${p}`);
      if (common.dryRun) return problems.length ? 1 : 0;
      if (problems.length || !signed) return 2;
      const r = await env.executeIntents(signer, intents, signed.mp);
      show(r);
      await record("fund", r.hash, `transfer to ${transferTo} (H-TOPUP)`);
      if (!r.ok) {
        err(`FAIL execute_intents: ${JSON.stringify(r.status).slice(0, 400)}`);
        return 1;
      }
      out(`OK ${transferTo} Intents ${tok.symbol}: ${fromUnits(await env.balance(intents, transferTo, tokenId), tok.decimals)}`);
      return 0;
    }

    // ---------------- swap (H-JAMBO) ----------------
    const from = find(str("from") as string);
    const to = find(str("to") as string);
    const amount = toUnits(str("amount") as string, from.decimals);
    if (amount < 1n) throw new Error("--amount must be positive");
    const isWrap = from.assetId === `nep141:${wrap}`;
    const st: FundingState = {
      intentsBalance: await env.balance(intents, signer, from.assetId),
      wrapFt: 0n,
      wrapRegistered: true,
      nativeBalance: await env.nativeBalance(signer),
    };
    if (isWrap) {
      const s = await env.ftState(wrap, signer);
      st.wrapFt = s.ft;
      st.wrapRegistered = s.registered;
    }
    const plan = planFunding({ signer, intents, from: from.assetId, wrap, need: amount, network }, st);
    await keyProblems(plan.problems, plan.notes);

    const dry = await postQuote(swapQuoteBody({ from: from.assetId, to: to.assetId, amount, account: signer, dry: true, nowMs: await env.nowMs() }), env.fetch);
    for (const n of plan.notes) out(n);
    out(dryQuoteLine(dry, from, to, amount));
    out(planHeader(common.dryRun));
    const total = plan.steps.length + 1;
    plan.steps.forEach((s, i) => out(formatDryRunStep(i + 1, total, s)));
    out(`[${total}/${total}] signer=${signer} receiver=${intents} method=execute_intents deposit=0 NEAR gas=300 Tgas`);
    out(`      swap=${amount} of ${from.assetId} to the 1Click deposit address (a new non-dry quote, depositType INTENTS, recipient ${signer}), nep413-signed by ${signer}, no msg`);
    if (secret && plan.problems.length === 0 && plan.steps.length === 0) {
      const sim = await env.simulate(intents, (await signTransfer(env, { signer, intents, receiver: "dry-run-placeholder.near", tokenId: from.assetId, amount })).mp);
      out(`      simulate_intents (placeholder receiver): ${sim.ok ? "ok" : `${sim.kind}: ${sim.message}`}`);
      if (!sim.ok) plan.problems.push(`simulate_intents failed (${sim.kind})`);
    }
    for (const p of plan.problems) out(`BLOCKED: ${p}`);
    if (common.dryRun) return plan.problems.length ? 1 : 0;
    if (plan.problems.length) return 2;

    // real run
    for (let i = 0; i < plan.steps.length; i++) {
      const s = plan.steps[i] as CallStep;
      const r = await env.call(s);
      show(r);
      await record(plan.kinds[i] as Step, r.hash, `swap prerequisite ${s.method}`);
      if (!r.ok) {
        err(`FAIL step ${i + 1}/${total - 1} ${s.method}: ${JSON.stringify(r.status).slice(0, 400)}`);
        return 1;
      }
    }
    if (plan.steps.length && (await env.balance(intents, signer, from.assetId)) < amount) throw new Error(`after funding, ${signer} still holds less than ${amount} of ${from.assetId} in Intents`);

    const q = await postQuote(swapQuoteBody({ from: from.assetId, to: to.assetId, amount, account: signer, dry: false, nowMs: await env.nowMs() }), env.fetch);
    const addr = q.quote.depositAddress;
    if (!addr) throw new Error("1Click returned no depositAddress for the non-dry quote");
    if (BigInt(q.quote.amountIn) !== amount) throw new Error(`the quote wants ${q.quote.amountIn} in, not ${amount}; refusing to sign`);
    out(`quote: ${fromUnits(amount, from.decimals)} ${from.symbol} → ~${approx(BigInt(q.quote.amountOut), to.decimals)} ${to.symbol} (min ~${approx(BigInt(q.quote.minAmountOut), to.decimals)}) · depositAddress ${addr} · deadline ${q.quote.deadline ?? "?"}`);
    const toBefore = await env.balance(intents, signer, to.assetId);
    const { mp } = await signTransfer(env, { signer, intents, receiver: addr, tokenId: from.assetId, amount });
    const sim = await env.simulate(intents, mp);
    if (!sim.ok) {
      err(`simulate_intents failed (${sim.kind}): ${sim.message}`);
      return 1;
    }
    out("simulate_intents: ok");
    const r = await env.executeIntents(signer, intents, mp);
    show(r);
    if (!r.ok) {
      await record("swap", r.hash, `swap ${from.symbol}->${to.symbol} execute_intents FAILED`);
      err(`FAIL execute_intents: ${JSON.stringify(r.status).slice(0, 400)}`);
      return 1;
    }
    const status: StatusBody = await pollStatus(addr, { fetch: env.fetch, sleep: env.sleep, onStatus: (s) => out(`status: ${s}`), timeoutMs: 15 * 60_000 });
    if (status.status !== "SUCCESS") {
      await record("swap", r.hash, `swap ${from.symbol}->${to.symbol} ended ${status.status}`);
      err(`FAIL 1Click ended in ${status.status}: ${JSON.stringify(status.swapDetails ?? {}).slice(0, 400)} (a REFUNDED swap returns the tokens to ${signer} in Intents)`);
      return 1;
    }
    await record("swap", r.hash, `swap ${from.symbol}->${to.symbol}`, addr);
    const toAfter = await env.balance(intents, signer, to.assetId);
    out(`SUCCESS · ${signer} ${to.symbol} in Intents: ~${approx(toAfter, to.decimals)} (+${approx(toAfter - toBefore, to.decimals)})`);
    return 0;
  } catch (e) {
    err(`error: ${(e as Error).message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
