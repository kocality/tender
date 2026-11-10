import { createWalletClient, custom, recoverMessageAddress, type EIP1193Provider } from 'viem';
import { erc191FromWallet, evmSignerId, payloadString } from '@tender/intents';
import { WalletError, type IntentSigner } from './types';

// Signing only: no chain switching, no transaction sending (U6). The signature is chain independent;
// the origin (Base or Arbitrum) is only a badge and the 1Click origin asset.

interface Eip6963Detail {
  info: { uuid: string; name: string; icon: string; rdns: string };
  provider: EIP1193Provider;
}

/** EIP-6963 discovery. Phantom also injects window.ethereum, so MetaMask must be found by rdns, not by the global. */
export function discoverEvmProviders(waitMs = 300): Promise<Eip6963Detail[]> {
  return new Promise((resolve) => {
    const found = new Map<string, Eip6963Detail>();
    const onAnnounce = (ev: Event) => {
      const detail = (ev as CustomEvent<Eip6963Detail>).detail;
      if (detail?.info?.uuid && detail.provider) found.set(detail.info.uuid, detail);
    };
    window.addEventListener('eip6963:announceProvider', onAnnounce);
    window.dispatchEvent(new Event('eip6963:requestProvider'));
    setTimeout(() => {
      window.removeEventListener('eip6963:announceProvider', onAnnounce);
      resolve([...found.values()]);
    }, waitMs);
  });
}

export async function pickEvmProvider(): Promise<EIP1193Provider> {
  const found = await discoverEvmProviders();
  const metamask = found.find((d) => d.info.rdns === 'io.metamask');
  if (metamask) return metamask.provider;
  if (found[0]) return found[0].provider;
  const injected = (window as unknown as { ethereum?: EIP1193Provider }).ethereum;
  if (injected) return injected;
  throw new WalletError('No EVM wallet found. Install MetaMask and reload.');
}

export async function connectEvm(origin: 'base' | 'arb'): Promise<IntentSigner> {
  const provider = await pickEvmProvider();
  const client = createWalletClient({ transport: custom(provider) });
  const [address] = await client.requestAddresses();
  if (!address) throw new WalletError('The wallet returned no account.');
  return {
    kind: 'evm',
    signerId: evmSignerId(address),
    origin,
    async sign(p) {
      const str = payloadString(p);
      const sig = await client.signMessage({ account: address, message: str });
      // MetaMask signs with its selected account, which may no longer be the one connected here.
      const by = await recoverMessageAddress({ message: str, signature: sig });
      if (evmSignerId(by) !== evmSignerId(address)) {
        throw new WalletError(`The wallet signed as ${evmSignerId(by)}, not ${evmSignerId(address)}, the account connected here. Reconnect the wallet and sign again.`);
      }
      return erc191FromWallet(str, sig);
    },
  };
}
