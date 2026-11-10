import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { KeyPair } from "near-api-js";
import { ftBalance, nearNative } from "./lib/chain.js";
import { DRY_RUN_HEADER, formatDryRunStep, parseCommon, type CallStep, type Common } from "./lib/cli.js";
import { EVIDENCE_DIR, type Step } from "./lib/evidence.js";
import { TOKEN } from "./lib/oneclick.js";
import { view } from "./lib/rpc.js";
import { explorer, type Sent } from "./lib/send.js";
import { liveTransferEnv, signTransfer, type TransferEnv } from "./lib/transfer.js";
import { fromUnits } from "./lib/units.js";

// S3 on mainnet ($1): what the Intents contract does when it notifies a receiver, and the direct mt_transfer_call path (C20).
//   notify   nep413 Transfer 0.5 USDC -> spike, msg "probe"       spike keeps it, sender is the signer
//   late     nep413 Transfer 0.5 USDC -> spike, msg "late"        spike refuses, nothing moves
//   payback  spike.payback(0.5 USDC) -> signer                    spike pays back with mt_batch_transfer
//   direct   intents.mt_transfer_call 0.1 USDC -> spike           sender is the caller

const usage = `usage:
  tsx scripts/s3b.ts [--signer tenderseal.near] [--spike spike.tenderseal.near] [--intents intents.near] [--usdc nep141:<id>] [--yes]
  Dry-run unless --yes. --yes also sends the prerequisite steps the dry-run lists (ft_transfer_call, add_public_key).`;

export const SCENARIOS = ["notify", "late", "payback", "direct"] as const;
export type Scenario = (typeof SCENARIOS)[number];

export const AMOUNT: Record<Scenario, bigint> = { notify: 500_000n, late: 500_000n, payback: 500_000n, direct: 100_000n };
const MIN_TEAM_INTENTS = 1_100_000n; // 0.5 notify + 0.5 late (peak) + 0.1 direct
const MIN_SPIKE_NEAR = 10n ** 22n; // 0.01 NEAR; payback pays 1 yocto from the spike's own balance
const GAS_NOTE_NEAR = 31n * 10n ** 22n; // a 300 Tgas call needs about 0.31 NEAR in the account (testnet finding)
const MEMO: Record<Scenario, string> = { notify: "probe", late: "late", payback: "payback", direct: "probe-direct" };

export interface Snap { team: bigint; spike: bigint }

export interface Verdict { pass: boolean; reason: string }

/** Pure: did this scenario do what was planned? Balances are the signer's and the spike's Intents USDC. */
export function evaluate(name: Scenario, o: { before: Snap; after: Snap; logs: string[]; txOk: boolean; signer: string }): Verdict {
  const dSpike = o.after.spike - o.before.spike;
  const dTeam = o.after.team - o.before.team;
  const a = AMOUNT[name];
  const has = (re: RegExp) => o.logs.some((l) => re.test(l));
  const senderIs = new RegExp(`spike:mt_on_transfer .*\\bsender=${o.signer.replace(/\./g, "\\.")}\\b.*\\bmsg=${MEMO[name]}$`);
  if (!o.txOk) return { pass: false, reason: "transaction failed" };
  switch (name) {
    case "notify":
    case "direct":
      if (dSpike !== a) return { pass: false, reason: `spike changed by ${dSpike}, expected +${a}` };
      if (dTeam !== -a) return { pass: false, reason: `signer changed by ${dTeam}, expected -${a}` };
      return has(senderIs) ? { pass: true, reason: "spike +" + a + ", mt_on_transfer saw sender " + o.signer } : { pass: false, reason: `no spike:mt_on_transfer log with sender=${o.signer} msg=${MEMO[name]}` };
    case "late":
      if (dSpike !== 0n || dTeam !== 0n) return { pass: false, reason: `balances changed (spike ${dSpike}, signer ${dTeam}), expected a full refund` };
      return has(/spike:mt_on_transfer .*\bmsg=late$/) ? { pass: true, reason: "notified with msg=late, refunded in full" } : { pass: false, reason: "no spike:mt_on_transfer log with msg=late (the notification may not have fired)" };
    case "payback":
      if (dSpike !== -a) return { pass: false, reason: `spike changed by ${dSpike}, expected -${a}` };
      if (dTeam !== a) return { pass: false, reason: `signer changed by ${dTeam}, expected +${a}` };
      return has(/spike:payback ok/) ? { pass: true, reason: "spike -" + a + ", signer +" + a } : { pass: false, reason: "no spike:payback ok log" };
  }
}

export interface S3bState {
  pingOk: boolean;
  spikeNear: bigint | null; // null = account missing
  signerNear: bigint | null;
  usdcRegistered: boolean; // storage_balance_of(signer) on the USDC contract
  usdcFt: bigint; // signer's NEP-141 balance
  teamIntents: bigint; // signer's Intents USDC
  publicKey: string | null; // of the local key, null when there is none
  registeredKeys: string[];
}

export interface S3bTarget { signer: string; spike: string; intents: string; usdc: string; network: Common["network"] }

export interface Prereq { step: CallStep; kind: Step; note: string }

/** Pure. Everything that stops a real send goes into `problems`; a dry-run still prints the plan. */
export function planS3b(t: S3bTarget, st: S3bState): { prereqs: Prereq[]; problems: string[]; notes: string[] } {
  const prereqs: Prereq[] = [];
  const problems: string[] = [];
  const notes: string[] = [];
  const ftContract = t.usdc.replace(/^nep141:/, "");

  if (!st.pingOk) problems.push(`${t.spike} did not answer ping() with "ok": H-S6 (spike deploy) is not done`);
  else if (st.spikeNear !== null && st.spikeNear < MIN_SPIKE_NEAR) problems.push(`${t.spike} holds ${fromUnits(st.spikeNear, 24)} NEAR, payback needs about 0.01`);

  if (st.signerNear === null) problems.push(`${t.signer} does not exist on ${t.network} yet (G-ACCT)`);
  else if (st.signerNear < GAS_NOTE_NEAR) notes.push(`${t.signer} holds ${fromUnits(st.signerNear, 24)} NEAR; a 300 Tgas call may need about 0.31 NEAR in the account`);

  const deficit = MIN_TEAM_INTENTS > st.teamIntents ? MIN_TEAM_INTENTS - st.teamIntents : 0n;
  notes.push(`${t.signer} Intents USDC: ${fromUnits(st.teamIntents, 6)} (needs ${fromUnits(MIN_TEAM_INTENTS, 6)})`);
  if (deficit > 0n) {
    if (!st.usdcRegistered) problems.push(`${t.signer} is not storage-registered on ${ftContract} (H-02), so it cannot hold the USDC to deposit`);
    else if (st.usdcFt < deficit) problems.push(`${t.signer} holds ${fromUnits(st.usdcFt, 6)} NEP-141 USDC, the deposit needs ${fromUnits(deficit, 6)} (F4)`);
    prereqs.push({
      step: { signer: t.signer, receiver: ftContract, method: "ft_transfer_call", args: { receiver_id: t.intents, amount: deficit.toString(), msg: "" }, deposit: "1 yoctoNEAR", gasTgas: 100, network: t.network },
      kind: "deposit",
      note: "s3b prerequisite: USDC into Intents",
    });
  }

  if (st.publicKey === null) notes.push(`no local key for ${t.signer}: the key registration check, signing and simulate_intents are skipped`);
  else if (!st.registeredKeys.includes(st.publicKey)) {
    prereqs.push({
      step: { signer: t.signer, receiver: t.intents, method: "add_public_key", args: { public_key: st.publicKey }, deposit: "1 yoctoNEAR", gasTgas: 30, network: t.network },
      kind: "add-public-key",
      note: "s3b prerequisite: nep413 key registration (D4-04)",
    });
  }
  return { prereqs, problems, notes };
}

/** The two scenarios that are plain function calls, as dry-run steps. */
export function directSteps(t: S3bTarget): { payback: CallStep; direct: CallStep } {
  return {
    payback: {
      signer: t.signer, receiver: t.spike, method: "payback",
      args: { receiver_id: t.signer, token_id: t.usdc, amount: AMOUNT.payback.toString() }, deposit: "0 NEAR", gasTgas: 100, network: t.network,
    },
    direct: {
      signer: t.signer, receiver: t.intents, method: "mt_transfer_call",
      args: { receiver_id: t.spike, token_id: t.usdc, amount: AMOUNT.direct.toString(), msg: MEMO.direct }, deposit: "1 yoctoNEAR", gasTgas: 100, network: t.network,
    },
  };
}

export interface StepResult { name: Scenario; tx: string; before: Snap; after: Snap; logs: string[]; pass: boolean; reason: string }

const snapStr = (s: Snap) => ({ team: s.team.toString(), spike: s.spike.toString() });

export function evidenceFile(o: { network: string; signer: string; spike: string; steps: StepResult[]; nowIso?: string }) {
  return {
    date_utc: o.nowIso ?? new Date().toISOString(),
    network: o.network,
    signer: o.signer,
    spike: o.spike,
    steps: o.steps.map((s) => ({ name: s.name, tx: s.tx, before: snapStr(s.before), after: snapStr(s.after), logs: s.logs, pass: s.pass, reason: s.reason })),
  };
}

/** `S3b: notify PASS · late PASS · payback PASS · direct PASS` */
export function summaryLine(steps: StepResult[]): string {
  return "S3b: " + SCENARIOS.map((n) => `${n} ${steps.find((s) => s.name === n)?.pass ? "PASS" : "FAIL"}`).join(" · ");
}

/** What the gate row should say, from the four verdicts. Printed for the agent; the script does not write the gate. */
export function gateSuggestion(steps: StepResult[]): { result: "PASS" | "ALT" | "FAIL"; path: string } {
  const ok = (n: Scenario) => steps.find((s) => s.name === n)?.pass === true;
  if (SCENARIOS.every(ok)) return { result: "PASS", path: "transfer-intent-notification" };
  if (ok("direct")) return { result: "ALT", path: "mt_transfer_call-direct" };
  return { result: "FAIL", path: "none" };
}

export interface S3bEnv extends TransferEnv {
  ping(spike: string): Promise<boolean>;
  nativeBalance(account: string): Promise<bigint | null>;
  usdcState(ftContract: string, account: string): Promise<{ registered: boolean; ft: bigint }>;
  writeEvidence(file: string, data: unknown): void;
}

export function liveS3bEnv(c: Common): S3bEnv {
  return {
    ...liveTransferEnv(c),
    async ping(spike) {
      try {
        return (await view<string>(c.network, spike, "ping", {})) === "ok";
      } catch {
        return false;
      }
    },
    nativeBalance: (a) => nearNative(c.network, a, { rpc: c.rpc }),
    async usdcState(ftContract, account) {
      const registered = (await view<unknown>(c.network, ftContract, "storage_balance_of", { account_id: account })) !== null;
      return { registered, ft: registered ? await ftBalance(c.network, ftContract, account) : 0n };
    },
    writeEvidence(file, data) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
    },
  };
}

export interface S3bDeps {
  env?: (c: Common) => S3bEnv;
  out?: (l: string) => void;
  err?: (l: string) => void;
  evidenceDir?: string;
}

const STEP_OF: Record<Scenario, Step> = { notify: "deposit", late: "deposit", payback: "withdraw", direct: "deposit" };

export async function main(argv: string[], deps: S3bDeps = {}): Promise<number> {
  const out = deps.out ?? ((l) => console.log(l));
  const err = deps.err ?? ((l) => console.error(l));
  let parsed;
  try {
    parsed = parseCommon(argv, { signer: { type: "string" }, spike: { type: "string" }, intents: { type: "string" }, usdc: { type: "string" } });
  } catch (e) {
    err(`error: ${(e as Error).message}\n${usage}`);
    return 2;
  }
  const { common, values } = parsed;
  const str = (k: string) => values[k] as string | undefined;
  const network = common.network;
  const t: S3bTarget = {
    signer: (str("signer") ?? process.env.TENDER_TEAM_ACCOUNT_ID ?? "tenderseal.near").toLowerCase(),
    spike: (str("spike") ?? process.env.TENDER_SPIKE_ACCOUNT_ID ?? "spike.tenderseal.near").toLowerCase(),
    intents: str("intents") ?? process.env.INTENTS_CONTRACT_ID ?? "intents.near",
    usdc: str("usdc") ?? TOKEN.usdcNear,
    network,
  };
  const env = (deps.env ?? liveS3bEnv)(common);
  const ftContract = t.usdc.replace(/^nep141:/, "");

  try {
    if (network === "testnet" && (!str("intents") || !str("usdc"))) throw new Error("--intents and --usdc are required on testnet (the M3 copies)");
    const spikeNear = await env.nativeBalance(t.spike);
    const signerNear = await env.nativeBalance(t.signer);
    const pingOk = await env.ping(t.spike);
    const usdcState = await env.usdcState(ftContract, t.signer);
    const teamIntents = await env.balance(t.intents, t.signer, t.usdc);
    const secret = env.secretKey(t.signer);
    const publicKey = secret ? KeyPair.fromString(secret).getPublicKey().toString() : null;
    const registeredKeys = publicKey && signerNear !== null ? await env.intentsKeys(t.intents, t.signer) : [];
    const plan = planS3b(t, { pingOk, spikeNear, signerNear, usdcRegistered: usdcState.registered, usdcFt: usdcState.ft, teamIntents, publicKey, registeredKeys });
    if (!secret && !common.dryRun) plan.problems.push(`no key for ${t.signer} on ${network} (looked in the near-credentials directory)`);

    for (const n of plan.notes) out(n);
    out(DRY_RUN_HEADER);
    const total = plan.prereqs.length + SCENARIOS.length;
    let i = 0;
    for (const p of plan.prereqs) out(formatDryRunStep(++i, total, p.step));
    const calls = directSteps(t);
    const transferLine = (name: "notify" | "late") =>
      `${AMOUNT[name]} of ${t.usdc} to ${t.spike} msg="${MEMO[name]}" min_gas=30 Tgas, nep413-signed by ${t.signer}, sent with execute_intents`;
    for (const name of SCENARIOS) {
      if (name === "notify" || name === "late") {
        out(`[${++i}/${total}] signer=${t.signer} receiver=${t.intents} method=execute_intents deposit=0 NEAR gas=300 Tgas`);
        out(`      scenario=${name} transfer=${transferLine(name)}`);
        if (secret && plan.problems.length === 0 && plan.prereqs.length === 0) {
          const { mp } = await signTransfer(env, { signer: t.signer, intents: t.intents, receiver: t.spike, tokenId: t.usdc, amount: AMOUNT[name], msg: MEMO[name] });
          const sim = await env.simulate(t.intents, mp);
          out(`      simulate_intents: ${sim.ok ? "ok" : `${sim.kind}: ${sim.message}`}`);
          if (!sim.ok) plan.problems.push(`simulate_intents failed for ${name} (${sim.kind})`);
        } else out("      simulate_intents: skipped (prerequisites open, problems open or no local key)");
      } else {
        const [first, ...rest] = formatDryRunStep(++i, total, calls[name]).split("\n");
        out([first, `      scenario=${name}`, ...rest].join("\n"));
      }
    }
    for (const p of plan.problems) out(`BLOCKED: ${p}`);
    if (common.dryRun) return plan.problems.length ? 1 : 0;
    if (plan.problems.length) return 2;

    // ---- real run ----
    const record = async (step: Step, tx: string, note: string) => {
      if (network !== "mainnet" || common.noRecord) return;
      try {
        await env.record({ sale: "spike", step, txHash: tx, signer: t.signer, note });
      } catch (e) {
        err(`WARN recording failed (run scripts/record.ts by hand within 2 h, D4-01): ${(e as Error).message}`);
      }
    };
    const show = (r: Sent) => out(`tx=${r.hash} status=${r.ok ? "SuccessValue" : "Failure"} block=${r.block} url=${explorer(network, r.hash)}`);
    for (const p of plan.prereqs) {
      const r = await env.call(p.step);
      show(r);
      await record(p.kind, r.hash, p.note);
      if (!r.ok) {
        err(`FAIL prerequisite ${p.step.method}: ${JSON.stringify(r.status).slice(0, 400)}`);
        return 1;
      }
    }
    if (plan.prereqs.length) {
      const have = await env.balance(t.intents, t.signer, t.usdc);
      if (have < MIN_TEAM_INTENTS) throw new Error(`after the prerequisites ${t.signer} holds ${have} in Intents, the scenarios need ${MIN_TEAM_INTENTS}`);
    }

    const snap = async (): Promise<Snap> => ({ team: await env.balance(t.intents, t.signer, t.usdc), spike: await env.balance(t.intents, t.spike, t.usdc) });
    const steps: StepResult[] = [];
    for (const name of SCENARIOS) {
      const before = await snap();
      let r: Sent;
      if (name === "payback" && before.spike < AMOUNT.payback) {
        steps.push({ name, tx: "", before, after: before, logs: [], pass: false, reason: `skipped: spike holds ${before.spike}, payback needs ${AMOUNT.payback}` });
        out(`payback skipped: the spike holds ${before.spike} of the token`);
        continue;
      }
      if (name === "notify" || name === "late") {
        const { mp } = await signTransfer(env, { signer: t.signer, intents: t.intents, receiver: t.spike, tokenId: t.usdc, amount: AMOUNT[name], msg: MEMO[name] });
        const sim = await env.simulate(t.intents, mp);
        if (!sim.ok) {
          steps.push({ name, tx: "", before, after: before, logs: [], pass: false, reason: `simulate_intents failed (${sim.kind}): ${sim.message}` });
          err(`${name}: simulate_intents failed (${sim.kind}): ${sim.message}`);
          continue;
        }
        r = await env.executeIntents(t.signer, t.intents, mp);
      } else r = await env.call(calls[name]);
      show(r);
      await record(STEP_OF[name], r.hash, `s3b ${name}`);
      const after = await snap();
      const v = evaluate(name, { before, after, logs: r.logs, txOk: r.ok, signer: t.signer });
      steps.push({ name, tx: r.hash, before, after, logs: r.logs.filter((l) => /^spike:/.test(l)), pass: v.pass, reason: v.reason });
      out(`${name}: ${v.pass ? "PASS" : "FAIL"} · ${v.reason}`);
    }

    const dir = deps.evidenceDir ?? EVIDENCE_DIR;
    env.writeEvidence(join(dir, "spikes", "s3b.json"), evidenceFile({ network, signer: t.signer, spike: t.spike, steps }));
    out(summaryLine(steps));
    const g = gateSuggestion(steps);
    out(`gate: record.ts gate --gate S3 --result ${g.result} --path "${g.path}" --tx ${steps.map((s) => s.tx).filter(Boolean).join(",")} --signer ${t.signer} --files evidence/spikes/s3b.json --notes "S3a sandbox PASS + S3b mainnet"`);
    const held = steps.at(-1)?.after.spike ?? 0n;
    if (held > 0n) out(`NOTE the spike still holds ${fromUnits(held, 6)} USDC in Intents: get it back with payback before the spike account is deleted (H-spike-delete)`);
    return SCENARIOS.every((n) => steps.find((s) => s.name === n)?.pass) ? 0 : 1;
  } catch (e) {
    err(`error: ${(e as Error).message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
