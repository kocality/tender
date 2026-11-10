// Explorer links are printed, never fetched (nearblocks.io pages answer curl with a Cloudflare 403).
import { type Network, NETWORKS } from './config.js';

export const txUrl = (net: Network, hash: string): string => `${NETWORKS[net].explorer}/txns/${hash}`;
export const accountUrl = (net: Network, id: string): string => `${NETWORKS[net].explorer}/address/${id}`;
export const blockUrl = (net: Network, height: bigint | number | string): string => `${NETWORKS[net].explorer}/blocks/${height}`;
