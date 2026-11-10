// Mainnet, free: the real simulate_intents view with a random key; execute is faked, nothing is sent.
// Run: RUN_NETWORK_TESTS=1 pnpm --filter @tender/relayer test relay.network
import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  bidMsg, buildPayload, buildVersionedNonce, currentSalt, makeDeadline, payloadString, rawEd25519FromWallet, solanaSignerId, toBase64, transferIntent,
} from "@tender/intents";
import { createRelayHandler, nearDepsFromEnv } from "../src/relay.js";

const RPC = ["https://free.rpc.fastnear.com", "https://rpc.mainnet.near.org"];
const USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

async function signedBid(tamper: boolean) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pk = new Uint8Array(Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url"));
  const salt = await currentSalt(RPC, "intents.near");
  const { deadlineMs, deadlineIso } = makeDeadline();
  const payload = buildPayload({
    signerId: solanaSignerId(pk),
    verifyingContract: "intents.near",
    deadlineIso,
    nonce: buildVersionedNonce({ saltHex: salt, deadlineMs }),
    intents: [transferIntent({ receiverId: "v1.tenderseal.near", tokenId: USDC, amount: 1_000_000n, msg: bidMsg({ sale: "1", ct: toBase64(new Uint8Array(160)), cm: "00".repeat(32), origin: "sol" }) })],
  });
  const text = payloadString(payload);
  const sig = new Uint8Array(sign(null, Buffer.from(text), privateKey));
  if (tamper) sig[0] = (sig[0] as number) ^ 1;
  return rawEd25519FromWallet(text, pk, sig);
}

describe.skipIf(!process.env.RUN_NETWORK_TESTS)("relay against mainnet simulate_intents", () => {
  const { cfg, deps } = nearDepsFromEnv({ NEAR_NETWORK: "mainnet" });
  let executed = 0;
  const handle = createRelayHandler(cfg, {
    ...deps,
    execute: async () => { executed++; return { txHash: "FAKE", ok: true }; },
    health: async () => ({ relayer: "fake", allowance: null, node: process.version, network: "mainnet", intents: "intents.near" }),
    log: () => {},
  });
  const post = (signed: unknown) => handle(new Request("http://localhost/relay", { method: "POST", body: JSON.stringify({ signed: [signed] }) }));

  it("valid signature, random key: 400 simulate_failed with insufficient balance", async () => {
    const r = await post(await signedBid(false));
    const j = await r.json();
    expect(r.status).toBe(400);
    expect(j.error).toBe("simulate_failed");
    expect(j.detail).toContain("insufficient balance");
    expect(executed).toBe(0);
  }, 60_000);

  it("tampered signature: 400 invalid signature", async () => {
    const r = await post(await signedBid(true));
    const j = await r.json();
    expect(r.status).toBe(400);
    expect(j.detail).toContain("invalid signature");
    expect(executed).toBe(0);
  }, 60_000);
});
