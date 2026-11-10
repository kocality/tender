// Manual live smoke test (not run by vitest): reads public MPC views on mainnet.
//   pnpm --filter @tender/cli exec tsx test/live.smoke.ts   →   v1.signer 3.18.0 · threshold 11 of 16
import { resolveNetwork } from '../src/lib/config.js';
import { Rpc } from '../src/lib/rpc.js';
import { MpcViews } from '../src/lib/views.js';

const net = resolveNetwork({});
const rpc = new Rpc(net.rpc);
const mpc = new MpcViews(rpc, net.mpc);
const block = (await rpc.finalBlock()).height;
const [version, state] = await Promise.all([mpc.version(block), mpc.state(block)]);
console.log(`${net.mpc} ${version} · threshold ${state.threshold} of ${state.participants}`);
console.error(`block ${block} via ${rpc.lastProvider} (${state.status})`);
