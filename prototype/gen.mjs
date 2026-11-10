import { bls12_381 as bls } from '@noble/curves/bls12-381.js';
import bs58 from 'bs58';
import fs from 'node:fs';
const G1 = bls.G1.Point, G2 = bls.G2.Point;
console.log('G1 gen', 'bls12381g1:'+bs58.encode(G1.BASE.toBytes(true)));
console.log('G2 gen', 'bls12381g2:'+bs58.encode(G2.BASE.toBytes(true)));
const v = JSON.parse(fs.readFileSync(process.argv[2]));
console.log(Object.keys(v.vectors[0]), v.vectors.length);
