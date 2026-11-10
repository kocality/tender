// Testnet, spends testnet gas and test tokens only. Needs the M3 testnet copies (Intents + mock USDC + a Tender contract with an open sale)
// and a relayer account that holds a function-call key limited to execute_intents on the Intents copy.
//
//   RUN_NETWORK_TESTS=1 TENDER_NETWORK=testnet \
//   INTENTS_CONTRACT_ID=intents-<h>.testnet TENDER_CONTRACT_ID=v1.tender-<h>.testnet TESTNET_USDC_ID=usdc.tender-<h>.testnet \
//   RELAYER_ACCOUNT_ID=<acct> RELAYER_PUBLIC_KEY=ed25519:<fc key> TESTNET_FUNDER=<acct with a keychain key; may mint the mock USDC> \
//   TESTNET_SALE=<open sale id> pnpm --filter @tender/relayer test relay.testnet
import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  bidMsg, buildPayload, buildVersionedNonce, currentSalt, makeDeadline, payloadString, rawEd25519FromWallet, solanaSignerId, toBase64, transferIntent,
} from "@tender/intents";
import { sealBid } from "@tender/seal";
import { createRelayHandler, nearDepsFromEnv } from "../src/relay.js";
import { loadKeyPair } from "../scripts/lib/keys.js";
import { makeAccount, sendStep } from "../scripts/lib/send.js";
import { intentsBalances } from "../scripts/lib/chain.js";
import { getBids, getConfig, getSale } from "../scripts/lib/views.js";

const env = process.env;
const REQUIRED = ["INTENTS_CONTRACT_ID", "TENDER_CONTRACT_ID", "TESTNET_USDC_ID", "RELAYER_ACCOUNT_ID", "RELAYER_PUBLIC_KEY", "TESTNET_FUNDER", "TESTNET_SALE"] as const;
const enabled = !!env.RUN_NETWORK_TESTS && env.TENDER_NETWORK === "testnet" && REQUIRED.every((k) => !!env[k]);

describe.skipIf(!enabled)("relay on testnet: the permissionless /relay path with a function-call key", () => {
  const intents = env.INTENTS_CONTRACT_ID as string;
  const contract = env.TENDER_CONTRACT_ID as string;
  const usdc = env.TESTNET_USDC_ID as string;
  const saleId = env.TESTNET_SALE as string;
  const funder = env.TESTNET_FUNDER as string;
  const B = 2_000_000n;
  const RPC = ["https://test.rpc.fastnear.com", "https://rpc.testnet.near.org"];

  it("deposit to an implicit account, relay its bid: 200 {txHash}, Sealed in get_bids, replay 400, allowance drop printed", async () => {
    // a fresh ed25519 key; its 64-hex public key is the Intents account (D4-15)
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const pk = new Uint8Array(Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url"));
    const bidder = solanaSignerId(pk);

    const f = makeAccount("testnet", funder);
    const call = (receiver: string, method: string, args: object, deposit: string, gas: number) =>
      sendStep(f, { signer: funder, receiver, method, args, deposit, gasTgas: gas, network: "testnet" });
    expect((await call(usdc, "mint", { account_id: funder, amount: B.toString() }, "0 NEAR", 30)).ok).toBe(true);
    const dep = await call(usdc, "ft_transfer_call", { receiver_id: intents, amount: B.toString(), msg: bidder }, "1 yoctoNEAR", 100);
    expect(dep.ok).toBe(true);
    expect((await intentsBalances("testnet", intents, bidder, [`nep141:${usdc}`]))[0]).toBe(B);

    // the bid: seal for the sale, one raw_ed25519 Transfer to the Tender contract
    const config = await getConfig("testnet", contract);
    const sale = await getSale("testnet", contract, saleId);
    expect(sale?.state).toBe("Open");
    const sealed = sealBid({ mpk: config.mpc_public_key, contract, path: (sale as NonNullable<typeof sale>).path, sale: BigInt(saleId), bidder, B, p: 3_500_000n, q: 1_000_000n });
    const { deadlineMs, deadlineIso } = makeDeadline();
    const payload = buildPayload({
      signerId: bidder,
      verifyingContract: intents,
      deadlineIso,
      nonce: buildVersionedNonce({ saltHex: await currentSalt(RPC, intents), deadlineMs }),
      intents: [transferIntent({ receiverId: contract, tokenId: `nep141:${usdc}`, amount: B, msg: bidMsg({ sale: saleId, ct: sealed.ct_b64, cm: sealed.cm_hex, origin: "sol" }) })],
    });
    const text = payloadString(payload);
    const signed = rawEd25519FromWallet(text, pk, new Uint8Array(sign(null, Buffer.from(text), privateKey)));

    // the relayer: a function-call key from the keychain, real simulate, real execute
    const relayerKey = loadKeyPair("testnet", env.RELAYER_ACCOUNT_ID as string, { publicKey: env.RELAYER_PUBLIC_KEY });
    const { cfg, deps } = nearDepsFromEnv({ ...env, NEAR_NETWORK: "testnet", RELAYER_PRIVATE_KEY: relayerKey });
    const handle = createRelayHandler(cfg, { ...deps, log: () => {} });
    const get = async () => (await (await handle(new Request("http://localhost/relay"))).json()) as { allowance: string | null };
    const post = () => handle(new Request("http://localhost/relay", { method: "POST", body: JSON.stringify({ signed: [signed] }) }));

    const before = await get();
    const r = await post();
    const j = await r.json();
    expect(r.status, JSON.stringify(j)).toBe(200);
    expect(j.txHash).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/);

    let mine;
    for (let i = 0; i < 10 && !mine; i++) {
      mine = (await getBids("testnet", contract, saleId)).find((b) => b.bidder === bidder);
      if (!mine) await new Promise((res) => setTimeout(res, 3000));
    }
    expect(mine?.state).toBe("Sealed");
    expect(mine?.cm).toBe(sealed.cm_hex);

    // the unused part of the prepaid gas comes back to the allowance a few blocks after the call; the dip while it is in flight is ~0.3 NEAR
    await new Promise((res) => setTimeout(res, 15_000));
    const after = await get();
    const drop = before.allowance !== null && after.allowance !== null ? BigInt(before.allowance) - BigInt(after.allowance) : null;
    if (drop !== null) {
      expect(drop).toBeGreaterThan(0n);
      expect(drop).toBeLessThan(10_000_000_000_000_000_000_000n); // < 0.01 NEAR net (measured ~0.00115)
    }
    console.log(`RELAY_TESTNET tx=${j.txHash} bidder=${bidder} bid_idx=${mine?.idx} allowance_before=${before.allowance} allowance_after=${after.allowance} drop_yocto=${drop}`);

    // the same signed payload again: the nonce is used up, simulate says so, nothing is executed
    const again = await post();
    const aj = await again.json();
    expect(again.status).toBe(400);
    expect(aj.error).toBe("simulate_failed");
    expect(String(aj.detail)).toMatch(/nonce/i);
  }, 180_000);
});
