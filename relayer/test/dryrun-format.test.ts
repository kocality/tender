import { describe, expect, it } from "vitest";
import { DRY_RUN_HEADER, formatDryRunStep, nearCliLine, planHeader, type CallStep } from "../scripts/lib/cli.js";

const step: CallStep = { signer: "tenderseal.near", receiver: "wrap.near", method: "near_deposit", args: {}, deposit: "3 NEAR", gasTgas: 30, network: "mainnet" };

describe("dry-run format", () => {
  it("header", () => expect(DRY_RUN_HEADER).toBe("DRY-RUN · nothing sent · re-run with --yes to send"));
  it("a --yes run never says nothing was sent (the rehearsal saw DRY-RUN right above tx=… status=SuccessValue)", () => {
    expect(planHeader(true)).toBe(DRY_RUN_HEADER);
    expect(planHeader(false)).toBe("SENDING · --yes · the step(s) below are sent now unless a BLOCKED line follows");
    expect(planHeader(false)).not.toMatch(/nothing sent|DRY-RUN/);
  });
  it("step block matches the contract of the cards", () => {
    const [l1, l2, l3] = formatDryRunStep(1, 3, step).split("\n");
    expect(l1).toMatch(/^\[1\/3\] signer=\S+ receiver=\S+ method=\S+ deposit=.+ gas=\d+ Tgas$/);
    expect(l2).toBe("      args={}");
    expect(l3).toBe(
      "      near-cli: near contract call-function as-transaction wrap.near near_deposit json-args '{}' prepaid-gas '30 Tgas' attached-deposit '3 NEAR' sign-as tenderseal.near network-config mainnet sign-with-legacy-keychain send",
    );
  });
  it("refuses json args with a single quote", () => {
    expect(() => nearCliLine({ ...step, args: { msg: "it's" } })).toThrow();
  });
});
