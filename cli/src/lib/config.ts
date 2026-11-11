// The single place for CLI network defaults. Priority: flag > env > default.
import type { AppPkMode } from '@tender/seal';

export type Network = 'mainnet' | 'testnet';

export interface NetworkDefaults {
  rpc: string[];
  archival: string[];
  nearblocks: string;
  explorer: string;
  mpc: string;
  contract: string | null;
}

export const NETWORKS: Record<Network, NetworkDefaults> = {
  mainnet: {
    // Three independent keyless providers, FastNEAR first (OPS-04); rpc.mainnet.near.org answers 429 "deprecated".
    rpc: ['https://free.rpc.fastnear.com', 'https://near.drpc.org', 'https://rpc.shitzuapes.xyz'],
    archival: ['https://archival-rpc.mainnet.fastnear.com', 'https://archival-rpc.mainnet.near.org'],
    nearblocks: 'https://api.nearblocks.io',
    explorer: 'https://nearblocks.io',
    mpc: 'v1.signer',
    contract: 'v1.tenderseal.near',
  },
  testnet: {
    rpc: ['https://test.rpc.fastnear.com', 'https://near-testnet.drpc.org', 'https://testnet-rpc.intea.rs'],
    archival: ['https://archival-rpc.testnet.fastnear.com', 'https://archival-rpc.testnet.near.org'],
    nearblocks: 'https://api-testnet.nearblocks.io',
    explorer: 'https://testnet.nearblocks.io',
    mpc: 'v1.signer-prod.testnet',
    contract: null,
  },
};

/** code_hash of contract/tests/res/defuse-0.4.5.wasm, the intents.near code the sandbox tests run against. */
export const TESTED_INTENTS_CODE_HASH = 'BtA1BEFNS619KkvXFsgcpQ21Tb5yMm32aaUkn7xNothk';
/** v1.signer version the S1/S6 spikes and the testnet runs used. */
export const TESTED_MPC_VERSION = '3.18.0';

/** App key mode of demo:local and the test worlds: generator, the mode sales/v1-init.json gives new() (CRYPTO-07). */
export const DEMO_APP_PK_MODE: AppPkMode = 'generator';

export interface ResolvedNetwork {
  network: Network;
  rpc: string[];
  archival: string[];
  nearblocks: string;
  nearblocksApiKey: string | undefined;
  explorer: string;
  mpc: string;
  contract: string;
}

/** Trimmed, without a trailing slash, empty entries dropped, first occurrence kept. */
function urlList(urls: (string | undefined)[]): string[] {
  return [...new Set(urls.map((u) => (u ?? '').trim().replace(/\/+$/, '')).filter(Boolean))];
}

export function resolveNetwork(
  opts: { network?: string; contract?: string; rpc?: string; archivalRpc?: string },
  env: Record<string, string | undefined> = process.env,
): ResolvedNetwork {
  const network = (opts.network ?? 'mainnet') as Network;
  const d = NETWORKS[network];
  if (!d) throw new Error(`unknown network "${opts.network}" (mainnet|testnet)`);
  const contract = opts.contract ?? env.TENDER_CONTRACT_ID ?? d.contract;
  if (!contract) throw new Error(`--contract is required on ${network}`);
  // A flag is the only provider. Env URLs (.env.example names mainnet ones NEAR_*, the testnet one NEAR_TESTNET_*)
  // go first for their own network and keep the defaults behind them for failover.
  const mainnet = network === 'mainnet';
  const envRpc = mainnet ? [env.NEAR_RPC_URL, ...(env.NEAR_RPC_FALLBACKS ?? '').split(',')] : [env.NEAR_TESTNET_RPC_URL];
  const envArchival = mainnet ? [env.NEAR_ARCHIVAL_RPC_URL, ...(env.NEAR_ARCHIVAL_RPC_FALLBACKS ?? '').split(',')] : [];
  return {
    network,
    rpc: opts.rpc ? [opts.rpc] : urlList([...envRpc, ...d.rpc]),
    archival: opts.archivalRpc ? [opts.archivalRpc] : urlList([...envArchival, ...d.archival]),
    nearblocks: d.nearblocks,
    nearblocksApiKey: env.NEARBLOCKS_API_KEY || undefined,
    explorer: d.explorer,
    mpc: d.mpc,
    contract,
  };
}
