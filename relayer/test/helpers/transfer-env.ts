import { KeyPair } from "near-api-js";
import type { MultiPayload } from "@tender/intents";
import type { CallStep } from "../../scripts/lib/cli.js";
import type { KeyPairString } from "../../scripts/lib/keys.js";
import type { Sent } from "../../scripts/lib/send.js";
import type { RecordRow, TransferEnv } from "../../scripts/lib/transfer.js";

// A TransferEnv with no network: a random key, a fixed salt, balances kept in a map, every call logged.

export const NOW_MS = Date.parse("2026-11-10T12:00:00Z");

export interface FakeBase {
  env: TransferEnv;
  secret: KeyPairString | null;
  publicKey: string | null;
  log: string[];
  balances: Map<string, bigint>; // `${account}|${token}`
  keys: { v: string[] };
  recorded: RecordRow[];
  sentIntents: MultiPayload[];
  sentCalls: CallStep[];
  simulated: MultiPayload[];
  hooks: {
    execute?: (signer: string, mp: MultiPayload) => Promise<Sent> | Sent;
    call?: (step: CallStep) => Promise<Sent> | Sent;
    simulate?: () => { ok: true } | { ok: false; kind: string; message: string };
  };
}

export const bal = (b: FakeBase, account: string, token: string) => b.balances.get(`${account}|${token}`) ?? 0n;
export const setBal = (b: FakeBase, account: string, token: string, v: bigint) => void b.balances.set(`${account}|${token}`, v);
export const addBal = (b: FakeBase, account: string, token: string, d: bigint) => setBal(b, account, token, bal(b, account, token) + d);

export function sent(hash: string, ok = true, logs: string[] = []): Sent {
  return { hash, ok, block: 100, status: ok ? { SuccessValue: "" } : { Failure: {} }, logs };
}

export function fakeBase(o: { withKey?: boolean; registered?: boolean } = {}): FakeBase {
  const kp = o.withKey === false ? null : KeyPair.fromRandom("ed25519");
  const b: FakeBase = {
    env: undefined as unknown as TransferEnv,
    secret: kp ? (kp.toString() as KeyPairString) : null,
    publicKey: kp ? kp.getPublicKey().toString() : null,
    log: [],
    balances: new Map(),
    keys: { v: kp && o.registered !== false ? [kp.getPublicKey().toString()] : [] },
    recorded: [],
    sentIntents: [],
    sentCalls: [],
    simulated: [],
    hooks: {},
  };
  b.env = {
    nowMs: async () => NOW_MS,
    balance: async (_i, account, token) => bal(b, account, token),
    intentsKeys: async () => b.keys.v,
    currentSalt: async () => "252812b3",
    simulate: async (_i, mp) => {
      b.simulated.push(mp);
      return b.hooks.simulate ? b.hooks.simulate() : { ok: true };
    },
    secretKey: () => b.secret,
    executeIntents: async (signer, _i, mp) => {
      b.log.push("executeIntents");
      b.sentIntents.push(mp);
      return b.hooks.execute ? b.hooks.execute(signer, mp) : sent("EXEC1");
    },
    call: async (step) => {
      b.log.push(`call ${step.method}`);
      b.sentCalls.push(step);
      return b.hooks.call ? b.hooks.call(step) : sent(`CALL-${step.method}`);
    },
    record: async (row) => {
      b.recorded.push(row);
    },
    sleep: async () => {},
  };
  return b;
}

/** The first intent of a nep413 MultiPayload. */
export function firstIntent(mp: MultiPayload): any {
  if (mp.standard !== "nep413") throw new Error("expected nep413");
  return JSON.parse(mp.payload.message).intents[0];
}
