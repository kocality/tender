import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { MAX_BATCH, decide, describeAction, isoSec, main, runKeeper, summaryMarkdown, toCall, type KeeperCrypto, type KeeperDeps, type KeeperOpts } from "../src/keeper.js";
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
  it("close + 24 h with no key and nothing in flight: cancel b", () => {
    expect(decide(open({ key_requests: 2 }), [], CLOSE_NS + DAY_NS, noCrypto, CTX)).toEqual([{ kind: "cancel", rule: "b" }]);
    expect(decide(open({ key_requests: 2 }), [], CLOSE_NS + DAY_NS - 1n, noCrypto, CTX)).toEqual([{ kind: "open" }]);
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
    const { st, deps } = chain({ sale: open(), bids: [], now: CLOSE_NS + 10n, allowance: 49_999_999_999_999_999_999_999n });
    const r = await runKeeper(OPTS, deps);
    expect(st.calls).toEqual([]);
    expect(r.exitCode).toBe(1);
    expect(st.lines[0]).toMatch(/^stop: function-call key allowance/);
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
