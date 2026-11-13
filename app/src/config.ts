// Single source of app configuration. Defaults are mainnet; rehearsal and testnet override via VITE_* env.
// Defaults below are public mainnet contract ids; every account name can be overridden by env.
// quote token, mpc_public_key and app_pk_mode are always read live from get_config(), never from env.

function str(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : fallback;
}

function list(v: unknown, fallback: string[]): string[] {
  if (typeof v !== 'string' || v.trim() === '') return fallback;
  return v
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

const env = import.meta.env;

const network: 'mainnet' | 'testnet' = env.VITE_NETWORK === 'testnet' ? 'testnet' : 'mainnet';
// Three independent keyless providers per network (OPS-04); rpc.{mainnet,testnet}.near.org answer HTTP 429 and are not listed.
const DEFAULT_RPCS = {
  mainnet: ['https://free.rpc.fastnear.com', 'https://near.drpc.org', 'https://rpc.shitzuapes.xyz'],
  testnet: ['https://test.rpc.fastnear.com', 'https://near-testnet.drpc.org', 'https://testnet-rpc.intea.rs'],
};
const rpcUrl = str(env.VITE_NEAR_RPC_URL, DEFAULT_RPCS[network][0]!);
const rpcFallbacks = list(env.VITE_NEAR_RPC_FALLBACKS, DEFAULT_RPCS[network]);
const tenderContractId = str(env.VITE_TENDER_CONTRACT_ID, 'v1.tenderseal.near');

export interface AppConfig {
  network: 'mainnet' | 'testnet';
  /** Primary first, then fallbacks (the order `@tender/intents` tries them in). */
  rpcUrls: string[];
  tenderContractId: string;
  intentsContractId: string;
  mpcContractId: string;
  /** Receiver of the free "Try signing" bid. Before the lock this may be the spike account. */
  tryReceiver: string;
  /** Full relay endpoint (…/relay). Empty string = not configured. */
  relayerUrl: string;
  oneClickApiUrl: string;
  /** Sale ids shown on the twin view, in order (left, right). */
  twinSales: [string, string];
  /** Accounts of the team: a sale sold by one of them is labelled "team-funded demo sale". */
  teamAccounts: string[];
  /** Sale ids the team configured to miss their open thresholds on purpose (labelled on the twin view). */
  demoFailSales: string[];
  nearblocksApiUrl: string;
  explorerUrl: string;
  /** Public repository URL; empty while the repository is private (the footer then shows no source link). */
  repoUrl: string;
  /** The twin sales run on an earlier build of the contract (the T1 testnet copy): the home page says so. */
  earlierBuild: boolean;
}

function twinSales(v: unknown): [string, string] {
  const ids = list(v, ['1', '0']).filter((s) => /^\d+$/.test(s));
  return [ids[0] ?? '1', ids[1] ?? '0'];
}

export const config: AppConfig = {
  network,
  rpcUrls: [rpcUrl, ...rpcFallbacks.filter((u) => u !== rpcUrl)],
  tenderContractId,
  intentsContractId: str(env.VITE_INTENTS_CONTRACT_ID, 'intents.near'),
  mpcContractId: str(env.VITE_MPC_CONTRACT_ID, 'v1.signer'),
  tryReceiver: str(env.VITE_TRY_RECEIVER, tenderContractId),
  relayerUrl: str(env.VITE_RELAYER_URL, ''),
  oneClickApiUrl: str(env.VITE_ONECLICK_API_URL, 'https://1click.chaindefuser.com'),
  twinSales: twinSales(env.VITE_TWIN_SALES),
  teamAccounts: list(env.VITE_TEAM_ACCOUNTS, ['tenderseal.near']),
  demoFailSales: list(env.VITE_DEMO_FAIL_SALES, network === 'mainnet' ? ['0'] : []).filter((s) => /^\d+$/.test(s)),
  nearblocksApiUrl: str(env.VITE_NEARBLOCKS_API_URL, network === 'testnet' ? 'https://api-testnet.nearblocks.io/v3' : 'https://api.nearblocks.io/v3'),
  explorerUrl: str(env.VITE_EXPLORER_URL, network === 'testnet' ? 'https://testnet.nearblocks.io' : 'https://nearblocks.io'),
  repoUrl: str(env.VITE_REPO_URL, '').replace(/\/+$/, ''),
  earlierBuild: env.VITE_EARLIER_BUILD === '1',
};
