import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeyPair } from "near-api-js";
import { describe, expect, it } from "vitest";
import { b58decode, fromBase64, nep413Prehash, type MultiPayload } from "@tender/intents";
import { MPC_DOMAIN2_PK, commitmentHex, sealBid } from "@tender/seal";
import { buildBidPayload, loadSealedFile, main, signNep413, windowProblem, type BidEnv, type Submitted } from "../scripts/bid-nep413.js";
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

interface Fake { env: BidEnv; calls: string[]; sent: MultiPayload[]; bids: BidView[]; balance: { v: bigint }; keys: { v: string[] } }

function fake(o: { sale?: Partial<SaleView>; secret?: KeyPair | null; balance?: bigint; registered?: boolean; simulateFails?: boolean; refund?: boolean } = {}): Fake {
  const kp = o.secret === undefined ? KeyPair.fromRandom("ed25519") : o.secret;
  const calls: string[] = [];
  const sent: MultiPayload[] = [];
  const bids: BidView[] = [];
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
      return { hash: "HASH1", ok: true, block: 5, logs: [], signer };
    },
    relay: async () => {
      calls.push("relay");
      return { hash: "HASH2", ok: true, logs: [], signer: "relayer.tenderseal.near" };
    },
    record: async () => {
      calls.push("record");
    },
    sleep: async () => {},
  };
  return { env, calls, sent, bids, balance, keys };
}

async function run(args: string[], f: Fake, dir = mkdtempSync(join(tmpdir(), "bid-"))) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(args, { env: () => f.env, io: { out: (l) => out.push(l), err: (l) => err.push(l) }, bidsDir: dir });
  return { code, out: out.join("\n"), err: err.join("\n"), dir };
}

const BASE = ["--sale", "3", "--price", "3.5", "--size", "1", "--escrow", "3", "--signer", SIGNER, "--contract", CONTRACT];

describe("bid payload", () => {
  it("transfer fields match the Intents contract of the card", async () => {
    const f = fake();
    const before = Date.now();
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
    const ttl = Date.parse(p.deadline) - before;
    expect(ttl).toBeGreaterThan(595_000 - 1000);
    expect(ttl).toBeLessThan(605_000);
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
