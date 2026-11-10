import { webcrypto } from "node:crypto"; if (!globalThis.crypto) globalThis.crypto = webcrypto;
import { bls12_381 as bls } from '@noble/curves/bls12-381.js';
import { sha3_256 } from '@noble/hashes/sha3.js';
import bs58 from 'bs58';
import fs from 'node:fs';
const L = JSON.parse(fs.readFileSync('live.json'));
const DST = 'NEAR BLS12381G1_XMD:SHA-256_SSWU_RO_';
const G1 = bls.G1.Point, G2 = bls.G2.Point;
const dec = s => bs58.decode(s.split(':')[1]);
const pkB = dec(L.pk), pk = G2.fromBytes(pkB), pk2 = G2.fromBytes(dec(L.pk2));
const Y = G1.fromBytes(dec(L.big_y)), C = G1.fromBytes(dec(L.big_c));
const appId = sha3_256(new TextEncoder().encode(`near-mpc v0.1.0 app_id derivation:${L.acct},${L.path}`));
const Hp = bls.G1.hashToCurve(new Uint8Array([...pkB, ...appId]), { DST });
const lhs = bls.pairing(C, G2.BASE);
const rhs = bls.fields.Fp12.mul(bls.pairing(Y, pk2), bls.pairing(Hp, pk));
console.log('mainnet PV check e(C,g2)=e(Y,pk2)e(H(pk||app_id),pk):', bls.fields.Fp12.eql(lhs, rhs));
const wrong = sha3_256(new TextEncoder().encode(`near-mpc v0.1.0 app_id derivation:mallory.near,${L.path}`));
const Hw = bls.G1.hashToCurve(new Uint8Array([...pkB, ...wrong]), { DST });
console.log('wrong app_id check:', bls.fields.Fp12.eql(lhs, bls.fields.Fp12.mul(bls.pairing(Y, pk2), bls.pairing(Hw, pk))));
// identity encodings
const id1 = G1.ZERO.toBytes(true), id2 = G2.ZERO.toBytes(true);
console.log('G1 identity compressed', 'bls12381g1:'+bs58.encode(id1), id1[0].toString(16));
console.log('G2 identity compressed', 'bls12381g2:'+bs58.encode(id2));
// Boneh-Franklin IBE round trip on G2 master key (simulated msk) with NEAR hash
const n = bls.fields.Fr.ORDER;
const rnd = () => BigInt('0x'+Buffer.from(bls.utils.randomSecretKey()).toString('hex')) % n;
const msk = rnd(); const mpk = G2.BASE.multiply(msk); const mpkB = mpk.toBytes(true);
const aid = sha3_256(new TextEncoder().encode('near-mpc v0.1.0 app_id derivation:tender.near,sale/1'));
const Q = bls.G1.hashToCurve(new Uint8Array([...mpkB, ...aid]), { DST });
const r = rnd(); const U = G2.BASE.multiply(r);
const maskEnc = bls.pairing(Q, mpk.multiply(r));
const skId = Q.multiply(msk); // = big_c when app pk is identity
const maskDec = bls.pairing(skId, U);
console.log('IBE round-trip mask equal:', bls.fields.Fp12.eql(maskEnc, maskDec));
