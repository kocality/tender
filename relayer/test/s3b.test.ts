import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AMOUNT, SCENARIOS, directSteps, evaluate, gateSuggestion, main, planS3b, summaryLine,
  type S3bEnv, type S3bState, type S3bTarget, type StepResult,
} from "../scripts/s3b.js";
import { TOKEN } from "../scripts/lib/oneclick.js";
import { addBal, fakeBase, firstIntent, sent, setBal, type FakeBase } from "./helpers/transfer-env.js";

const USDC = TOKEN.usdcNear;
const SIGNER = "tenderseal.near";
const SPIKE = "spike.tenderseal.near";
const T: S3bTarget = { signer: SIGNER, spike: SPIKE, intents: "intents.near", usdc: USDC, network: "mainnet" };

const notifyLog = (msg: string, sender = SIGNER) =>
  `spike:mt_on_transfer predecessor=intents.near sender=${sender} prev=${sender} tokens=${USDC} amounts=500000 msg=${msg}`;

describe("evaluate: the expected balance differences of the four scenarios", () => {
  const snap = (team: bigint, spike: bigint) => ({ team, spike });
  const base = { signer: SIGNER, txOk: true };

  it("notify: spike +0.5 USDC, signer -0.5, mt_on_transfer saw the signer", () => {
    const v = evaluate("notify", { ...base, before: snap(1_100_000n, 0n), after: snap(600_000n, 500_000n), logs: [notifyLog("probe")] });
    expect(v.pass).toBe(true);
  });
  it("notify fails without the notification log, with the wrong sender, or with wrong amounts", () => {
    const b = { ...base, before: snap(1_100_000n, 0n), after: snap(600_000n, 500_000n) };
    expect(evaluate("notify", { ...b, logs: [] }).pass).toBe(false);
    expect(evaluate("notify", { ...b, logs: [notifyLog("probe", "someone.near")] }).pass).toBe(false);
    expect(evaluate("notify", { ...b, logs: [notifyLog("probe")], after: snap(1_100_000n, 0n) }).pass).toBe(false);
    expect(evaluate("notify", { ...b, logs: [notifyLog("probe")], txOk: false }).pass).toBe(false);
  });
  it("late: nothing moves, and the spike was notified with msg=late", () => {
    const same = { before: snap(600_000n, 500_000n), after: snap(600_000n, 500_000n) };
    expect(evaluate("late", { ...base, ...same, logs: [notifyLog("late")] }).pass).toBe(true);
    // a transfer that never reached the spike also leaves balances unchanged: that is not a pass
    expect(evaluate("late", { ...base, ...same, logs: [] }).pass).toBe(false);
    expect(evaluate("late", { ...base, before: snap(600_000n, 500_000n), after: snap(100_000n, 1_000_000n), logs: [notifyLog("late")] }).pass).toBe(false);
  });
  it("payback: spike -0.5, signer +0.5, log spike:payback ok", () => {
    const b = { ...base, before: snap(100_000n, 500_000n), after: snap(600_000n, 0n) };
    expect(evaluate("payback", { ...b, logs: ["spike:payback ok"] }).pass).toBe(true);
    expect(evaluate("payback", { ...b, logs: ["spike:payback err"] }).pass).toBe(false);
    expect(evaluate("payback", { ...b, logs: ["spike:payback ok"], after: snap(100_000n, 500_000n) }).pass).toBe(false);
  });
  it("direct (C20): spike +0.1, signer -0.1, sender is the caller and msg is probe-direct", () => {
    const log = `spike:mt_on_transfer predecessor=intents.near sender=${SIGNER} prev=${SIGNER} tokens=${USDC} amounts=100000 msg=probe-direct`;
    const b = { ...base, before: snap(600_000n, 0n), after: snap(500_000n, 100_000n) };
    expect(evaluate("direct", { ...b, logs: [log] }).pass).toBe(true);
    expect(evaluate("direct", { ...b, logs: [notifyLog("probe")] }).pass).toBe(false);
  });
  it("amounts are 0.5, 0.5, 0.5 and 0.1 USDC", () => {
    expect(AMOUNT).toEqual({ notify: 500_000n, late: 500_000n, payback: 500_000n, direct: 100_000n });
  });
});

describe("planS3b", () => {
  const ready: S3bState = { pingOk: true, spikeNear: 2n * 10n ** 24n, signerNear: 3n * 10n ** 24n, usdcRegistered: true, usdcFt: 5_000_000n, teamIntents: 1_100_000n, publicKey: "ed25519:PK", registeredKeys: ["ed25519:PK"] };

  it("nothing to do when funded and registered", () => {
    const p = planS3b(T, ready);
    expect(p.prereqs).toEqual([]);
    expect(p.problems).toEqual([]);
  });
  it("lists the ft_transfer_call and add_public_key lines", () => {
    const p = planS3b(T, { ...ready, teamIntents: 0n, registeredKeys: [] });
    expect(p.prereqs.map((x) => x.step.method)).toEqual(["ft_transfer_call", "add_public_key"]);
    expect(p.prereqs[0]?.step).toMatchObject({ receiver: USDC.replace("nep141:", ""), args: { receiver_id: "intents.near", amount: "1100000", msg: "" }, deposit: "1 yoctoNEAR", gasTgas: 100 });
    expect(p.prereqs[1]?.step).toMatchObject({ receiver: "intents.near", args: { public_key: "ed25519:PK" }, deposit: "1 yoctoNEAR", gasTgas: 30 });
    expect(p.problems).toEqual([]);
  });
  it("deposits only the shortfall", () => {
    const p = planS3b(T, { ...ready, teamIntents: 400_000n });
    expect(p.prereqs[0]?.step.args).toMatchObject({ amount: "700000" });
  });
  it("blocks on every missing precondition", () => {
    const p = planS3b(T, { ...ready, pingOk: false, signerNear: null, teamIntents: 0n, usdcRegistered: false });
    expect(p.problems.join("\n")).toMatch(/H-S6/);
    expect(p.problems.join("\n")).toMatch(/G-ACCT/);
    expect(p.problems.join("\n")).toMatch(/storage-registered/);
    expect(planS3b(T, { ...ready, teamIntents: 0n, usdcFt: 100n }).problems.join("\n")).toMatch(/needs 1\.1/);
    expect(planS3b(T, { ...ready, spikeNear: 1n }).problems.join("\n")).toMatch(/payback needs/);
  });
  it("without a local key it only notes", () => {
    const p = planS3b(T, { ...ready, publicKey: null });
    expect(p.problems).toEqual([]);
    expect(p.notes.join("\n")).toMatch(/no local key/);
  });
  it("payback and direct steps", () => {
    const s = directSteps(T);
    expect(s.payback).toMatchObject({ signer: SIGNER, receiver: SPIKE, method: "payback", args: { receiver_id: SIGNER, token_id: USDC, amount: "500000" }, gasTgas: 100 });
    expect(s.direct).toMatchObject({ receiver: "intents.near", method: "mt_transfer_call", args: { receiver_id: SPIKE, token_id: USDC, amount: "100000", msg: "probe-direct" }, deposit: "1 yoctoNEAR", gasTgas: 100 });
  });
});

/** A fake chain: Intents balances in the base map, the spike answers like the real one. */
function world(o: { intentsUsdc?: bigint; ft?: bigint; registered?: boolean; ping?: boolean; noNotifyLog?: boolean; spikeKeepsLate?: boolean } = {}) {
  const b: FakeBase = fakeBase({ registered: o.registered });
  setBal(b, SIGNER, USDC, o.intentsUsdc ?? 0n);
  let ft = o.ft ?? 5_000_000n;
  const move = (from: string, to: string, n: bigint) => {
    addBal(b, from, USDC, -n);
    addBal(b, to, USDC, n);
  };
  const logFor = (sender: string, amount: bigint, msg: string) =>
    `spike:mt_on_transfer predecessor=intents.near sender=${sender} prev=${sender} tokens=${USDC} amounts=${amount} msg=${msg}`;
  let n = 0;
  b.hooks.execute = (signer, mp) => {
    const it = firstIntent(mp);
    const amount = BigInt(it.tokens[USDC]);
    const logs: string[] = [];
    if (it.receiver_id === SPIKE && it.msg !== undefined) {
      if (!o.noNotifyLog) logs.push(logFor(signer, amount, it.msg));
      if (it.msg !== "late" || o.spikeKeepsLate) move(signer, SPIKE, amount);
    }
    return sent(`EXEC${++n}`, true, logs);
  };
  b.hooks.call = (step) => {
    const a = step.args as Record<string, string>;
    if (step.method === "ft_transfer_call") {
      ft -= BigInt(a.amount as string);
      addBal(b, SIGNER, USDC, BigInt(a.amount as string));
    } else if (step.method === "add_public_key") b.keys.v.push(a.public_key as string);
    else if (step.method === "payback") {
      move(SPIKE, SIGNER, BigInt(a.amount as string));
      return sent(`CALL${++n}`, true, ["spike:payback ok"]);
    } else if (step.method === "mt_transfer_call") {
      move(SIGNER, SPIKE, BigInt(a.amount as string));
      return sent(`CALL${++n}`, true, [logFor(SIGNER, BigInt(a.amount as string), a.msg as string)]);
    }
    return sent(`CALL${++n}`);
  };
  const written: { file: string; data: any }[] = [];
  const env: S3bEnv = {
    ...b.env,
    ping: async () => o.ping !== false,
    nativeBalance: async () => 3n * 10n ** 24n,
    usdcState: async () => ({ registered: true, ft }),
    writeEvidence: (file, data) => void written.push({ file, data }),
  };
  return { b, env, written };
}

async function run(args: string[], w: ReturnType<typeof world>) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(args, { env: () => w.env, out: (l) => out.push(l), err: (l) => err.push(l), evidenceDir: mkdtempSync(join(tmpdir(), "s3b-")) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("s3b dry-run", () => {
  it("prints the prerequisite lines and the four scenarios, and sends nothing", async () => {
    const w = world({ registered: false });
    const r = await run([], w);
    expect(r.code).toBe(0);
    expect(r.out).toContain("DRY-RUN · nothing sent · re-run with --yes to send");
    expect(r.out).toMatch(/\[1\/6\] signer=tenderseal\.near receiver=\S+ method=ft_transfer_call/);
    expect(r.out).toMatch(/\[2\/6\] signer=tenderseal\.near receiver=intents\.near method=add_public_key deposit=1 yoctoNEAR gas=30 Tgas/);
    for (const s of SCENARIOS) expect(r.out).toContain(`scenario=${s}`);
    expect(w.b.log).toEqual([]);
    expect(w.written).toEqual([]);
  });
  it("simulates the two transfers when everything is ready", async () => {
    const w = world({ intentsUsdc: 1_100_000n });
    const r = await run([], w);
    expect(r.code).toBe(0);
    expect(r.out.match(/simulate_intents: ok/g)).toHaveLength(2);
    expect(w.b.simulated).toHaveLength(2);
    expect(firstIntent(w.b.simulated[0]!)).toMatchObject({ intent: "transfer", receiver_id: SPIKE, msg: "probe", min_gas: "30000000000000", tokens: { [USDC]: "500000" } });
    expect(firstIntent(w.b.simulated[1]!)).toMatchObject({ msg: "late" });
    expect(w.b.log).toEqual([]);
  });
  it("exits 1 with BLOCKED when the spike is not deployed", async () => {
    const r = await run([], world({ ping: false }));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/BLOCKED: .*H-S6/);
  });
});

describe("s3b --yes", () => {
  it("sends the prerequisites in order, runs four scenarios, writes the evidence and records every tx", async () => {
    const w = world({ registered: false });
    const r = await run(["--yes"], w);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(w.b.log).toEqual(["call ft_transfer_call", "call add_public_key", "executeIntents", "executeIntents", "call payback", "call mt_transfer_call"]);
    expect(r.out.trimEnd().split("\n").find((l) => l.startsWith("S3b:"))).toBe("S3b: notify PASS · late PASS · payback PASS · direct PASS");
    expect(w.written).toHaveLength(1);
    expect(w.written[0]?.file.endsWith("spikes/s3b.json")).toBe(true);
    const d = w.written[0]!.data;
    expect(d.steps.map((s: any) => [s.name, s.pass])).toEqual([["notify", true], ["late", true], ["payback", true], ["direct", true]]);
    expect(d.steps[0]).toMatchObject({ tx: "EXEC3", before: { team: "1100000", spike: "0" }, after: { team: "600000", spike: "500000" } });
    expect(d.steps[3].after).toEqual({ team: "1000000", spike: "100000" });
    // the base-name steps of the existing evidence schema, scenario in the note
    expect(w.b.recorded.map((x) => [x.sale, x.step, x.note])).toEqual([
      ["spike", "deposit", "s3b prerequisite: USDC into Intents"],
      ["spike", "add-public-key", "s3b prerequisite: nep413 key registration (D4-04)"],
      ["spike", "deposit", "s3b notify"],
      ["spike", "deposit", "s3b late"],
      ["spike", "withdraw", "s3b payback"],
      ["spike", "deposit", "s3b direct"],
    ]);
    expect(r.out).toContain('record.ts gate --gate S3 --result PASS --path "transfer-intent-notification"');
    expect(r.out).toMatch(/spike still holds 0\.1 USDC/);
  });

  it("a notification that never reaches the spike fails notify and suggests ALT through the direct path", async () => {
    const w = world({ intentsUsdc: 1_100_000n, noNotifyLog: true });
    const r = await run(["--yes"], w);
    expect(r.code).toBe(1);
    const line = r.out.split("\n").find((l) => l.startsWith("S3b:"))!;
    expect(line).toContain("notify FAIL");
    expect(r.out).toContain('--result ALT --path "mt_transfer_call-direct"');
  });

  it("refuses to run with problems and sends nothing", async () => {
    const w = world({ ping: false });
    const r = await run(["--yes"], w);
    expect(r.code).toBe(2);
    expect(w.b.log).toEqual([]);
  });

  it("does not record on testnet and demands the M3 copies", async () => {
    const w = world();
    const r = await run(["--network", "testnet"], w);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/--intents and --usdc are required on testnet/);
  });
});

describe("summary and gate suggestion", () => {
  const step = (name: StepResult["name"], pass: boolean): StepResult => ({ name, tx: `T-${name}`, before: { team: 0n, spike: 0n }, after: { team: 0n, spike: 0n }, logs: [], pass, reason: "" });
  it("PASS, ALT and FAIL", () => {
    const all = SCENARIOS.map((n) => step(n, true));
    expect(summaryLine(all)).toBe("S3b: notify PASS · late PASS · payback PASS · direct PASS");
    expect(gateSuggestion(all).result).toBe("PASS");
    expect(gateSuggestion(all.map((s) => (s.name === "notify" ? { ...s, pass: false } : s)))).toEqual({ result: "ALT", path: "mt_transfer_call-direct" });
    expect(gateSuggestion(all.map((s) => ({ ...s, pass: false }))).result).toBe("FAIL");
  });
});
