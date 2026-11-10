import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { KeyPair } from "near-api-js";
import { MAX_BATCH, decide, describeAction, isoSec, keeperKeyProblem, main, runKeeper, summaryMarkdown, toCall, type KeeperCrypto, type KeeperDeps, type KeeperOpts } from "../src/keeper.js";
import type { BidView, SaleView } from "../scripts/lib/views.js";
import { bidView, configView, saleView } from "./helpers/views.js";

const CLOSE_NS = 1_794_916_800_000_000_000n; // 2026-11-17T12:00:00Z
const DAY_NS = 86_400_000_000_000n;
const CTX = { contractId: "v1.tenderseal.near", mpkG2: "bls12381g2:x", mode: "identity" };
const KEY = { big_y: "y", big_c: "c", block: "9", ns: "9" };

/** Bid i has ct "ct<i>"; `plain[i]` is what it decrypts to: absent = invalid ciphertext, cmOk false = copied commitment. */
function crypto(plain: Record<number, { p: bigint; q: bigint; cmOk?: boolean }>, keyOk = true): KeeperCrypto {
  return {
    keyFromCkd: () => ({}) as never,
    checkKey: () => keyOk,
    appId: () => new Uint8Array(32),
    decryptBids: ({ bids }) =>
      bids.map((b) => {
        const d = plain[b.idx];
        return d ? { idx: b.idx, ok: true, p: d.p, q: d.q, salt_hex: "ab".repeat(16), cmOk: d.cmOk ?? true } : { idx: b.idx, ok: false, reason: "bad ct" };
      }),
  };
}
const noCrypto = crypto({});

const open = (over: Partial<SaleView> = {}) => saleView({ close_ns: CLOSE_NS.toString(), bids: 3, bidders: 3, escrow_total: "9000000", ...over });
const keyed = (over: Partial<SaleView> = {}) =>
  saleView({ state: "Keyed", key: KEY, key_requests: 1, bids: 3, bidders: 3, escrow_total: "9000000", reveal_deadline_ns: (CLOSE_NS + 2n * DAY_NS).toString(), payouts_total: 4, ...over });
const sealed = (n: number): BidView[] => Array.from({ length: n }, (_, i) => bidView({ idx: i, bidder: `b${i}.near`, ct: `ct${i}`, cm: String(i).padStart(64, "0") }));
const plain3 = { 0: { p: 3_000_000n, q: 1_000_000n }, 1: { p: 4_000_000n, q: 2_000_000n }, 2: { p: 5_000_000n, q: 3_000_000n } };

describe("decide: Open", () => {
  it("before close it waits with the dry-run text", () => {
    const a = decide(open(), [], CLOSE_NS - 1n, noCrypto, CTX);
    expect(a).toEqual([{ kind: "wait", reason: "would call open(2) after 2026-11-17T12:00:00Z", until: "2026-11-17T12:00:00Z" }]);
    expect(isoSec(CLOSE_NS)).toBe("2026-11-17T12:00:00Z");
  });
  it("conditions hold at close: open", () => expect(decide(open(), [], CLOSE_NS, noCrypto, CTX)).toEqual([{ kind: "open" }]));
  it("conditions fail and no key was ever requested: cancel a", () => {
    expect(decide(open({ escrow_total: "4999999" }), [], CLOSE_NS, noCrypto, CTX)).toEqual([{ kind: "cancel", rule: "a" }]);
    expect(decide(open({ bidders: 2 }), [], CLOSE_NS, noCrypto, CTX)).toEqual([{ kind: "cancel", rule: "a" }]);
  });
  it("close + 24 h: conditions that hold still open (an open can key the sale at any time), key_requests 0 or more", () => {
    expect(decide(open(), [], CLOSE_NS + DAY_NS, noCrypto, CTX)).toEqual([{ kind: "open" }]);
    expect(decide(open({ key_requests: 1 }), [], CLOSE_NS + DAY_NS + 1n, noCrypto, CTX)).toEqual([{ kind: "open" }]);
    expect(decide(open({ key_requests: 2 }), [], CLOSE_NS + 5n * DAY_NS, noCrypto, CTX)).toEqual([{ kind: "open" }]);
    expect(decide(open(), [], CLOSE_NS + DAY_NS - 1n, noCrypto, CTX)).toEqual([{ kind: "open" }]);
  });
  it("close + 24 h with failed conditions and no key: cancel b (earlier before: stop)", () => {
    const failed = { key_requests: 2, escrow_total: "1000000" };
    expect(decide(open(failed), [], CLOSE_NS + DAY_NS, noCrypto, CTX)).toEqual([{ kind: "cancel", rule: "b" }]);
    expect(decide(open(failed), [], CLOSE_NS + DAY_NS - 1n, noCrypto, CTX)[0]).toMatchObject({ kind: "stop" });
  });
  it("a request in flight waits, even after close + 24 h", () => {
    expect(decide(open({ in_flight: true, key_requests: 1 }), [], CLOSE_NS + 2n * DAY_NS, noCrypto, CTX)[0]).toMatchObject({ kind: "wait" });
    expect(decide(open({ state: "Opening", in_flight: true }), [], CLOSE_NS, noCrypto, CTX)[0]).toMatchObject({ kind: "wait" });
  });
});

describe("decide: Keyed", () => {
  const now = CLOSE_NS + 1000n;
  it("a key that fails checkKey stops while the window is open, reveals nothing", () => {
    const a = decide(keyed(), sealed(3), now, crypto(plain3, false), CTX);
    expect(a).toEqual([{ kind: "stop", reason: expect.stringContaining("FAIL checkKey") }]);
  });
  it("a key that fails checkKey after the window finalizes (full refunds)", () => {
    expect(decide(keyed(), sealed(3), CLOSE_NS + 3n * DAY_NS, crypto(plain3, false), CTX)).toEqual([{ kind: "finalize", max: 8 }]);
  });
  it("an unknown app_pk_mode stops", () => {
    expect(decide(keyed(), sealed(3), now, crypto(plain3), { ...CTX, mode: "weird" })[0]).toMatchObject({ kind: "stop" });
  });
  it("12 sealed bids, one with a broken ct and one copy: two batches of valid items only (8 + 2)", () => {
    const bids = sealed(12);
    const plain: Record<number, { p: bigint; q: bigint; cmOk?: boolean }> = {};
    for (let i = 0; i < 12; i++) plain[i] = { p: 3_000_000n + BigInt(i), q: 1_000_000n };
    delete plain[3]; // broken ciphertext
    plain[7] = { ...plain[7]!, cmOk: false }; // copy under another bidder
    const a = decide(keyed({ bids: 12, bidders: 12 }), bids, now, crypto(plain), CTX);
    expect(a.map((x) => x.kind)).toEqual(["reveal", "reveal"]);
    const idx = a.map((x) => (x.kind === "reveal" ? x.items.map((i) => i.idx) : []));
    expect(idx[0]).toHaveLength(MAX_BATCH);
    expect(idx[1]).toHaveLength(2);
    expect(idx.flat().sort((x, y) => x - y)).toEqual([0, 1, 2, 4, 5, 6, 8, 9, 10, 11]);
    expect(idx.flat()).not.toContain(3);
    expect(idx.flat()).not.toContain(7);
  });
  it("items carry decimal strings and 32 hex salt; q outside 1..B is dropped", () => {
    const plain = { 0: { p: 3_000_000n, q: 1_000_000n }, 1: { p: 1n, q: 0n }, 2: { p: 1n, q: 3_000_001n } };
    const a = decide(keyed(), sealed(3), now, crypto(plain), CTX);
    expect(a).toEqual([{ kind: "reveal", items: [{ idx: 0, p: "3000000", q: "1000000", salt: "ab".repeat(16) }] }]);
  });
  it("already revealed bids are not revealed again", () => {
    const bids = sealed(3);
    bids[0] = bidView({ ...bids[0], state: "Revealed" });
    const a = decide(keyed({ revealed: 1 }), bids, now, crypto(plain3), CTX);
    expect(a).toEqual([{ kind: "reveal", items: [expect.objectContaining({ idx: 1 }), expect.objectContaining({ idx: 2 })] }]);
  });
  it("every bid revealed: finalize at once", () => {
    expect(decide(keyed({ revealed: 3 }), [], now, noCrypto, CTX)).toEqual([{ kind: "finalize", max: 8 }]);
  });
  it("window over: finalize", () => {
    expect(decide(keyed({ revealed: 1 }), sealed(3), CLOSE_NS + 3n * DAY_NS, crypto(plain3), CTX)).toEqual([{ kind: "finalize", max: 8 }]);
  });
  it("only unrevealable bids left and the window open: wait for the deadline", () => {
    const a = decide(keyed({ revealed: 2 }), sealed(1), now, crypto({}), CTX);
    expect(a).toEqual([expect.objectContaining({ kind: "wait", until: isoSec(CLOSE_NS + 2n * DAY_NS) })]);
  });
});

describe("decide: terminal states", () => {
  it("Finalized with an unpaid item finalizes again (retry)", () => {
    expect(decide(keyed({ state: "Finalized", payouts_done: 3 }), [], CLOSE_NS, noCrypto, CTX)).toEqual([{ kind: "finalize", max: 8 }]);
  });
  it("Finalized, everything paid: done", () => {
    expect(decide(keyed({ state: "Finalized", payouts_done: 4 }), [], CLOSE_NS, noCrypto, CTX)).toEqual([{ kind: "done", state: "Finalized · paid 4/4 ok" }]);
  });
  it("Cancelled with payouts left keeps paying; fully paid is done", () => {
    expect(decide(open({ state: "Cancelled", payouts_total: 4, payouts_done: 1 }), [], CLOSE_NS, noCrypto, CTX)).toEqual([{ kind: "finalize", max: 8 }]);
    expect(decide(open({ state: "Cancelled", payouts_total: 4, payouts_done: 4 }), [], CLOSE_NS, noCrypto, CTX)[0]).toMatchObject({ kind: "done" });
  });
});

describe("toCall: gas and arguments the function-call key may use", () => {
  it("open 100, reveal 100, finalize 300, cancel 300 Tgas; sale is a string", () => {
    expect(toCall({ kind: "open" }, "2")).toEqual({ method: "open", args: { sale: "2" }, gasTgas: 100 });
    expect(toCall({ kind: "cancel", rule: "a" }, "2")).toEqual({ method: "cancel", args: { sale: "2" }, gasTgas: 300 });
    expect(toCall({ kind: "finalize", max: 8 }, "2")).toEqual({ method: "finalize", args: { sale: "2", max: 8 }, gasTgas: 300 });
    expect(toCall({ kind: "reveal", items: [{ idx: 0, p: "1", q: "1", salt: "a".repeat(32) }] }, "2")?.gasTgas).toBe(100);
    expect(toCall({ kind: "wait", reason: "x" }, "2")).toBeNull();
  });
});

// A small chain: calls change the state the next view returns.
function chain(init: { sale: SaleView; bids: BidView[]; plain?: Record<number, { p: bigint; q: bigint }>; now: bigint; allowance?: bigint | null }) {
  const st = { sale: init.sale as SaleView | null, bids: init.bids, now: init.now, calls: [] as string[], lines: [] as string[], fail: false, openGivesKey: true, payFails: false };
  const deps: KeeperDeps = {
    config: async () => configView({ app_pk_mode: "identity" }),
    sale: async () => st.sale,
    bids: async () => st.bids,
    nowNs: async () => st.now,
    allowance: async () => (init.allowance === undefined ? null : init.allowance),
    crypto: crypto(init.plain ?? plain3),
    log: (l) => st.lines.push(l),
    call: async (c) => {
      st.calls.push(c.method);
      const s = st.sale as SaleView;
      if (st.fail) return { hash: `H${st.calls.length}`, ok: false, url: "u", error: "boom" };
      if (c.method === "open" && st.openGivesKey) st.sale = { ...s, state: "Keyed", key: KEY, key_requests: 1, reveal_deadline_ns: (st.now + DAY_NS).toString() };
      else if (c.method === "open") st.sale = { ...s, key_requests: s.key_requests + 1 };
      if (c.method === "reveal") {
        const idxs = (c.args as { items: { idx: number }[] }).items.map((i) => i.idx);
        st.bids = st.bids.map((b) => (idxs.includes(b.idx) ? { ...b, state: "Revealed" } : b));
        st.sale = { ...s, revealed: s.revealed + idxs.length };
      }
      if (c.method === "finalize") st.sale = { ...s, state: "Finalized", payouts_done: st.payFails ? s.payouts_done : s.payouts_total };
      if (c.method === "cancel") st.sale = { ...s, state: "Cancelled", payouts_done: s.payouts_total };
      return { hash: `H${st.calls.length}`, ok: true, url: `https://nearblocks.io/txns/H${st.calls.length}` };
    },
  };
  return { st, deps };
}
const OPTS: KeeperOpts = { network: "mainnet", contract: "v1.tenderseal.near", sale: "2", dryRun: false, once: false };

describe("runKeeper", () => {
  it("dry-run before close prints the exact line and sends nothing", async () => {
    const { st, deps } = chain({ sale: open(), bids: [], now: CLOSE_NS - 1n });
    const r = await runKeeper({ ...OPTS, dryRun: true }, deps);
    expect(st.lines).toEqual(["dry-run: would call open(2) after 2026-11-17T12:00:00Z"]);
    expect(st.calls).toEqual([]);
    expect(r.exitCode).toBe(0);
  });
  it("dry-run at close names the call and sends nothing", async () => {
    const { st, deps } = chain({ sale: open(), bids: [], now: CLOSE_NS });
    await runKeeper({ ...OPTS, dryRun: true }, deps);
    expect(st.lines).toEqual(["dry-run: would call open(2) now"]);
    expect(st.calls).toEqual([]);
  });
  it("open, reveal, finalize, then done in one run", async () => {
    const { st, deps } = chain({ sale: open({ payouts_total: 4 }), bids: sealed(3), now: CLOSE_NS + 10n });
    const r = await runKeeper(OPTS, deps);
    expect(st.calls).toEqual(["open", "reveal", "finalize"]);
    expect(st.lines.at(-1)).toBe("done: Finalized · paid 4/4 ok");
    expect(r.exitCode).toBe(0);
    expect(r.rows.filter((x) => x.tx).map((x) => x.action)).toEqual(["open(2)", "reveal(2, bids 0,1,2)", "finalize(2, 8)"]);
  });
  it("--once makes one call", async () => {
    const { st, deps } = chain({ sale: open(), bids: sealed(3), now: CLOSE_NS + 10n });
    await runKeeper({ ...OPTS, once: true }, deps);
    expect(st.calls).toEqual(["open"]);
  });
  it("an open whose key request failed is not repeated in the same run", async () => {
    const { st, deps } = chain({ sale: open(), bids: [], now: CLOSE_NS + 10n });
    st.openGivesKey = false;
    const r = await runKeeper(OPTS, deps);
    expect(st.calls).toEqual(["open"]);
    expect(r.exitCode).toBe(1);
    expect(st.lines.at(-1)).toMatch(/^stop: open\(2\) changed nothing/);
  });
  it("past close + 24 h an open that leaves the sale Open is followed by cancel b in the same run, then the payouts", async () => {
    const { st, deps } = chain({ sale: open({ payouts_total: 4 }), bids: [], now: CLOSE_NS + DAY_NS + 10n });
    st.openGivesKey = false;
    const r = await runKeeper(OPTS, deps);
    expect(st.calls).toEqual(["open", "cancel"]);
    expect(st.lines.at(-1)).toBe("done: Cancelled · paid 4/4 ok");
    expect(r.exitCode).toBe(0);
  });
  it("past close + 24 h with the conditions met the first call is open, not cancel", async () => {
    const { st, deps } = chain({ sale: open(), bids: [], now: CLOSE_NS + 2n * DAY_NS });
    await runKeeper({ ...OPTS, once: true }, deps);
    expect(st.calls).toEqual(["open"]);
  });
  it("a reveal batch that loses a race with the app does not end the run: the chain is read again and the rest is revealed", async () => {
    const { st, deps } = chain({ sale: keyed({ payouts_total: 4 }), bids: sealed(3), now: CLOSE_NS + 10n });
    const inner = deps.call;
    let first = true;
    deps.call = async (c) => {
      if (c.method === "reveal" && first) {
        first = false;
        st.calls.push("reveal(lost race)");
        st.bids = st.bids.map((b) => (b.idx === 0 ? { ...b, state: "Revealed" } : b)); // the app revealed bid 0 first
        st.sale = { ...(st.sale as SaleView), revealed: 1 };
        return { hash: "HX", ok: false, url: "u", error: "bid 0 is not sealed" };
      }
      return inner(c);
    };
    const r = await runKeeper(OPTS, deps);
    expect(st.calls).toEqual(["reveal(lost race)", "reveal", "finalize"]);
    expect(r.exitCode).toBe(0);
    expect(st.lines.at(-1)).toBe("done: Finalized · paid 4/4 ok");
  });
  it("a failed payout is retried once and then stops without looping", async () => {
    const { st, deps } = chain({ sale: keyed({ revealed: 3 }), bids: sealed(3), now: CLOSE_NS + 10n });
    st.payFails = true;
    const r = await runKeeper(OPTS, deps);
    expect(st.calls).toEqual(["finalize", "finalize"]);
    expect(r.exitCode).toBe(1);
  });
  it("a failed tx ends the run with exit code 1", async () => {
    const { st, deps } = chain({ sale: open(), bids: [], now: CLOSE_NS + 10n });
    st.fail = true;
    const r = await runKeeper(OPTS, deps);
    expect(r.exitCode).toBe(1);
    expect(st.lines[0]).toContain("status=Failure");
    expect(st.lines[0]).toContain("error=boom");
  });
  it("a low allowance stops before sending", async () => {
    const { st, deps } = chain({ sale: open(), bids: [], now: CLOSE_NS + 10n, allowance: 104_999_999_999_999_999_999_999n }); // open = 100 Tgas needs 0.105 NEAR
    const r = await runKeeper(OPTS, deps);
    expect(st.calls).toEqual([]);
    expect(r.exitCode).toBe(1);
    expect(st.lines[0]).toMatch(/^stop: function-call key allowance/);
  });
  it("the allowance needed follows the prepaid gas: 0.2 NEAR covers open (100 Tgas) but not a 300 Tgas finalize", async () => {
    const a = chain({ sale: open(), bids: [], now: CLOSE_NS + 10n, allowance: 200_000_000_000_000_000_000_000n });
    await runKeeper({ ...OPTS, once: true }, a.deps);
    expect(a.st.calls).toEqual(["open"]);
    const b = chain({ sale: keyed({ revealed: 3 }), bids: sealed(3), now: CLOSE_NS + 10n, allowance: 200_000_000_000_000_000_000_000n });
    const r = await runKeeper(OPTS, b.deps);
    expect(b.st.calls).toEqual([]);
    expect(r.exitCode).toBe(1);
    expect(b.st.lines[0]).toMatch(/^stop: function-call key allowance .* 300 Tgas prepaid gas/);
  });
  it("a missing sale or contract is exit 0 with 'no such sale'", async () => {
    const a = chain({ sale: open(), bids: [], now: CLOSE_NS });
    a.st.sale = null;
    expect((await runKeeper(OPTS, a.deps)).exitCode).toBe(0);
    expect(a.st.lines[0]).toMatch(/^no such sale/);
    const b = chain({ sale: open(), bids: [], now: CLOSE_NS });
    b.deps.config = async () => {
      throw new Error("view failed: UNKNOWN_ACCOUNT");
    };
    expect((await runKeeper(OPTS, b.deps)).exitCode).toBe(0);
    expect(b.st.lines[0]).toMatch(/^no such sale/);
  });
  it("cancel a sale whose conditions fail, then pay it out", async () => {
    const { st, deps } = chain({ sale: open({ escrow_total: "1000000", bidders: 1, bids: 1, payouts_total: 2 }), bids: [], now: CLOSE_NS + 10n });
    const r = await runKeeper(OPTS, deps);
    expect(st.calls).toEqual(["cancel"]);
    expect(st.lines.at(-1)).toBe("done: Cancelled · paid 2/2 ok");
    expect(r.exitCode).toBe(0);
  });
  it("a bad key stops the run with FAIL checkKey and no reveal", async () => {
    const { st, deps } = chain({ sale: keyed(), bids: sealed(3), now: CLOSE_NS + 10n });
    deps.crypto = crypto(plain3, false);
    const r = await runKeeper(OPTS, deps);
    expect(st.calls).toEqual([]);
    expect(r.exitCode).toBe(1);
    expect(st.lines[0]).toContain("FAIL checkKey");
  });
});

describe("output", () => {
  it("describeAction", () => {
    expect(describeAction({ kind: "finalize", max: 8 }, "2")).toBe("finalize(2, 8)");
    expect(describeAction({ kind: "cancel", rule: "b" }, "2")).toBe("cancel(2) rule b");
  });
  it("under GitHub Actions the summary tells a human what to record, with the hash and a deadline 2 h after the tx", () => {
    const rows = [{ turn: 1, action: "open(2)", tx: "H1", url: "https://nearblocks.io/txns/H1", ok: true, step: "open", at: "2026-11-17T12:03:10Z" }, { turn: 2, action: "done: Finalized · paid 4/4 ok" }];
    const md = summaryMarkdown(OPTS, rows, { signer: "tenderseal.near" });
    expect(md).toContain("RECORD NEEDED by 2026-11-17T14:03:10Z: `pnpm record --sale 2 --step open --tx H1 --signer tenderseal.near --chain near`");
    expect(md.match(/RECORD NEEDED/g)).toHaveLength(1);
    expect(summaryMarkdown(OPTS, rows)).not.toContain("RECORD NEEDED"); // a local run records itself
    expect(summaryMarkdown({ ...OPTS, contract: "rehearsal.tenderseal.near" }, rows, { signer: "x.near" })).toContain("--sale R ");
  });
  it("the step summary is a Markdown table with the explorer link", () => {
    const md = summaryMarkdown(OPTS, [{ turn: 1, action: "open(2)", tx: "H1", url: "https://nearblocks.io/txns/H1", ok: true }, { turn: 2, action: "done: Finalized · paid 4/4 ok" }]);
    expect(md).toContain("| 1 | open(2) | [H1](https://nearblocks.io/txns/H1) |");
    expect(md).toContain("| 2 | done: Finalized · paid 4/4 ok |  |");
  });
});

describe("main", () => {
  it("needs --sale", async () => expect(await main([])).toBe(2));
  it("rejects a non-numeric sale", async () => expect(await main(["--sale", "x"])).toBe(2));
  it("--yes without a key is a usage-level error, not a crash", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keeper-"));
    vi.stubEnv("NEAR_CREDENTIALS_DIR", dir);
    vi.stubEnv("KEEPER_PRIVATE_KEY", "");
    try {
      expect(await main(["--sale", "2", "--yes", "--network", "testnet"], { KEEPER_ACCOUNT_ID: "nobody.testnet" })).toBe(2);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("the keeper key (KEEP-05, OPS-03)", () => {
  const V1 = "v1.tenderseal.near";
  const fc = (over: Record<string, unknown> = {}) => ({ kind: "FunctionCall" as const, allowance: 500_000_000_000_000_000_000_000n, receiverId: V1, methodNames: ["open", "reveal", "finalize", "cancel"], ...over });
  const live = { allowFullAccess: false, ci: false };
  it("the function-call key of H-keys-keeper passes; a subset of the four methods passes", () => {
    expect(keeperKeyProblem(fc(), V1, live)).toBeNull();
    expect(keeperKeyProblem(fc({ methodNames: ["open", "reveal"] }), V1, live)).toBeNull();
    expect(keeperKeyProblem(fc({ allowance: null }), V1, live)).toBeNull();
  });
  it("a key for another receiver, other methods, no methods, or an allowance under 0.315 NEAR (a 300 Tgas call) is refused", () => {
    expect(keeperKeyProblem(fc({ receiverId: "intents.near" }), V1, live)).toMatch(/limited to intents.near/);
    expect(keeperKeyProblem(fc({ methodNames: ["open", "withdraw"] }), V1, live)).toMatch(/subset/);
    expect(keeperKeyProblem(fc({ methodNames: [] }), V1, live)).toMatch(/subset/);
    expect(keeperKeyProblem(fc({ allowance: 314_999_999_999_999_999_999_999n }), V1, live)).toMatch(/below/);
  });
  it("a full-access key needs --allow-full-access, and is refused under GitHub Actions even with it", () => {
    const fa = { kind: "FullAccess" as const, allowance: null };
    expect(keeperKeyProblem(fa, V1, live)).toMatch(/full-access/);
    expect(keeperKeyProblem(fa, V1, { allowFullAccess: true, ci: false })).toBeNull();
    expect(keeperKeyProblem(fa, V1, { allowFullAccess: true, ci: true })).toMatch(/GitHub Actions/);
  });
  const key = KeyPair.fromRandom("ed25519").toString();
  const FULL = async () => ({ kind: "FullAccess" as const, allowance: null });
  // resolveKey reads process.env and the key directory: stub both so no test touches a real keychain
  const errors = async (run: () => Promise<number>, vars: Record<string, string> = {}) => {
    vi.stubEnv("NEAR_CREDENTIALS_DIR", mkdtempSync(join(tmpdir(), "keeper-")));
    vi.stubEnv("KEEPER_PRIVATE_KEY", "");
    for (const [k, v] of Object.entries(vars)) vi.stubEnv(k, v);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      return { code: await run(), text: spy.mock.calls.map((c) => String(c[0])).join("\n") };
    } finally {
      spy.mockRestore();
      vi.unstubAllEnvs();
    }
  };
  it("a garbage key exits 2 on --dry-run --check-key (the Friday secret test); without a key it exits 2 too", async () => {
    const a = await errors(() => main(["--sale", "2", "--dry-run", "--check-key"], { KEEPER_ACCOUNT_ID: "tenderseal.near" }, FULL), { KEEPER_PRIVATE_KEY: "garbage" });
    expect(a.code).toBe(2);
    expect(a.text).toMatch(/KEEPER_PRIVATE_KEY is set but is not an "ed25519/);
    const b = await errors(() => main(["--sale", "2", "--dry-run", "--check-key", "--network", "testnet"], { KEEPER_ACCOUNT_ID: "nobody.testnet" }, FULL));
    expect(b.code).toBe(2);
    expect(b.text).toMatch(/no key for nobody\.testnet/);
  });
  it("a full-access key exits 2 under GitHub Actions on a live run and on the dry-run check, before any call", async () => {
    const env = { KEEPER_ACCOUNT_ID: "tenderseal.near", GITHUB_ACTIONS: "true" };
    const live = await errors(() => main(["--sale", "2", "--yes", "--allow-full-access"], env, FULL), { KEEPER_PRIVATE_KEY: key });
    expect(live.code).toBe(2);
    expect(live.text).toMatch(/full-access key; a GitHub Actions run only takes a function-call key/);
    const dry = await errors(() => main(["--sale", "2", "--dry-run", "--check-key"], env, FULL), { KEEPER_PRIVATE_KEY: key });
    expect(dry.code).toBe(2);
    expect(dry.text).toMatch(/GitHub Actions/);
    const local = await errors(() => main(["--sale", "2", "--dry-run", "--check-key"], { KEEPER_ACCOUNT_ID: "tenderseal.near" }, FULL), { KEEPER_PRIVATE_KEY: key });
    expect(local.code).toBe(2);
    expect(local.text).toMatch(/pass --allow-full-access \(humans only\)/);
  });
  it("a function-call key for another receiver exits 2; so does a key that is not on chain", async () => {
    const env = { KEEPER_ACCOUNT_ID: "tenderseal.near" };
    const other = await errors(() => main(["--sale", "2", "--yes"], env, async () => fc({ receiverId: "intents.near" })), { KEEPER_PRIVATE_KEY: key });
    expect(other.code).toBe(2);
    expect(other.text).toMatch(/limited to intents\.near, not v1\.tenderseal\.near/);
    const gone = await errors(() => main(["--sale", "2", "--yes"], env, async () => { throw new Error("access key does not exist"); }), { KEEPER_PRIVATE_KEY: key });
    expect(gone.code).toBe(2);
    expect(gone.text).toMatch(/cannot read the keeper key/);
  });
});
