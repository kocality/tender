import {
  blockTimestampNs, buildPayload, buildVersionedNonce, currentSalt, makeDeadline, mtBalanceOf, simulateIntents, transferIntent,
  type DefusePayload, type MultiPayload,
} from "@tender/intents";
import { signNep413 } from "../bid-nep413.js";
import { intentsPublicKeys } from "./chain.js";
import type { CallStep, Common } from "./cli.js";
import type { SaleTag, Step } from "./evidence.js";
import { loadKeyPair, type KeyPairString } from "./keys.js";
import { RPC } from "./rpc.js";
import { spendableBalance } from "../../src/near.js";
import { gasBalanceProblem, makeAccount, sendStep, type Sent } from "./send.js";

// What the ops scripts that sign one Intents Transfer with a NEAR key (nep413) have in common.

export interface RecordRow { sale: SaleTag; step: Step; txHash: string; signer: string; note?: string; oneclick?: string; contract?: string }

/** Everything that touches the network or a key. Tests pass a fake. */
export interface TransferEnv {
  nowMs(): Promise<number>;
  balance(intents: string, account: string, token: string): Promise<bigint>;
  intentsKeys(intents: string, account: string): Promise<string[]>;
  currentSalt(intents: string): Promise<string>;
  simulate(intents: string, mp: MultiPayload): Promise<{ ok: true } | { ok: false; kind: string; message: string }>;
  /** `null` when the signer has no key on this machine. */
  secretKey(signer: string): KeyPairString | null;
  executeIntents(signer: string, intents: string, mp: MultiPayload): Promise<Sent>;
  call(step: CallStep): Promise<Sent>;
  record(row: RecordRow): Promise<void>;
  sleep(ms: number): Promise<void>;
}

export function liveTransferEnv(c: Common): TransferEnv {
  const urls = c.rpc ? [c.rpc] : RPC[c.network].normal;
  const accounts = new Map<string, ReturnType<typeof makeAccount>>();
  const account = (id: string) => {
    let a = accounts.get(id);
    if (!a) accounts.set(id, (a = makeAccount(c.network, id, c.rpc)));
    return a;
  };
  return {
    nowMs: async () => Number(await blockTimestampNs(urls)) / 1e6,
    balance: (intents, acct, token) => mtBalanceOf(urls, intents, acct, token),
    intentsKeys: (intents, acct) => intentsPublicKeys(c.network, intents, acct),
    currentSalt: (intents) => currentSalt(urls, intents),
    simulate: (intents, mp) => simulateIntents(urls, intents, [mp]),
    secretKey(signer) {
      try {
        return loadKeyPair(c.network, signer);
      } catch (e) {
        if (/^no key for /.test((e as Error).message)) return null;
        throw e;
      }
    },
    async executeIntents(signer, intents, mp) {
      const blocked = gasBalanceProblem(signer, await spendableBalance(urls, signer), 300);
      if (blocked) throw new Error(blocked);
      const step: CallStep = { signer, receiver: intents, method: "execute_intents", args: { signed: [mp] }, deposit: "0 NEAR", gasTgas: 300, network: c.network };
      return sendStep(account(signer), step, c.rpc);
    },
    call: (step) => sendStep(account(step.signer), step, c.rpc),
    async record(row) {
      const { recordTx } = await import("../record.js");
      await recordTx({
        network: c.network, sale: row.sale, step: row.step, txHash: row.txHash, signer: row.signer, contract: row.contract,
        note: row.note, oneclick: row.oneclick, chain: "near",
      });
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

/** One Intents Transfer payload. With `msg` it notifies the receiver (mt_on_transfer) and carries `min_gas`; without, it does not. */
export async function buildTransferPayload(o: {
  signer: string; intents: string; receiver: string; tokenId: string; amount: bigint; msg?: string; saltHex: string; nowMs?: number;
}): Promise<{ payload: DefusePayload; nonce32: Uint8Array }> {
  const { deadlineMs, deadlineIso } = makeDeadline(o.nowMs);
  const nonce32 = buildVersionedNonce({ saltHex: o.saltHex, deadlineMs });
  const intent = transferIntent({ receiverId: o.receiver, tokenId: o.tokenId, amount: o.amount, msg: o.msg });
  const payload = buildPayload({ signerId: o.signer, verifyingContract: o.intents, deadlineIso, nonce: nonce32, intents: [intent] });
  return { payload, nonce32 };
}

/** Builds, signs (nep413 by the signer's own key) and returns the MultiPayload. Requires the key. */
export async function signTransfer(
  env: TransferEnv,
  o: { signer: string; intents: string; receiver: string; tokenId: string; amount: bigint; msg?: string },
): Promise<{ mp: MultiPayload; payload: DefusePayload }> {
  const secret = env.secretKey(o.signer);
  if (!secret) throw new Error(`no key for ${o.signer} (looked in the near-credentials directory)`);
  const { payload, nonce32 } = await buildTransferPayload({ ...o, saltHex: await env.currentSalt(o.intents), nowMs: await env.nowMs() });
  return { mp: await signNep413(secret, o.signer, payload, nonce32), payload };
}
