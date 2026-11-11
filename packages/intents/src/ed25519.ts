// Is a 32-byte string the compressed encoding of a point on the ed25519 curve? A Solana wallet address always is; a
// program derived address (vault, token account owner, ...) never is. Same decompression rule as Solana's
// is_on_curve (and noble's `Point.fromBytes(b, true)`): the top bit is the sign of x and is ignored here, y is reduced
// mod p without a canonical check, and x exists iff u/v is a square with u = y^2 - 1, v = d*y^2 + 1.

const P = (1n << 255n) - 19n;
const D = 37095705934669439343138083508754565189542113879843219016388785533085940283555n;

function powmod(base: bigint, exp: bigint): bigint {
  let r = 1n;
  let b = base % P;
  for (let e = exp; e > 0n; e >>= 1n) {
    if (e & 1n) r = (r * b) % P;
    b = (b * b) % P;
  }
  return r;
}

export function isEd25519Point(bytes: Uint8Array): boolean {
  if (bytes.length !== 32) return false;
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(i === 31 ? bytes[i]! & 0x7f : bytes[i]!);
  y %= P;
  const y2 = (y * y) % P;
  const u = (y2 + P - 1n) % P;
  const v = (D * y2 + 1n) % P;
  if (u === 0n) return true; // x = 0
  // u/v is a square iff (u * v^-1)^((p-1)/2) = 1; v^-1 = v^(p-2)
  const ratio = (u * powmod(v, P - 2n)) % P;
  return powmod(ratio, (P - 1n) / 2n) === 1n;
}
