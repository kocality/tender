#!/usr/bin/env python3
"""Golden clearing vectors for Tender, from an independent reference (Python 3 stdlib, big ints).

Writes fixtures/clearing/*.json. contract/src/clearing.rs (Rust) and packages/clearing (TS) must
both reproduce every `expected` field. Never edit a fixture to make an implementation pass.

Rules: uniform price, sorted by price desc then arrival (idx); scale 10^(decimals + lot_exp);
a full winner pays q and gets floor(q * scale / P*) tokens; the marginal group (every bid at
p == P*) shares the remaining supply pro rata by q and pays ceil(t * P* / scale). A Sealed bid
is penalized B // 10 when at least one bid was revealed; the pool goes pro rata by B to every
revealed bid (below reserve too), rounding remainder to the lowest revealed idx, never to the
seller. Nothing revealed: no penalty, bids stay Sealed, full refunds.

JSON: u64/u128 values are decimal strings, u8/u16 values (decimals, lot_exp, idx) are numbers;
P_star is null when nothing clears; a Sealed bid's p and q are null.

Usage: python3 fixtures/clearing/gen.py
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))


def cdiv(a, b):
    return -(-a // b)


def clear(S, d, lot, reserve, bids):
    scale = 10 ** (d + lot); n = len(bids)
    alloc = [0]*n; spend = [0]*n; share = [0]*n; pen = [0]*n
    rev = [b for b in bids if b['state'] == 'Revealed']
    sealed = [b for b in bids if b['state'] == 'Sealed']
    if rev:                                   # K2: no penalty when nothing was revealed
        for b in sealed: pen[b['idx']] = b['B'] // 10
    pool = sum(pen); totB = sum(b['B'] for b in rev)
    if pool:                                  # K1: pro-rata by B over ALL revealed bids (below reserve too)
        for b in rev: share[b['idx']] = pool * b['B'] // totB
        share[min(b['idx'] for b in rev)] += pool - sum(share)
    el = sorted([b for b in rev if b['p'] >= reserve], key=lambda b: (-b['p'], b['idx']))
    P = None; Q = 0; dust = 0
    for k, b in enumerate(el):
        Q += b['q']; cand = max(reserve, cdiv(Q * scale, S))
        nxt = el[k+1]['p'] if k + 1 < len(el) else None
        if cand <= b['p'] and (nxt is None or cand > nxt):
            P = cand
            for w in el[:k+1]: spend[w['idx']] = w['q']; alloc[w['idx']] = w['q'] * scale // P
            break
        if cand > b['p']:
            P = b['p']
            full = [w for w in el if w['p'] > P]; marg = [w for w in el if w['p'] == P]
            for w in full: spend[w['idx']] = w['q']; alloc[w['idx']] = w['q'] * scale // P
            R = S - sum(alloc); qm = sum(w['q'] for w in marg)
            for w in marg:
                t = R * w['q'] // qm; alloc[w['idx']] = t; spend[w['idx']] = cdiv(t * P, scale)
            dust = R - sum(alloc[w['idx']] for w in marg)
            break
    refund = [b['B'] - spend[b['idx']] - pen[b['idx']] + share[b['idx']] for b in bids]
    final = [('Revealed' if b['state'] == 'Revealed' else ('Penalized' if rev else 'Sealed')) for b in bids]
    assert sum(spend) + sum(refund) == sum(b['B'] for b in bids) and sum(alloc) <= S
    return dict(P_star=P, alloc=alloc, spend=spend, refund=refund, penalty=pen, penalty_share=share,
                final_state=final, seller_usdc=sum(spend), seller_tokens_back=S - sum(alloc), dust=dust)


def R(B, p, q):
    return {'B': B, 'p': p, 'q': q, 'state': 'Revealed'}


def Sd(B):
    return {'B': B, 'p': None, 'q': None, 'state': 'Sealed'}


E24 = 10 ** 24
CASES = [
    ('demo-sale-1',
     'Demo sale #1 (spec §5.5 table): 3 wNEAR, reserve 3.00 USDC/NEAR, six revealed bids. '
     'P* = 3.60; the marginal bid pays ceil, so the seller gets 10.800001 USDC (WD-02).',
     3 * E24, 24, 0, 3_000_000,
     [R(5_000_000, 3_900_000, 4_000_000), R(5_000_000, 3_800_000, 3_000_000),
      R(3_000_000, 3_700_000, 3_000_000), R(3_000_000, 3_600_000, 2_000_000),
      R(3_000_000, 3_200_000, 3_000_000), R(2_000_000, 2_900_000, 2_000_000)]),
    ('jambo-sale-2',
     'Sale #2 parameters (M13): 22,400 JAMBO (d 18), lot_exp 3 (p per 1000 JAMBO), reserve 174,000. '
     'Demand is below supply: P* = reserve, unsold tokens go back to the seller.',
     22_400 * 10 ** 18, 18, 3, 174_000,
     [R(2_000_000, 200_000, 2_000_000), R(2_000_000, 185_000, 1_500_000)]),
    ('penalty',
     'Two bids stay Sealed (broken ciphertext and a copied bid): each loses B/10; the pool goes '
     'pro rata by B to both revealed bids, including the one below reserve; the seller gets none of it.',
     10 ** 23, 24, 0, 3_000_000,
     [R(1_000_000, 3_500_000, 1_000_000), Sd(1_000_000), Sd(1_000_000),
      R(2_000_000, 2_000_000, 1_000_000)]),
    ('zero-reveal',
     'Nothing revealed (K2): no penalty, bids stay Sealed, full refunds, supply back to the seller.',
     10 ** 23, 24, 0, 3_000_000,
     [Sd(1_000_000), Sd(2_000_000), Sd(3_000_000)]),
    ('all-below-reserve',
     'Every revealed bid is below reserve: nothing clears, full refunds, supply back to the seller.',
     10 ** 23, 24, 0, 3_000_000,
     [R(1_000_000, 2_000_000, 1_000_000), R(2_000_000, 2_999_999, 2_000_000)]),
    ('bound-d-lot-exp',
     'decimals + lot_exp = 26 (the create limit) with S = 10^26 (WD-01) and Σ q near the escrow '
     'cap: Q * scale reaches 10^38, still inside u128.',
     10 ** 26, 24, 2, 10 ** 12,
     [R(5 * 10 ** 11, 2 * 10 ** 15, 5 * 10 ** 11), R(5 * 10 ** 11, 10 ** 15, 5 * 10 ** 11)]),
    ('tie-marginal',
     'Three bids at the same price form one marginal group: pro rata by q in floor, ceil spend, '
     'one token of dust back to the seller.',
     E24, 24, 0, 1_000_000,
     [R(3_000_000, 2_000_000, 3_000_000), R(1_000_000, 2_000_000, 1_000_000),
      R(2_000_000, 2_000_000, 2_000_000)]),
]

# Values checked by hand when the algorithm was specified; a change here is a regression.
PINNED = {
    'demo-sale-1': {'P_star': 3_600_000, 'seller_usdc': 10_800_001,
                    'refund': [1_000_000, 2_000_000, 0, 2_199_999, 3_000_000, 2_000_000]},
    'penalty': {'penalty_share': [66_667, 0, 0, 133_333], 'refund': [716_667, 900_000, 900_000, 2_133_333]},
    'tie-marginal': {'spend': [1_000_000, 333_334, 666_667], 'dust': 1, 'seller_tokens_back': 1},
    'bound-d-lot-exp': {'P_star': 10 ** 12, 'alloc': [5 * 10 ** 25, 5 * 10 ** 25]},
}


def s(v):
    return None if v is None else str(v)


def main():
    for name, note, S, d, lot, reserve, raw in CASES:
        bids = [dict(b, idx=i) for i, b in enumerate(raw)]
        e = clear(S, d, lot, reserve, bids)
        for k, v in PINNED.get(name, {}).items():
            assert e[k] == v, (name, k, e[k], v)
        doc = {
            'name': name,
            'note': note,
            'sale': {'S': s(S), 'decimals': d, 'lot_exp': lot, 'reserve': s(reserve)},
            'bids': [{'idx': b['idx'], 'B': s(b['B']), 'p': s(b['p']), 'q': s(b['q']),
                      'state': b['state']} for b in bids],
            'expected': {
                'P_star': s(e['P_star']),
                'alloc': [s(x) for x in e['alloc']],
                'spend': [s(x) for x in e['spend']],
                'refund': [s(x) for x in e['refund']],
                'penalty': [s(x) for x in e['penalty']],
                'penalty_share': [s(x) for x in e['penalty_share']],
                'final_state': e['final_state'],
                'seller_usdc': s(e['seller_usdc']),
                'seller_tokens_back': s(e['seller_tokens_back']),
                'dust': s(e['dust']),
            },
        }
        with open(os.path.join(HERE, name + '.json'), 'w') as f:
            json.dump(doc, f, indent=1)
            f.write('\n')
        print('ok', name)


if __name__ == '__main__':
    main()
