import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { mtBalanceOf, currentSalt as liveSalt, payloadString, blockTimestampNs } from "@tender/intents";
import { bidsDir, consoleIo, writeBidFile, type Io } from "./lib/bidfiles.js";
import { parseCommon, type Common } from "./lib/cli.js";
import { EVIDENCE_DIR } from "./lib/evidence.js";
import {
  TOKEN, approx, assertEvm, forwardQuoteBody, hashesOf, pollStatus, postQuote, returnQuoteBody, submitDeposit,
  type Fetch, type Quote, type StatusBody,
} from "./lib/oneclick.js";
import { RPC } from "./lib/rpc.js";
import { buildTransferPayload } from "./lib/transfer.js";
import { fromUnits, toUnits } from "./lib/units.js";

// S5, the 1Click round trip with real money (mainnet only): Base USDC -> Intents account (forward), Intents account -> Base USDC (return).

const usage = `usage:
  tsx scripts/s5-return.ts --leg forward --evm <0x address of Tender 1> --amount 3 [--dry-quote]
  tsx scripts/s5-return.ts --leg return  --evm <0x address of Tender 1> --amount 1 [--dry-quote]
  tsx scripts/s5-return.ts --watch <depositAddress> --leg forward|return [--origin-tx <0x hash>] [--near-tx <hash> --signer <account>] [--timeout-min 40]
  A quote without --dry-quote is a real quote (dry:false): it returns a deposit address valid for 30 minutes and moves no money by itself.`;

export interface S5Env {
  fetch: Fetch;
  balance(account: string): Promise<bigint>; // Intents USDC
  currentSalt(): Promise<string>;
  nowMs(): Promise<number>;
  sleep(ms: number): Promise<void>;
  /** Signer of a NEAR transaction from the public indexer, `null` when unknown. */
  signerOf(txHash: string): Promise<string | null>;
  record(row: { step: "deposit" | "withdraw"; txHash: string; signer: string; oneclick: string; originTx?: string; destTx?: string; note: string }): Promise<void>;
  writeJson(file: string, data: unknown): void;
  readJson(file: string): unknown | null;
}

export function liveS5Env(c: Common): S5Env {
  const urls = c.rpc ? [c.rpc] : RPC[c.network].normal;
  const intents = process.env.INTENTS_CONTRACT_ID ?? "intents.near";
  return {
    fetch,
    balance: (account) => mtBalanceOf(urls, intents, account, TOKEN.usdcNear),
    currentSalt: () => liveSalt(urls, intents),
    nowMs: async () => Number(await blockTimestampNs(urls)) / 1e6,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    async signerOf(txHash) {
      try {
        const res = await fetch(`https://api.nearblocks.io/v1/txns/${encodeURIComponent(txHash)}`, { signal: AbortSignal.timeout(30_000) });
        if (!res.ok) return null;
        const body: any = await res.json();
        const s = body?.txns?.[0]?.signer_account_id;
        return typeof s === "string" && s !== "" ? s : null;
      } catch {
        return null;
      }
    },
    async record(row) {
      const { recordTx } = await import("./record.js");
      await recordTx({
        network: c.network, sale: "spike", step: row.step, txHash: row.txHash, signer: row.signer, chain: "base",
        oneclick: row.oneclick, originTx: row.originTx, destTx: row.destTx, note: row.note,
      });
    },
    writeJson(file, data) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
    },
    readJson(file) {
      return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
    },
  };
}

export interface S5Deps { env?: (c: Common) => S5Env; io?: Io; evidenceDir?: string; stateDir?: string }

const stateFileName = (leg: string, depositAddress: string) => `s5-${leg}-${depositAddress}.json`;

async function runQuote(leg: "forward" | "return", evm: string, amountText: string, dry: boolean, env: S5Env, io: Io, stateDir: string): Promise<number> {
  assertEvm(evm);
  const amount = toUnits(amountText, 6);
  if (amount < 1n) throw new Error("--amount must be positive");
  const account = evm.toLowerCase();
  const nowMs = await env.nowMs();
  const body = leg === "forward" ? forwardQuoteBody({ evm, amount, dry, nowMs }) : returnQuoteBody({ evm, amount, dry, nowMs });
  const before = await env.balance(account);
  io.out(`${leg} leg · ${fromUnits(amount, 6)} USDC · Intents USDC of ${account} now: ${fromUnits(before, 6)}`);
  if (leg === "return" && before < amount) io.out(`WARN the Intents balance (${fromUnits(before, 6)}) is below the amount: run the forward leg first`);
  io.out(`quote request: ${JSON.stringify(body)}`);
  const q: Quote = await postQuote(body, env.fetch);
  const r = q.quote;
  io.out(`quote: amountIn ${r.amountInFormatted ?? r.amountIn} · amountOut ${r.amountOutFormatted ?? r.amountOut} (min ${approx(BigInt(r.minAmountOut), 6)}) USDC · ~${r.timeEstimate ?? "?"} s`);
  if (dry) {
    io.out("dry quote only: no deposit address. Run again without --dry-quote when you are ready to send (the address is valid for 30 minutes).");
    return 0;
  }
  const addr = r.depositAddress;
  if (!addr) throw new Error("1Click returned no depositAddress for a non-dry quote");
  const file = writeBidFile(stateDir, stateFileName(leg, addr), { leg, evm: account, before: before.toString(), at: new Date(nowMs).toISOString(), quote: q });
  io.out(`depositAddress: ${addr}`);
  io.out(`deadline: ${r.deadline ?? "(none)"} (30 minutes from the quote)`);
  io.out(`saved: ${file} (local only)`);
  if (leg === "forward") {
    io.out(`NEXT: in MetaMask on Base send EXACTLY ${fromUnits(BigInt(r.amountIn), 6)} USDC to ${addr} before the deadline, then run:`);
    io.out(`  pnpm --filter @tender/relayer exec tsx scripts/s5-return.ts --watch ${addr} --leg forward --origin-tx <MetaMask tx hash>`);
  } else {
    const { payload } = await buildTransferPayload({
      signer: account, intents: process.env.INTENTS_CONTRACT_ID ?? "intents.near", receiver: addr, tokenId: TOKEN.usdcNear, amount: BigInt(r.amountIn),
      saltHex: await env.currentSalt(), nowMs,
    });
    io.out(`Transfer to sign (no msg, signed by ${account}): ${JSON.stringify(payload.intents[0])}`);
    io.out(`payload (unsigned, the wallet window shows this shape): ${payloadString(payload)}`);
    io.out(`NEXT: pnpm dev, open #/withdraw, 1 USDC to Base, sign in the wallet window, then run:`);
    io.out(`  pnpm --filter @tender/relayer exec tsx scripts/s5-return.ts --watch ${addr} --leg return --near-tx <relay tx hash> --signer <relayer account>`);
  }
  return 0;
}

async function runWatch(
  addr: string, leg: "forward" | "return", o: { originTx?: string; nearTx?: string; signer?: string; timeoutMin: number; noRecord: boolean; network: string },
  env: S5Env, io: Io, evidenceDir: string, stateDir: string,
): Promise<number> {
  if (o.originTx && leg === "forward") {
    try {
      await submitDeposit(o.originTx, addr, env.fetch);
      io.out(`deposit/submit: told 1Click about ${o.originTx}`);
    } catch (e) {
      io.out(`WARN deposit/submit failed (optional, polling continues): ${(e as Error).message}`);
    }
  }
  const status: StatusBody = await pollStatus(addr, {
    fetch: env.fetch, sleep: env.sleep, now: () => Date.now(), timeoutMs: o.timeoutMin * 60_000, onStatus: (s) => io.out(`status: ${s}`),
  });
  if (status.status !== "SUCCESS") {
    io.err(`FAIL 1Click ended in ${status.status}: ${JSON.stringify(status.swapDetails ?? {}).slice(0, 400)}`);
    io.err("fallback: forward -> PoA deposit address path (G8); return -> ft_withdraw to NEAR, then 1Click ORIGIN_CHAIN");
    return 1;
  }
  const file = join(evidenceDir, "spikes", `s5-${leg}.json`);
  env.writeJson(file, status);
  io.out(`SUCCESS · status JSON saved to ${file}`);

  const sd = status.swapDetails ?? {};
  const nearTxs = hashesOf(sd.nearTxHashes);
  const nearTx = o.nearTx ?? nearTxs[0];
  const originTx = o.originTx ?? hashesOf(sd.originChainTxHashes)[0] ?? (leg === "return" ? nearTx : undefined);
  const destTx = hashesOf(sd.destinationChainTxHashes)[0] ?? (leg === "forward" ? nearTx : undefined);
  io.out(`near tx hashes: ${nearTxs.join(", ") || "(none)"} · origin tx: ${originTx ?? "(none)"} · destination tx: ${destTx ?? "(none)"}`);

  if (leg === "forward") {
    const saved = env.readJson(join(stateDir, stateFileName(leg, addr))) as { evm?: string; before?: string } | null;
    if (saved?.evm && saved.before !== undefined) {
      const after = await env.balance(saved.evm);
      io.out(`Intents USDC of ${saved.evm}: ${fromUnits(BigInt(saved.before), 6)} -> ${fromUnits(after, 6)} (delta ${fromUnits(after - BigInt(saved.before), 6)})`);
    } else io.out(`no saved quote for ${addr} (balance delta not computed); read mt_balance_of by hand`);
  }

  if (o.network !== "mainnet" || o.noRecord) return 0;
  const step = leg === "forward" ? "deposit" : "withdraw";
  if (!nearTx) {
    io.err(`WARN no NEAR transaction hash in the status; record by hand within 2 h: record.ts --sale spike --step ${step} --tx <near hash> --signer <signer> --chain base --oneclick ${addr}`);
    return 0;
  }
  const signer = o.signer ?? (await env.signerOf(nearTx));
  if (!signer) {
    io.err(`WARN could not find the signer of ${nearTx}; record by hand within 2 h: record.ts --sale spike --step ${step} --tx ${nearTx} --signer <signer> --chain base --oneclick ${addr}${originTx ? ` --origin-tx ${originTx}` : ""}${destTx ? ` --dest-tx ${destTx}` : ""}`);
    return 0;
  }
  try {
    await env.record({ step, txHash: nearTx, signer, oneclick: addr, originTx, destTx, note: `S5 ${leg}` });
  } catch (e) {
    io.err(`WARN recording failed (run scripts/record.ts by hand within 2 h, D4-01): ${(e as Error).message}`);
  }
  return 0;
}

export async function main(argv: string[], deps: S5Deps = {}): Promise<number> {
  const io = deps.io ?? consoleIo;
  let parsed;
  try {
    parsed = parseCommon(argv, {
      leg: { type: "string" }, evm: { type: "string" }, amount: { type: "string" }, watch: { type: "string" }, "dry-quote": { type: "boolean" },
      "origin-tx": { type: "string" }, "near-tx": { type: "string" }, signer: { type: "string" }, "timeout-min": { type: "string" },
    });
  } catch (e) {
    io.err(`error: ${(e as Error).message}\n${usage}`);
    return 2;
  }
  const { common, values } = parsed;
  const str = (k: string) => values[k] as string | undefined;
  const leg = str("leg");
  if (leg !== "forward" && leg !== "return") {
    io.err(`error: --leg forward|return is required\n${usage}`);
    return 2;
  }
  if (common.network !== "mainnet") {
    io.err("error: S5 runs on mainnet only (1Click has no testnet)");
    return 2;
  }
  const env = (deps.env ?? liveS5Env)(common);
  const stateDir = deps.stateDir ?? bidsDir();
  try {
    if (str("watch")) {
      const timeoutMin = Number(str("timeout-min") ?? "40");
      if (!Number.isFinite(timeoutMin) || timeoutMin <= 0) throw new Error("--timeout-min must be a positive number");
      return await runWatch(str("watch") as string, leg, {
        originTx: str("origin-tx"), nearTx: str("near-tx"), signer: str("signer"), timeoutMin, noRecord: common.noRecord, network: common.network,
      }, env, io, deps.evidenceDir ?? EVIDENCE_DIR, stateDir);
    }
    if (!str("evm") || !str("amount")) {
      io.err(`error: --evm and --amount are required for a quote\n${usage}`);
      return 2;
    }
    return await runQuote(leg, str("evm") as string, str("amount") as string, values["dry-quote"] === true, env, io, stateDir);
  } catch (e) {
    io.err(`error: ${(e as Error).message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
