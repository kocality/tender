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
    rpc: ['https://free.rpc.fastnear.com', 'https://rpc.mainnet.near.org'],
    archival: ['https://archival-rpc.mainnet.fastnear.com', 'https://archival-rpc.mainnet.near.org'],
    nearblocks: 'https://api.nearblocks.io',
    explorer: 'https://nearblocks.io',
    mpc: 'v1.signer',
    contract: 'v1.tenderseal.near',
  },
  testnet: {
    rpc: ['https://test.rpc.fastnear.com', 'https://rpc.testnet.near.org'],
    archival: ['https://archival-rpc.testnet.fastnear.com', 'https://archival-rpc.testnet.near.org'],
    nearblocks: 'https://api-testnet.nearblocks.io',
    explorer: 'https://testnet.nearblocks.io',
    mpc: 'v1.signer-prod.testnet',
    contract: null,
  },
};

/** App key mode used by demo:local until G-S1 picks the mainnet mode. */
export const DEMO_APP_PK_MODE: AppPkMode = 'identity';

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

export function resolveNetwork(
  opts: { network?: string; contract?: string; rpc?: string; archivalRpc?: string },
  env: Record<string, string | undefined> = process.env,
): ResolvedNetwork {
  const network = (opts.network ?? 'mainnet') as Network;
  const d = NETWORKS[network];
  if (!d) throw new Error(`unknown network "${opts.network}" (mainnet|testnet)`);
  const contract = opts.contract ?? env.TENDER_CONTRACT_ID ?? d.contract;
  if (!contract) throw new Error(`--contract is required on ${network}`);
  const rpc = opts.rpc ?? env.NEAR_RPC_URL;
  const archival = opts.archivalRpc ?? env.NEAR_ARCHIVAL_RPC_URL;
  return {
    network,
    rpc: rpc ? [rpc] : d.rpc,
    archival: archival ? [archival] : d.archival,
    nearblocks: d.nearblocks,
    nearblocksApiKey: env.NEARBLOCKS_API_KEY || undefined,
    explorer: d.explorer,
    mpc: d.mpc,
    contract,
  };
}
