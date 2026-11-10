import { createServer, type IncomingMessage } from "node:http";
import { fileURLToPath } from "node:url";
import { createRelayHandler, nearDepsFromEnv } from "./relay.js";

// `pnpm relay:local`: the same handler as the Vercel function, on your machine, with your own relayer key.
try {
  process.loadEnvFile(fileURLToPath(new URL("../../.env", import.meta.url)));
} catch {
  // no .env: use the process environment
}

const env: NodeJS.ProcessEnv = { ...process.env };
const network = (env.NEAR_NETWORK ?? env.TENDER_NETWORK) === "testnet" ? "testnet" : "mainnet";
if (!env.RELAYER_PRIVATE_KEY) {
  // the key lives in the near-cli keychain on a developer machine
  try {
    const { loadKeyPair } = await import("../scripts/lib/keys.js");
    env.RELAYER_PRIVATE_KEY = loadKeyPair(network, env.RELAYER_ACCOUNT_ID || "relayer.tenderseal.near", { publicKey: env.RELAYER_PUBLIC_KEY || undefined });
  } catch (e) {
    console.warn(`WARN ${(e as Error).message}\nWARN no relayer key: GET and the simulate step work, a POST that passes simulation answers 502 "relayer key is not configured".`);
  }
}
const { cfg, deps } = nearDepsFromEnv(env);
const handle = createRelayHandler(cfg, deps);
const port = Number(env.RELAY_PORT ?? 8787);

function toRequest(req: IncomingMessage, body: Buffer): Request {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
  const hasBody = req.method !== "GET" && req.method !== "HEAD" && body.length > 0;
  return new Request(`http://localhost${req.url ?? "/"}`, { method: req.method, headers, body: hasBody ? new Uint8Array(body) : undefined });
}

createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 65536) break; // the handler answers 413 for anything above 16 KB
    chunks.push(c as Buffer);
  }
  try {
    const r = await handle(toRequest(req, Buffer.concat(chunks)));
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "internal", detail: String((e as Error).message).split("\n")[0] }));
  }
}).listen(port, () => {
  console.log(`relay:local listening on http://localhost:${port}/relay · relayer=${env.RELAYER_ACCOUNT_ID || "relayer.tenderseal.near"} · intents=${cfg.intentsId} · network=${network}`);
});
