import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(new URL(`../../${rel}`, import.meta.url), "utf8");
const keeper = read(".github/workflows/keeper.yml");
const watch = read(".github/workflows/watch.yml");

describe("workflows that hold or touch the live keeper (X12-04, CI-09, X12-05)", () => {
  for (const [name, text] of [["keeper.yml", keeper], ["watch.yml", watch]] as const) {
    it(`${name}: every action is pinned to a commit SHA, not a tag`, () => {
      const uses = [...text.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)].map((m) => m[1] as string);
      expect(uses.length).toBeGreaterThan(0);
      for (const u of uses) expect(u).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
    });
    it(`${name}: scheduled runs outside 2026 are skipped by a guard job`, () => {
      expect(text).toMatch(/date -u \+%Y\)" != "2026"/);
      expect(text).toMatch(/\n  \w+:\n    needs: guard\n    if: needs\.guard\.outputs\.live == 'true'/);
    });
  }
  it("keeper.yml: the manual dry run also checks the key (a green Friday run must mean the secret works)", () => {
    expect(keeper).toMatch(/--dry-run --check-key/);
  });
  it("watch.yml has no access to secrets", () => expect(watch).not.toMatch(/secrets\./));
  it("keeper.yml: the schedule reaches the worst-case finalize of sale 2 (close, open at +24 h, reveal window, plus a day of retries)", () => {
    const sale = JSON.parse(read("sales/2.json")) as { close: { utc: string }; msg: { reveal_secs: string } };
    const worst = Date.parse(sale.close.utc) + 86_400_000 + Math.max(Number(sale.msg.reveal_secs), 86_400) * 1000 + 86_400_000;
    const days = [...keeper.matchAll(/cron:\s*'([^']+)'/g)].map((m) => (m[1] as string).split(" ")[2] as string);
    const last = Math.max(...days.flatMap((d) => d.split(",").flatMap((r) => r.split("-").map(Number))));
    expect(Date.parse(`2026-11-${last}T23:59:59Z`)).toBeGreaterThanOrEqual(worst);
  });
});

describe("relayer/vercel.json (X12-06, OPS-10)", () => {
  const v = JSON.parse(read("relayer/vercel.json")) as { installCommand: string; rewrites: Array<{ source: string; destination: string }>; functions: Record<string, { maxDuration: number }>; outputDirectory: string };
  it("installs with the pinned pnpm and the frozen lockfile, so dependency build scripts stay denied", () => {
    expect(v.installCommand).toMatch(/pnpm@12\.18\.0/);
    expect(v.installCommand).toMatch(/--frozen-lockfile/);
    expect(v.installCommand).toMatch(/--filter @tender\/relayer\.\.\./);
  });
  it("/relay is rewritten to the function, which may run 60 s; the output folder exists", () => {
    expect(v.rewrites).toContainEqual({ source: "/relay", destination: "/api/relay" });
    expect(v.functions["api/relay.ts"]?.maxDuration).toBe(60);
    expect(existsSync(new URL(`../${v.outputDirectory}/index.html`, import.meta.url))).toBe(true);
  });
  it("app/vercel.json pins the same pnpm", () => expect(read("app/vercel.json")).toMatch(/pnpm@12\.18\.0/));
});
