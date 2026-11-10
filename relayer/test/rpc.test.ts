import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RPC, decodeSuccessValue, rpcCall, rpcHooks, txStatus } from "../scripts/lib/rpc.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const [N1, N2] = RPC.mainnet.normal as [string, string];
const A1 = RPC.mainnet.archival[0] as string;

let calls: string[];
function mockFetch(handler: (url: string) => Response) {
  calls = [];
  vi.stubGlobal("fetch", async (url: string) => {
    calls.push(url);
    return handler(url);
  });
}

beforeEach(() => {
  vi.spyOn(rpcHooks, "sleep").mockResolvedValue(undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("rpcCall", () => {
  it("backs off on 429 and moves to the second URL", async () => {
    mockFetch((url) => (url === N1 ? json({}, 429) : json({ jsonrpc: "2.0", id: "x", result: { ok: 1 } })));
    const out = await rpcCall<{ ok: number }>("mainnet", "status", []);
    expect(out).toEqual({ result: { ok: 1 }, url: N2 });
    expect(calls.filter((u) => u === N1)).toHaveLength(3);
    expect(rpcHooks.sleep).toHaveBeenCalledWith(1000);
    expect(rpcHooks.sleep).toHaveBeenCalledWith(2000);
  });

  it("falls through to archival on UNKNOWN_TRANSACTION and reports the source", async () => {
    const unknown = { error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_TRANSACTION", info: {} } } };
    mockFetch((url) => (url === A1 ? json({ result: { status: { SuccessValue: "" } } }) : json(unknown)));
    const out = await txStatus("mainnet", "H", "alice.near");
    expect(out.source).toBe("archival");
    expect(out.url).toBe(A1);
    expect(calls).toEqual([N1, N2, A1]); // no retries on UNKNOWN_*
  });

  it("serves from the normal node first (source rpc)", async () => {
    mockFetch(() => json({ result: { status: { SuccessValue: "" } } }));
    expect((await txStatus("mainnet", "H", "alice.near")).source).toBe("rpc");
  });

  it("throws immediately on a real RPC error", async () => {
    mockFetch(() => json({ error: { name: "REQUEST_VALIDATION_ERROR", cause: { name: "PARSE_ERROR" } } }));
    await expect(rpcCall("mainnet", "block", {})).rejects.toThrow(/PARSE_ERROR/);
    expect(calls).toHaveLength(1);
  });

  it("gives up with the last error when every URL fails", async () => {
    mockFetch(() => json({}, 503));
    await expect(rpcCall("mainnet", "status", [])).rejects.toThrow(/HTTP 503/);
  });
});

describe("decodeSuccessValue", () => {
  it("decodes base64 JSON from a status or a whole result", () => {
    const b64 = Buffer.from('{"big_y":"a","big_c":"b"}').toString("base64");
    expect(decodeSuccessValue({ SuccessValue: b64 })).toBe('{"big_y":"a","big_c":"b"}');
    expect(decodeSuccessValue({ status: { SuccessValue: b64 } })).toBe('{"big_y":"a","big_c":"b"}');
  });
  it("returns null for empty or failed statuses", () => {
    expect(decodeSuccessValue({ SuccessValue: "" })).toBeNull();
    expect(decodeSuccessValue({ Failure: {} })).toBeNull();
    expect(decodeSuccessValue(undefined)).toBeNull();
  });
});
