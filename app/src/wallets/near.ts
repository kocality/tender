import { NearConnector, type NearWalletBase } from '@hot-labs/near-connect';
import { fromBase64, nep413FromWallet, nep413Message } from '@tender/intents';
import { config } from '../config';
import nearManifest from './near-manifest.json';
import { WalletError, type IntentSigner } from './types';

type NearManifest = NonNullable<ConstructorParameters<typeof NearConnector>[0]>['manifest'] & object;

// One connector for the whole page. It is created lazily: it registers window listeners,
// which must not happen at import time (tests, server rendering) or on pages that never use NEAR.
let connector: NearConnector | null = null;
let connected: NearWalletBase | null = null;
let connectedSigner: IntentSigner | null = null;

export function getNearConnector(): NearConnector {
  // A curated manifest whose wallet executors are pinned to a commit: the default one is read from a mutable branch and runs unreviewed code as the signer bridge.
  connector ??= new NearConnector({ network: config.network, features: { signMessage: true }, manifest: nearManifest as NearManifest });
  return connector;
}

/** Resolves when the wallet manifest is loaded (1-3 s on first use). Buttons wait on this ("Loading wallets…"). */
export function nearReady(): Promise<void> {
  return getNearConnector().whenManifestLoaded;
}

const ED25519_PREFIX = 'ed25519:';

export async function connectNear(): Promise<IntentSigner> {
  const c = getNearConnector();
  await c.whenManifestLoaded;
  const wallet = await c.connect();
  const [account] = await wallet.getAccounts();
  if (!account) throw new WalletError('The wallet returned no account.');
  connected = wallet;
  connectedSigner = {
    kind: 'near',
    signerId: account.accountId,
    origin: 'near',
    publicKey: account.publicKey,
    async sign(p) {
      const nonce32 = fromBase64(p.nonce);
      const signed = await wallet.signMessage({
        message: nep413Message(p),
        recipient: p.verifying_contract,
        nonce: nonce32,
        signerId: account.accountId,
      });
      if (signed.accountId !== account.accountId) {
        throw new WalletError(`The wallet signed as ${signed.accountId}, not ${account.accountId}, the account connected here. Reconnect the wallet and sign again.`);
      }
      const publicKey = signed.publicKey.startsWith(ED25519_PREFIX) ? signed.publicKey : `${ED25519_PREFIX}${signed.publicKey}`;
      return nep413FromWallet({ payload: p, nonce32, publicKey, signature: signed.signature });
    },
  };
  return connectedSigner;
}

/** The already connected NEAR wallet, or a new connection. Open, Cancel and Reveal all use this so the wallet is asked once. */
export async function ensureNear(): Promise<IntentSigner> {
  return connectedSigner ?? connectNear();
}

/** FunctionCall through the connected NEAR wallet (Open, Reveal all, Cancel; used from WS3-T05). */
export async function callFunction(
  receiverId: string,
  methodName: string,
  args: object,
  gasTgas: number,
  depositYocto: string | bigint = '0',
): Promise<unknown> {
  if (!connected) throw new WalletError('Connect a NEAR wallet first.');
  return connected.signAndSendTransaction({
    signerId: connectedSigner?.signerId,
    receiverId,
    actions: [
      {
        type: 'FunctionCall',
        params: {
          methodName,
          args,
          gas: (BigInt(gasTgas) * 10n ** 12n).toString(),
          deposit: depositYocto.toString(),
        },
      },
    ],
  });
}
