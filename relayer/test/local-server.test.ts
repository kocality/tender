import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { LOCAL_ORIGINS, createLocalServer, withLocalDefaults } from "../src/local-server.js";
import { SlidingWindowLimiter } from "../src/rate-limit.js";
import { nearDepsFromEnv, type RelayConfig, type RelayDeps } from "../src/relay.js";

const cfg: RelayConfig = { intentsId: "intents.near", tenderId: "v1.tenderseal.near", allowedOrigins: LOCAL_ORIGINS.split(","), maxSigned: 4, maxBodyBytes: 16384, minAllowanceYocto: 310_000_000_000_000_000_000_000n };
const deps: RelayDeps = {
  simulate: async () => ({ ok: true }), execute: async () => ({ txHash: "H", ok: true }), now: () => Date.now(), limiter: new SlidingWindowLimiter(20, 60_000), log: () => {},
  health: async () => ({ relayer: "relayer.tenderseal.near", allowance: "400000000000000000000000", node: "v24", network: "mainnet", intents: "intents.near" }),
};

const servers: ReturnType<typeof createLocalServer>[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});
const start = async (host = "127.0.0.1") => {
  const s = createLocalServer(cfg, { ...deps, limiter: new SlidingWindowLimiter(20, 60_000) });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, host, r));
  return s;
};

describe("relay:local", () => {
  it("RELAY_ALLOWED_ORIGINS defaults to the local app origins and an explicit value wins", () => {
    expect(nearDepsFromEnv(withLocalDefaults({})).cfg.allowedOrigins).toContain("http://localhost:5173");
    expect(nearDepsFromEnv(withLocalDefaults({ RELAY_ALLOWED_ORIGINS: "https://app.example" })).cfg.allowedOrigins).toEqual(["https://app.example"]);
    expect(nearDepsFromEnv({}).cfg.allowedOrigins).toEqual([]); // the hosted function stays closed until the env says otherwise
  });
  it("binds 127.0.0.1 only: not 0.0.0.0, not the LAN address", async () => {
    const s = await start();
    expect((s.address() as AddressInfo).address).toBe("127.0.0.1");
  });
  it("a client that rotates x-forwarded-for still hits the limit (the address comes from the socket)", async () => {
    const s = await start();
    const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}/relay`;
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) statuses.push((await fetch(url, { headers: { "x-forwarded-for": `9.9.9.${i}` } })).status);
    expect(statuses.slice(0, 20).every((x) => x === 200)).toBe(true);
    expect(statuses[20]).toBe(429);
  });
  it("the app on this machine (localhost:5173 and 127.0.0.1:5173) is allowed by default; another origin is not", async () => {
    const s = await start();
    const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}/relay`;
    for (const origin of ["http://localhost:5173", "http://127.0.0.1:5173"]) {
      const r = await fetch(url, { method: "OPTIONS", headers: { origin } });
      expect(r.headers.get("access-control-allow-origin")).toBe(origin);
    }
    expect((await fetch(url, { method: "OPTIONS", headers: { origin: "https://evil.example" } })).headers.get("access-control-allow-origin")).toBeNull();
  });
});
