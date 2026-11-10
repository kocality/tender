import { b58decode, payloadString, rawEd25519FromWallet, solanaSignerId, utf8 } from '@tender/intents';
import { WalletError, type IntentSigner } from './types';

interface PhantomSolana {
  isPhantom?: boolean;
  connect(): Promise<{ publicKey: { toString(): string } } | undefined>;
  publicKey?: { toString(): string } | null;
  signMessage(message: Uint8Array, display?: 'utf8' | 'hex'): Promise<unknown>;
}

function phantomProvider(): PhantomSolana {
  const p = (window as unknown as { phantom?: { solana?: PhantomSolana } }).phantom?.solana;
  if (!p?.isPhantom) throw new WalletError('Phantom not found. Install Phantom and reload.');
  return p;
}

/** Phantom returns `{signature: Uint8Array, publicKey}`; older builds returned the bytes directly. */
function signatureBytes(res: unknown): Uint8Array {
  const raw = res instanceof Uint8Array ? res : (res as { signature?: unknown } | null)?.signature;
  if (raw instanceof Uint8Array) return raw;
  const data = (raw as { data?: ArrayLike<number> } | undefined)?.data;
  if (data) return Uint8Array.from(data);
  if (Array.isArray(raw)) return Uint8Array.from(raw as number[]);
  throw new WalletError('Phantom returned an unexpected signature format.');
}

export async function connectPhantom(): Promise<IntentSigner> {
  const phantom = phantomProvider();
  const res = await phantom.connect();
  const pk = res?.publicKey ?? phantom.publicKey;
  if (!pk) throw new WalletError('Phantom returned no public key.');
  const pk32 = b58decode(pk.toString());
  return {
    kind: 'phantom',
    signerId: solanaSignerId(pk32),
    origin: 'sol',
    publicKey: pk.toString(),
    async sign(p) {
      // An account switch in Phantom is global across tabs: signing with the new key under the old public key fails as invalid_signature.
      if (phantom.publicKey?.toString() !== pk.toString()) throw new WalletError('Phantom switched account since you connected. Reconnect the wallet and sign again.');
      const str = payloadString(p);
      const out = await phantom.signMessage(utf8(str), 'utf8');
      return rawEd25519FromWallet(str, pk32, signatureBytes(out));
    },
  };
}
