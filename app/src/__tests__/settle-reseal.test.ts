import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { Ticket } from '../lib/ticket';

// After a refund the bid is sealed again (a new commitment, so a new nonce). The spent nonce of the refunded bid must not make
// the new bid look "executed" forever: only the live bid's nonce counts, while "stored" accepts any commitment of the plan.
const m = vi.hoisted(() => ({ used: vi.fn() }));
vi.mock('@tender/intents', async (orig) => ({ ...(await orig<typeof import('@tender/intents')>()), isNonceUsed: m.used, rpcRequest: vi.fn() }));
vi.mock('../lib/views', async (orig) => ({ ...(await orig<typeof import('../lib/views')>()), getAllBids: vi.fn(async () => []) }));

import { chainIO } from '../lib/settle';
import { ticketNonceB64 } from '../lib/ticket';

const OLD = 'aa'.repeat(32);
const NEW = 'bb'.repeat(32);
const t: Ticket = {
  v: 1, network: 'testnet', contract: 'v1.tenderseal.near', sale: '7', saleCreatedNs: '1790000000000000000', signer: 'alice.testnet', cms: [OLD, NEW], ct: 'ff', B: '5000000', origin: 'near',
  intentsSalt: '0a0b0c0d', seq: 0, closeNs: '1800000000000000000', sent: false, payloadDeadlineMs: null, txHashes: [], relayer: null, usedSeenMs: null,
};

describe('a re-sealed bid is judged by its own nonce', () => {
  beforeEach(() => m.used.mockReset());
  test('the refunded commitment spent its nonce; the live one has not run yet', async () => {
    m.used.mockImplementation(async (_rpc, _id, _who, nonce: string) => nonce === ticketNonceB64(t, OLD));
    expect(await chainIO(t).nonceUsed(1)).toBe(false);
    expect(m.used).toHaveBeenCalledTimes(1);
    expect(m.used.mock.calls[0]![3]).toBe(ticketNonceB64(t, NEW));
  });
});
