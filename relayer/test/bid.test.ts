import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeyPair } from "near-api-js";
import { describe, expect, it } from "vitest";
import { b58decode, fromBase64, nep413Prehash, type MultiPayload } from "@tender/intents";
import { MPC_DOMAIN2_PK, commitmentHex, sealBid } from "@tender/seal";
import { buildBidPayload, loadSealedFile, main, refundProblem, signNep413, windowProblem, type BidEnv, type Submitted } from "../scripts/bid-nep413.js";
import type { BidView, SaleView } from "../scripts/lib/views.js";
import { bidView, configView, saleView } from "./helpers/views.js";

const USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const CONTRACT = "v1.tenderseal.near";
const INTENTS = "intents.near";
const SIGNER = "bidder.tenderseal.near";
const NOW_NS = 1_794_000_000_000_000_000n;

const baseSale = (over: Partial<SaleView> = {}): SaleView => saleView({
  id: "3", close_ns: (NOW_NS + 3_600_000_000_000n).toString(), path: "tender/3/00112233445566778899aabbccddeeff", lot_exp: 0, ...over,
});

interface Fake { env: BidEnv; calls: string[]; sent: MultiPayload[]; bids: BidView[]; balance: { v: bigint }; keys: { v: string[] }; recorded: Array<Parameters<BidEnv["record"]>[0]> }

function fake(o: { sale?: Partial<SaleView>; secret?: KeyPair | null; balance?: bigint; native?: bigint; registered?: boolean; simulateFails?: boolean; refund?: boolean; foreignAfter?: boolean } = {}): Fake {
  const kp = o.secret === undefined ? KeyPair.fromRandom("ed25519") : o.secret;
  const calls: string[] = [];
  const sent: MultiPayload[] = [];
  const bids: BidView[] = [];
  const recorded: Fake["recorded"] = [];
  const balance = { v: o.balance ?? 10_000_000n };
  const keys = { v: kp && o.registered !== false ? [kp.getPublicKey().toString()] : [] };
  const cmOf = (mp: MultiPayload) => {
    if (mp.standard !== "nep413") throw new Error("expected nep413");
    return JSON.parse(JSON.parse(mp.payload.message).intents[0].msg).cm as string;
  };
  const env: BidEnv = {
    config: async () => configView({ mpc_public_key: MPC_DOMAIN2_PK.mainnet }),
    sale: async () => baseSale(o.sale),
    bids: async () => bids,
    nowNs: async () => NOW_NS,
    balance: async () => balance.v,
    spendable: async () => o.native ?? 5n * 10n ** 24n,
    intentsKeys: async () => keys.v,
    currentSalt: async () => "252812b3",
    simulate: async (_i, mp) => {
      calls.push("simulate");
      sent.push(mp);
      return o.simulateFails ? { ok: false, kind: "insufficient_balance", message: "insufficient balance or overflow" } : { ok: true };
    },
    secretKey: () => (kp ? (kp.toString() as `ed25519:${string}`) : null),
    execute: async (signer, _i, mp): Promise<Submitted> => {
      calls.push("execute");
      if (o.refund) balance.v = balance.v; // escrow debited, then refunded: balance unchanged
      else bids.push(bidView({ idx: bids.length, bidder: signer, ct: "", cm: cmOf(mp), origin: "near" }));
      if (o.foreignAfter) bids.push(bidView({ idx: bids.length, bidder: "someone.near", ct: "", cm: "f".repeat(64), origin: "near" })); // another bidder lands right after ours
      return { hash: "HASH1", ok: true, block: 5, logs: [], signer };
    },
    relay: async () => {
      calls.push("relay");
      return { hash: "HASH2", ok: true, logs: [], signer: "relayer.tenderseal.near" };
    },
    record: async (row) => {
      calls.push("record");
      recorded.push(row);
    },
    sleep: async () => {},
  };
  return { env, calls, sent, bids, balance, keys, recorded };
}

async function run(args: string[], f: Fake, dir = mkdtempSync(join(tmpdir(), "bid-"))) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(args, { env: () => f.env, io: { out: (l) => out.push(l), err: (l) => err.push(l) }, bidsDir: dir });
  return { code, out: out.join("\n"), err: err.join("\n"), dir };
}

const BASE = ["--sale", "3", "--price", "3.5", "--size", "1", "--escrow", "3", "--signer", SIGNER, "--contract", CONTRACT];

describe("signer gas balance (OPS-01): a 300 Tgas execute_intents needs 0.3009 NEAR in the signer", () => {
  const BIDDER_NEAR = 199_600_000_000_000_000_000_000n; // bidder.tenderseal.near on 2026-11-11: 0.1996 NEAR
  it("a dry-run for a bidder with 0.1996 NEAR prints BLOCKED and exits 1 (it used to pass and fail at --yes)", async () => {
    const f = fake({ native: BIDDER_NEAR });
    const r = await run(BASE, f);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/BLOCKED: bidder\.tenderseal\.near can spend 0\.1996 NEAR and signing 300 Tgas needs 0\.30093 NEAR/);
    expect(r.out).toContain("--via-relay");
    expect(f.calls).not.toContain("execute");
  });
  it("--yes with that balance sends nothing", async () => {
    const f = fake({ native: BIDDER_NEAR });
    const r = await run([...BASE, "--yes"], f);
    expect(r.code).toBe(1);
    expect(f.calls).not.toContain("execute");
    expect(f.calls).not.toContain("relay");
  });
  it("--via-relay does not need the balance; a topped-up bidder (0.45 NEAR) passes", async () => {
    const viaRelay = fake({ native: BIDDER_NEAR });
    const r = await run([...BASE, "--via-relay", "http://localhost:8787/relay"], viaRelay);
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("BLOCKED");
    expect((await run(BASE, fake({ native: 450_000_000_000_000_000_000_000n }))).code).toBe(0);
  });
});

describe("bid payload", () => {
  it("transfer fields match the Intents contract of the card", async () => {
    const f = fake();
    const r = await run(BASE, f);
    expect(r.code).toBe(0);
    const line = r.out.split("\n").find((l) => l.startsWith("payload (unsigned): "))!;
    const p = JSON.parse(line.slice("payload (unsigned): ".length));
    expect(p.signer_id).toBe(SIGNER);
    expect(p.verifying_contract).toBe(INTENTS);
    expect(p.intents).toHaveLength(1);
    const t = p.intents[0];
    expect(t.intent).toBe("transfer");
    expect(t.receiver_id).toBe(CONTRACT);
    expect(t.tokens).toEqual({ [USDC]: "3000000" });
    expect(t.min_gas).toBe("30000000000000");
    expect(typeof t.msg).toBe("string");
    const msg = JSON.parse(t.msg);
    expect(Object.keys(msg)).toEqual(["op", "sale", "ct", "cm", "origin"]);
    expect(msg.op).toBe("bid");
    expect(msg.sale).toBe("3");
    expect(msg.origin).toBe("near");
    expect(fromBase64(msg.ct)).toHaveLength(160);
    expect(msg.cm).toMatch(/^[0-9a-f]{64}$/);
    // 10 minutes after the chain's clock, not the local one (X12-01): the fake chain stands in 2026-11-06, the local clock does not
    expect(p.deadline).toBe(new Date(Math.floor(Number(NOW_NS / 1_000_000n + 600_000n) / 1000) * 1000).toISOString());
  });

  it("the nep413 signature verifies over the Intents prehash", async () => {
    const kp = KeyPair.fromRandom("ed25519");
    const { payload, nonce32 } = await buildBidPayload({
      signer: SIGNER, intents: INTENTS, contract: CONTRACT, token: USDC, amount: 3_000_000n, sale: "3", ct: "A".repeat(216), cm: "0".repeat(64), origin: "near", saltHex: "252812b3",
    });
    const mp = await signNep413(kp.toString() as `ed25519:${string}`, SIGNER, payload, nonce32);
    if (mp.standard !== "nep413") throw new Error("nep413 expected");
    expect(mp.public_key).toBe(kp.getPublicKey().toString());
    expect(mp.payload.recipient).toBe(INTENTS);
    const prehash = nep413Prehash({ message: mp.payload.message, nonce32, recipient: INTENTS });
    expect(kp.verify(prehash, b58decode(mp.signature.replace(/^ed25519:/, "")))).toBe(true);
  });

  it("dry-run signs and simulates but never submits or records", async () => {
    const f = fake();
    const r = await run(BASE, f);
    expect(r.code).toBe(0);
    expect(f.calls).toEqual(["simulate"]);
    expect(r.out).toContain("DRY-RUN · nothing sent");
    expect(r.out).toContain("simulate_intents: ok");
    expect(r.out).toMatch(/\[1\/1\] signer=bidder\.tenderseal\.near receiver=intents\.near method=execute_intents deposit=0 NEAR gas=300 Tgas/);
    expect(r.out).not.toContain("signature");
  });

  it("writes the plaintext bid file with mode 600 and p, q, salt", async () => {
    const f = fake();
    const r = await run(BASE, f);
    const m = /sealed bid file .*: (\S+\.json)/.exec(r.out)!;
    const file = m[1] as string;
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const j = JSON.parse(readFileSync(file, "utf8"));
    expect(j).toMatchObject({ sale: "3", signer: SIGNER, escrow: "3000000", p: "3500000", q: "1000000", origin: "near" });
    expect(j.salt).toMatch(/^[0-9a-f]{32}$/);
    expect(commitmentHex({ sale: 3n, bidder: SIGNER, B: 3_000_000n, p: 3_500_000n, q: 1_000_000n, salt: Uint8Array.from(Buffer.from(j.salt, "hex")) })).toBe(j.cm);
  });
});

describe("window and checks", () => {
  it("windowProblem", () => {
    const s = baseSale();
    expect(windowProblem(s, NOW_NS, false)).toBeNull();
    expect(windowProblem(s, NOW_NS, true)).toMatch(/--late needs the sale to be closed/);
    expect(windowProblem(s, BigInt(s.close_ns), false)).toMatch(/closed/);
    expect(windowProblem(s, BigInt(s.close_ns), true)).toBeNull();
    expect(windowProblem(baseSale({ state: "Keyed" }), NOW_NS, false)).toMatch(/Keyed/);
  });

  it("--late before close is refused", async () => {
    const r = await run([...BASE, "--late"], fake());
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/--late needs the sale to be closed/);
  });

  it("a normal bid after close is refused", async () => {
    const r = await run(BASE, fake({ sale: { close_ns: (NOW_NS - 1n).toString() } }));
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/use --late/);
  });

  it("an unregistered key names H-INTENTS-KEYS", async () => {
    const f = fake({ registered: false });
    const r = await run(BASE, f);
    expect(r.code).toBe(1);
    expect(r.err).toContain("run H-INTENTS-KEYS for bidder.tenderseal.near");
    expect(f.calls).not.toContain("simulate");
  });

  it("an empty Intents balance says to deposit first", async () => {
    const r = await run(BASE, fake({ balance: 1_000_000n }));
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/deposit first/);
  });

  it("a failing simulate_intents stops with exit 1 and no submit", async () => {
    const f = fake({ simulateFails: true });
    const r = await run([...BASE, "--yes"], f);
    expect(r.code).toBe(1);
    expect(r.err).toContain("insufficient balance or overflow");
    expect(f.calls).not.toContain("execute");
  });

  it("refuses an MPC key that is not the repo's", async () => {
    const f = fake();
    f.env.config = async () => configView({ mpc_public_key: MPC_DOMAIN2_PK.testnet });
    const r = await run(BASE, f);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/MPC key mismatch/);
  });

  it("escrow below 1 USDC and size above escrow are refused", async () => {
    expect((await run(["--sale", "3", "--price", "3.5", "--size", "1", "--escrow", "0.5", "--contract", CONTRACT], fake())).code).toBe(1);
    expect((await run(["--sale", "3", "--price", "3.5", "--size", "4", "--escrow", "3", "--contract", CONTRACT], fake())).code).toBe(1);
  });
});

describe("--sealed", () => {
  const sealedFile = (over: Record<string, unknown> = {}, dir = mkdtempSync(join(tmpdir(), "sealed-"))) => {
    const salt = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
    const s = sealBid({ mpk: MPC_DOMAIN2_PK.mainnet, contract: CONTRACT, path: "tender/v1/3", sale: 3n, bidder: SIGNER, B: 3_000_000n, p: 3_600_000n, q: 2_000_000n, salt });
    const file = join(dir, "bid.json");
    writeFileSync(file, JSON.stringify({ sale: "3", contract: CONTRACT, signer: SIGNER, ct: s.ct_b64, cm: s.cm_hex, salt: s.salt_hex, p: "3600000", q: "2000000", escrow: "3000000", origin: null, ...over }));
    return { file, s };
  };

  it("uses ct and cm from the file and needs no --price or --size", async () => {
    const { file, s } = sealedFile();
    const f = fake();
    const r = await run(["--sale", "3", "--escrow", "3", "--signer", SIGNER, "--contract", CONTRACT, "--sealed", file], f);
    expect(r.code).toBe(0);
    const p = JSON.parse(r.out.split("\n").find((l) => l.startsWith("payload (unsigned): "))!.slice(20));
    const msg = JSON.parse(p.intents[0].msg);
    expect(msg.ct).toBe(s.ct_b64);
    expect(msg.cm).toBe(s.cm_hex);
    expect(msg.origin).toBe("near");
  });

  it("rejects a sale mismatch", () => {
    const { file } = sealedFile({ sale: "2" });
    expect(() => loadSealedFile(file, { sale: "3", escrow: 3_000_000n, signer: SIGNER, contract: CONTRACT })).toThrow(/sale 2, not sale 3/);
  });

  it("rejects an escrow mismatch", () => {
    const { file } = sealedFile();
    expect(() => loadSealedFile(file, { sale: "3", escrow: 2_000_000n, signer: SIGNER, contract: CONTRACT })).toThrow(/escrow/);
  });

  it("rejects another signer: the commitment binds the bidder", () => {
    const { file } = sealedFile();
    expect(() => loadSealedFile(file, { sale: "3", escrow: 3_000_000n, signer: "other.near", contract: CONTRACT })).toThrow(/binds the signer/);
  });

  it("rejects a cm that does not match its own p, q and salt", () => {
    const { file } = sealedFile({ q: "2000001" });
    expect(() => loadSealedFile(file, { sale: "3", escrow: 3_000_000n, signer: SIGNER, contract: CONTRACT })).toThrow(/cm does not match/);
  });

  it("rejects a ct of the wrong length", () => {
    const { file } = sealedFile({ ct: "AAAA" });
    expect(() => loadSealedFile(file, { sale: "3", escrow: 3_000_000n, signer: SIGNER, contract: CONTRACT })).toThrow(/160 bytes/);
  });
});

describe("--yes", () => {
  it("honest bid: executes, then finds its own cm as the last bid", async () => {
    const f = fake();
    const r = await run([...BASE, "--yes", "--no-record"], f);
    expect(r.code).toBe(0);
    expect(f.calls).toEqual(["simulate", "execute"]);
    expect(r.out).toContain("OK bid idx 0 sealed");
  });

  it("records on mainnet with the sale tag", async () => {
    const f = fake();
    const r = await run([...BASE, "--yes"], f);
    expect(r.code).toBe(0);
    expect(f.calls).toEqual(["simulate", "execute", "record"]);
  });

  it("--late: escrow comes back and no bid is added", async () => {
    const f = fake({ sale: { close_ns: (NOW_NS - 1n).toString() }, refund: true });
    const r = await run([...BASE, "--late", "--yes", "--no-record"], f);
    expect(r.code).toBe(0);
    expect(r.out).toContain("OK late bid refunded");
  });

  it("--late fails when the bid was accepted", async () => {
    const f = fake({ sale: { close_ns: (NOW_NS - 1n).toString() } });
    const r = await run([...BASE, "--late", "--yes", "--no-record"], f);
    expect(r.code).toBe(1);
  });

  it("--via-relay posts to the relay instead of sending a transaction", async () => {
    const f = fake();
    const r = await run([...BASE, "--yes", "--no-record", "--via-relay", "http://localhost:8787/relay"], f);
    expect(f.calls).toContain("relay");
    expect(f.calls).not.toContain("execute");
    expect(r.out).toContain("tx=HASH2");
  });

  it("a missing key is an error with --yes", async () => {
    const r = await run([...BASE, "--yes"], fake({ secret: null }));
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/no key for bidder\.tenderseal\.near/);
  });

  it("a missing key is only a note in a dry-run", async () => {
    const r = await run(BASE, fake({ secret: null }));
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/no local key/);
  });
});

describe("refunded bids leave their ciphertext in public history (X12P-02)", () => {
  const closeIn = (ms: number) => ({ close_ns: (NOW_NS + BigInt(ms) * 1_000_000n).toString() });
  const deadlineOf = (out: string) => JSON.parse(out.split("\n").find((l) => l.startsWith("payload (unsigned): "))!.slice(20)).deadline as string;
  it("the signed deadline stops a minute before close", async () => {
    const r = await run(BASE, fake({ sale: closeIn(300_000) }));
    expect(r.code).toBe(0);
    expect(deadlineOf(r.out)).toBe(new Date(Number(NOW_NS / 1_000_000n) + 240_000).toISOString());
  });
  it("a sale that closes within a minute is refused before anything is sealed", async () => {
    const f = fake({ sale: closeIn(59_000) });
    const r = await run(BASE, f);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/less than a minute from now/);
    expect(r.out).not.toContain("sealed bid file");
    expect(f.calls).toEqual([]);
  });
  it("a full sale, the escrow cap and a key request in flight are refused; --late is not held to them", async () => {
    expect(refundProblem(baseSale({ bids: 8, max_bids: 8 }), 1_000_000n)).toMatch(/sale is full \(8\/8 bids\)/);
    expect(refundProblem(baseSale({ escrow_total: "999999999999" }), 2n)).toMatch(/escrow cap/);
    expect(refundProblem(baseSale({ in_flight: true }), 1_000_000n)).toMatch(/in flight/);
    expect(refundProblem(baseSale(), 3_000_000n)).toBeNull();
    const full = await run(BASE, fake({ sale: { bids: 16, max_bids: 16 } }));
    expect(full.code).toBe(1);
    expect(full.err).toMatch(/sale is full/);
    expect((await run([...BASE, "--late"], fake({ sale: { ...closeIn(-1000), bids: 16, max_bids: 16 } }))).code).toBe(0);
  });
});

describe("what is recorded, and when (S-05, SC-06)", () => {
  const order = (f: Fake) => {
    const seq: string[] = [];
    const bids = f.env.bids;
    const record = f.env.record;
    f.env.bids = async (id) => (seq.push("bids"), bids(id));
    f.env.record = async (row) => (seq.push("record"), record(row));
    return seq;
  };
  it("the row is written after the get_bids confirmation, not before it", async () => {
    const f = fake();
    const seq = order(f);
    expect((await run([...BASE, "--yes"], f)).code).toBe(0);
    expect(seq.lastIndexOf("bids")).toBeLessThan(seq.indexOf("record"));
    expect(f.recorded).toHaveLength(1);
    expect(f.recorded[0]).toMatchObject({ sale: "3", step: "bid", txHash: "HASH1" });
  });
  it("a bid the contract refunded is reported FAIL (and its tx is still recorded, as what the chain says it was)", async () => {
    const f = fake({ refund: true });
    const seq = order(f);
    const r = await run([...BASE, "--yes"], f);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/FAIL the bid is not in get_bids/);
    expect(seq.lastIndexOf("bids")).toBeLessThan(seq.indexOf("record")); // the 10 polls come first
  });
  it("another bidder landing after ours does not turn a stored bid into a FAIL", async () => {
    const f = fake({ foreignAfter: true });
    const r = await run([...BASE, "--yes", "--no-record"], f);
    expect(r.code).toBe(0);
    expect(r.out).toContain("OK bid idx 0 sealed");
  });
  it("a late bid is recorded as an expected failure (it is refunded), after the refund is seen", async () => {
    const f = fake({ sale: { close_ns: (NOW_NS - 1n).toString() }, refund: true });
    const seq = order(f);
    expect((await run([...BASE, "--late", "--yes"], f)).code).toBe(0);
    expect(f.recorded[0]).toMatchObject({ step: "attack-late", expect: "failure" });
    expect(seq.lastIndexOf("bids")).toBeLessThan(seq.indexOf("record"));
  });
  it("escrow equal to size says the size is public (X12-02: escrow B is visible the moment the bid lands, q <= B)", async () => {
    const same = await run(["--sale", "3", "--price", "3.5", "--size", "3", "--escrow", "3", "--signer", SIGNER, "--contract", CONTRACT], fake());
    expect(same.out).toMatch(/note: --escrow equals --size: the escrow is public the moment the bid lands, so the size is public too; use an escrow above the size/);
    expect((await run(BASE, fake())).out).not.toMatch(/escrow equals --size/);
  });
  it("a below-reserve bid says it is refunded once it is revealed, not 'in full' without a condition", async () => {
    const r = await run(["--sale", "3", "--price", "1", "--size", "1", "--escrow", "3", "--signer", SIGNER, "--contract", CONTRACT], fake({ sale: { reserve: "3000000" } }));
    expect(r.out).toMatch(/refunded in full once it is revealed/);
    expect(r.out).not.toMatch(/the bid is refunded in full but/);
  });
});
