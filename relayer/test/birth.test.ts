import { describe, expect, it } from "vitest";
import { BirthRefusal, configDiff, formatPlan, minBalance, planBirth, sha256Hex, validateInit, type BirthOpts } from "../scripts/birth.js";

const wasm = (n: number) => new Uint8Array(n).fill(7);
const base: BirthOpts = {
  network: "mainnet", signer: "tenderseal.near", account: "v1.tenderseal.near", wasm: "contract/res/tender.wasm",
  balance: "4.5", init: "sales/v1-init.json", initMethod: "new", yes: false, releaseSha256: sha256Hex(wasm(250_000)),
};
const types = (o: BirthOpts, w = wasm(250_000)) => planBirth(o, w).actions.map((a) => a.type);

describe("planBirth", () => {
  it("(a) v1.* with a full-access key is refused in every setting", () => {
    expect(() => planBirth({ ...base, addFullAccessKey: "generate" }, wasm(250_000))).toThrow(/v1\.\* must be born keyless/);
    expect(() => planBirth({ ...base, network: "testnet", signer: "t.testnet", account: "v1.t.testnet", addFullAccessKey: "generate", releaseSha256: undefined }, wasm(250_000))).toThrow(/keyless/);
  });
  it("(b) rehearsal with a key: CreateAccount, Transfer, AddKey, DeployContract, FunctionCall", () => {
    expect(types({ ...base, account: "rehearsal.tenderseal.near", addFullAccessKey: "generate" })).toEqual([
      "CreateAccount", "Transfer", "AddKey", "DeployContract", "FunctionCall",
    ]);
  });
  it("(c) v1.* is four actions with no AddKey", () => {
    expect(types(base)).toEqual(["CreateAccount", "Transfer", "DeployContract", "FunctionCall"]);
  });
  it("(d) only one sub-account level of the signer", () => {
    expect(() => planBirth({ ...base, account: "a.b.tenderseal.near" }, wasm(250_000))).toThrow(BirthRefusal);
    expect(() => planBirth({ ...base, account: "v1.other.near" }, wasm(250_000))).toThrow(/<label>\.tenderseal\.near/);
  });
  it("(e) 2 NEAR for 250000 bytes is refused and the minimum 4.5 is named", () => {
    expect(() => planBirth({ ...base, balance: "2" }, wasm(250_000))).toThrow(/minimum 4\.5 NEAR/);
    expect(minBalance(250_000)).toBe("4.5");
    expect(minBalance(100_000)).toBe("2.5");
    expect(minBalance(100_001)).toBe("3.5");
  });
  it("(f) mainnet needs the release sha; a different wasm is refused", () => {
    expect(() => planBirth({ ...base, releaseSha256: "0".repeat(64) }, wasm(250_000))).toThrow(/not the release artifact/);
    expect(() => planBirth({ ...base, releaseSha256: undefined }, wasm(250_000))).toThrow(/tender\.wasm\.sha256 not found/);
  });
  it("(g) testnet accepts --init-method ping, mainnet refuses it", () => {
    const t: BirthOpts = { ...base, network: "testnet", signer: "t-1.testnet", account: "spk-1.t-1.testnet", initMethod: "ping", balance: "3", releaseSha256: undefined };
    expect(planBirth(t, wasm(90_540)).actions.at(-1)).toMatchObject({ type: "FunctionCall", method: "ping" });
    expect(() => planBirth({ ...base, initMethod: "ping" }, wasm(250_000))).toThrow(/testnet only/);
  });
  it("a key on mainnet is for rehearsal.* only; an explicit public key is carried into AddKey", () => {
    expect(() => planBirth({ ...base, account: "spike.tenderseal.near", addFullAccessKey: "generate" }, wasm(250_000))).toThrow(/testnet or rehearsal/);
    const pk = "ed25519:5mfFwPnNj3XJmWm2jLcPsu5rLkPDcKxFcu3pZhRJ5BM8";
    expect(planBirth({ ...base, account: "rehearsal.tenderseal.near", addFullAccessKey: pk }, wasm(250_000)).actions[2]).toEqual({ type: "AddKey", publicKey: pk });
  });
  it("the transfer is exact yocto and the code hash is announced", () => {
    const p = planBirth({ ...base, balance: "4.5" }, wasm(250_000));
    expect(p.actions[1]).toEqual({ type: "Transfer", yocto: "4500000000000000000000000" });
    expect(p.checks.join("\n")).toContain("access keys of v1.tenderseal.near: 0");
  });
});

describe("validateInit", () => {
  const good = {
    mpc: "v1.signer", intents: "intents.near", domain_id: 2, app_pk_mode: "identity", mpc_public_key: "bls12381g2:x",
    quote_tokens: ["nep141:usdc"], sellers: ["tenderseal.near"],
  };
  it("accepts a complete new() argument object", () => expect(validateInit(good, "new")).toEqual([]));
  it("rejects the unresolved G-S1 placeholder", () => {
    expect(validateInit({ ...good, app_pk_mode: "<identity|generator|plain>" }, "new")[0]).toMatch(/G-S1/);
  });
  it("names every missing field", () => {
    expect(validateInit({}, "new")).toHaveLength(7);
    expect(validateInit({}, "ping")).toEqual([]);
  });
});

describe("dry-run format", () => {
  it("matches the step contract", () => {
    const specs = planBirth(base, wasm(250_000)).actions;
    const [h, l1, l2, l3] = formatPlan(base, specs).split("\n");
    expect(h).toBe("DRY-RUN · nothing sent · re-run with --yes to send");
    expect(l1).toMatch(/^\[1\/1\] signer=\S+ receiver=\S+ method=\S+ deposit=.+ gas=\d+ Tgas$/);
    expect(l2).toMatch(/^ {6}args=/);
    expect(l3).toMatch(/^ {6}near-cli: near transaction construct-transaction tenderseal\.near v1\.tenderseal\.near add-action create-account/);
  });
  it("--yes prints SENDING, never 'nothing sent', above the irreversible birth", () => {
    const yes = { ...base, yes: true };
    const [h] = formatPlan(yes, planBirth(yes, wasm(250_000)).actions).split("\n");
    expect(h).toMatch(/^SENDING · --yes/);
  });
});

describe("configDiff", () => {
  const init = {
    mpc: "v1.signer", intents: "intents.near", domain_id: 2, app_pk_mode: "identity", mpc_public_key: "bls12381g2:x",
    quote_tokens: ["nep141:usdc"], sellers: ["tenderseal.near"],
  };
  const cfg = { ...init, domain_id: "2", version: "1.0.0", init_block: "1", init_ns: "1", sales: "0", key_log_len: "0" };
  it("domain_id 2 in new() and \"2\" in get_config is no difference", () => expect(configDiff(init, cfg)).toEqual([]));
  it("names every argument that differs", () => expect(configDiff(init, { ...cfg, domain_id: "3", sellers: ["x.near"] })).toEqual(["domain_id", "sellers"]));
});
