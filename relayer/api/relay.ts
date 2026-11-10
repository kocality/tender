import { createRelayHandler, nearDepsFromEnv } from "../src/relay.js"; // .js suffix on purpose (D4-18)

const { cfg, deps } = nearDepsFromEnv(process.env);
const handle = createRelayHandler(cfg, deps);

export function GET(request: Request) {
  return handle(request);
}
export function POST(request: Request) {
  return handle(request);
}
export function OPTIONS(request: Request) {
  return handle(request);
}
