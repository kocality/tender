import { pathToFileURL } from "node:url";
import { getSale, type SaleView } from "./lib/views.js";

// Read-only watcher for the days of sale 2 (run hourly by .github/workflows/watch.yml, no secrets):
// a dropped cron run, a drained relayer, a dead app or relay and a stuck sale all end as a red run, which e-mails the repo owner.

const MIN_NEAR = 350_000_000_000_000_000_000_000n; // 0.35 NEAR: the relay stops at 0.31 NEAR, this leaves time to top it up
const OPEN_GRACE_MS = 30 * 60_000; // keeper cron ticks every 10 minutes from the close
const FINALIZE_GRACE_MS = 60 * 60_000;

export interface Snapshot {
  relay: { status: number; health?: { allowance?: string | null; balance?: string | null; unknown?: boolean } } | { error: string } | null; // null = RELAY_URL not set
  app: { status: number } | { error: string } | null; // null = APP_URL not set
  sale: SaleView | null | { error: string }; // null = no such sale or contract (yet); error = get_sale could not be read
}

const NO_CONTRACT = /UNKNOWN_ACCOUNT|CodeDoesNotExist|does not exist/;

const near = (y: bigint) => (Number(y / 10n ** 20n) / 10_000).toString();

/** Pure: why the run should be red, `[]` when everything is fine. */
export function evaluate(s: Snapshot, nowMs: number): string[] {
  const out: string[] = [];
  if (s.relay === null) out.push("RELAY_URL is not set (repository variable)");
  else if ("error" in s.relay) out.push(`relay does not answer: ${s.relay.error}`);
  else if (s.relay.status !== 200) out.push(`relay GET answered ${s.relay.status}`);
  else if (!s.relay.health?.unknown) {
    const { allowance, balance } = s.relay.health ?? {};
    if (allowance != null && BigInt(allowance) < MIN_NEAR) out.push(`relay allowance ${near(BigInt(allowance))} NEAR is below 0.35`);
    if (balance != null && BigInt(balance) < MIN_NEAR) out.push(`relay balance ${near(BigInt(balance))} NEAR is below 0.35`);
  }

  if (s.app === null) out.push("APP_URL is not set (repository variable)");
  else if ("error" in s.app) out.push(`app does not answer: ${s.app.error}`);
  else if (s.app.status !== 200) out.push(`app answered ${s.app.status}`);

  const sale = s.sale;
  if (sale && "error" in sale) out.push(`get_sale of sale ${sale.error}`);
  else if (sale) {
    const close = Number(BigInt(sale.close_ns) / 1_000_000n);
    if (sale.state === "Open" && nowMs > close + OPEN_GRACE_MS) out.push(`sale ${sale.id} is still Open ${Math.round((nowMs - close) / 60_000)} minutes after its close`);
    if (sale.state === "Keyed" && sale.reveal_deadline_ns !== null && nowMs > Number(BigInt(sale.reveal_deadline_ns) / 1_000_000n) + FINALIZE_GRACE_MS) {
      out.push(`sale ${sale.id} is still Keyed more than 1 hour after its reveal deadline`);
    }
    if ((sale.state === "Finalized" || sale.state === "Cancelled") && sale.payouts_done < sale.payouts_total) out.push(`sale ${sale.id} is ${sale.state} with ${sale.payouts_done}/${sale.payouts_total} payouts done`);
  }
  return out;
}

async function get(url: string | undefined): Promise<{ status: number; body: unknown } | { error: string } | null> {
  if (!url) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    return { status: res.status, body };
  } catch (e) {
    return { error: (e as Error).message.split("\n")[0] ?? "request failed" };
  }
}

export async function main(env: NodeJS.ProcessEnv = process.env, nowMs = Date.now()): Promise<number> {
  const relay = await get(env.RELAY_URL);
  const app = await get(env.APP_URL);
  const id = env.WATCH_SALE || "2";
  // Only a contract that does not exist yet reads as "not created yet"; an outage or a 429 must not look green.
  const sale = await getSale("mainnet", env.TENDER_CONTRACT_ID || "v1.tenderseal.near", id).catch((e: Error) =>
    NO_CONTRACT.test(e.message) ? null : { error: `${id} failed: ${e.message.split("\n")[0]}` },
  );
  const snap: Snapshot = {
    relay: relay === null || "error" in relay ? relay : { status: relay.status, health: relay.body as never },
    app: app === null || "error" in app ? app : { status: app.status },
    sale,
  };
  const problems = evaluate(snap, nowMs);
  if (problems.length === 0) {
    console.log(`watch ok · sale ${sale && !("error" in sale) ? `${sale.id} ${sale.state}` : "not created yet"}`);
    return 0;
  }
  for (const p of problems) console.log(`PROBLEM ${p}`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
