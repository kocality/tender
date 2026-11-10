import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { recordTx } from "../scripts/record.js";

// RUN_NETWORK_TESTS=1: needs the public mainnet RPC (the tx is inside the non-archival window until about 2026-11-10T19:30Z, archival afterwards)
describe.skipIf(!process.env.RUN_NETWORK_TESTS)("record against mainnet", () => {
  it("the known fund tx is block 223833424", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const row = await recordTx({
      network: "mainnet", sale: "ops", step: "fund", txHash: "353gaj2sj4D6u7t1iciJaV467zwFioQdVasenWND6qnJ", signer: "intents.near",
      dryRun: true, evidenceDir: mkdtempSync(join(tmpdir(), "tender-net-")),
    });
    expect(row.block).toBe(223833424);
    expect(row.outcome).toBe("success");
  }, 60_000);
});
