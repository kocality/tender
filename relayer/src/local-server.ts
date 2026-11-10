import { createServer, type IncomingMessage, type Server } from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRelayHandler, nearDepsFromEnv, type RelayConfig, type RelayDeps } from "./relay.js";

// `pnpm relay:local`: the same handler as the Vercel function, on your machine, with your own relayer key.
// It listens on 127.0.0.1 only (RELAY_HOST to change it) and takes the client address from the socket, never from x-forwarded-for.

/** Origins of the app on this machine (`pnpm dev` 5173, `pnpm preview` 4173), allowed unless RELAY_ALLOWED_ORIGINS says otherwise. */
export const LOCAL_ORIGINS = "http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173,http://127.0.0.1:4173";

/** `relay:local` environment: the local app origins unless RELAY_ALLOWED_ORIGINS is set. */
export const withLocalDefaults = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({ ...env, RELAY_ALLOWED_ORIGINS: env.RELAY_ALLOWED_ORIGINS ?? LOCAL_ORIGINS });

function toRequest(req: IncomingMessage, body: Buffer): Request {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
  const hasBody = req.method !== "GET" && req.method !== "HEAD" && body.length > 0;
  return new Request(`http://localhost${req.url ?? "/"}`, { method: req.method, headers, body: hasBody ? new Uint8Array(body) : undefined });
}

export function createLocalServer(cfg: RelayConfig, deps: RelayDeps): Server {
  const peers = new WeakMap<Request, string>();
  const handle = createRelayHandler(cfg, { ...deps, ipOf: (r) => peers.get(r) ?? "unknown" });
  return createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > 65536) break; // the handler answers 413 for anything above 16 KB
      chunks.push(c as Buffer);
    }
    try {
      const request = toRequest(req, Buffer.concat(chunks));
      peers.set(request, req.socket.remoteAddress ?? "unknown");
      const r = await handle(request);
      res.writeHead(r.status, Object.fromEntries(r.headers));
      res.end(Buffer.from(await r.arrayBuffer()));
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "internal", detail: String((e as Error).message).split("\n")[0] }));
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.loadEnvFile(fileURLToPath(new URL("../../.env", import.meta.url)));
  } catch {
    // no .env: use the process environment
  }

  const env = withLocalDefaults(process.env);
  const network = (env.NEAR_NETWORK ?? env.TENDER_NETWORK) === "testnet" ? "testnet" : "mainnet";
  if (!env.RELAYER_PRIVATE_KEY) {
    // the key lives in the near-cli keychain on a developer machine
    try {
      const { loadKeyPair } = await import("../scripts/lib/keys.js");
      env.RELAYER_PRIVATE_KEY = loadKeyPair(network, env.RELAYER_ACCOUNT_ID || "relayer.tenderseal.near", { publicKey: env.RELAYER_PUBLIC_KEY || undefined });
    } catch (e) {
      console.warn(`WARN ${(e as Error).message}\nWARN no relayer key: GET and the simulate step work, a POST that passes simulation answers 503 "relayer key is not configured".`);
    }
  }
  const { cfg, deps } = nearDepsFromEnv(env);
  const port = Number(env.RELAY_PORT ?? 8787);
  const host = env.RELAY_HOST || "127.0.0.1";
  createLocalServer(cfg, deps).listen(port, host, () => {
    console.log(`relay:local listening on http://${host}:${port}/relay · relayer=${env.RELAYER_ACCOUNT_ID || "relayer.tenderseal.near"} · intents=${cfg.intentsId} · network=${network}`);
  });
}
