import type { IntentsErrorKind, simulateIntents } from '@tender/intents';
import { TRY_RESULT } from '../copy';
import { humanError } from './errors';

export type SimulationResult = Awaited<ReturnType<typeof simulateIntents>>;

export interface TryOutcome {
  kind: IntentsErrorKind | 'ok';
  tone: 'ok' | 'warn' | 'bad';
  text: string;
  /** The salt moved between reading and signing; the user signs again (never automatic). */
  signAgain: boolean;
}

/**
 * What a `simulate_intents` answer means for the free signing check. The contract verifies the signature before it
 * looks at balances (F7), so insufficient balance and an unregistered NEAR key both prove the signature itself is valid.
 */
export function interpretSimulation(sim: SimulationResult): TryOutcome {
  if (sim.ok) return { kind: 'ok', tone: 'ok', text: TRY_RESULT.funded, signAgain: false };
  switch (sim.kind) {
    case 'insufficient_balance':
      return { kind: sim.kind, tone: 'ok', text: TRY_RESULT.insufficientBalance, signAgain: false };
    case 'public_key_not_registered':
      return { kind: sim.kind, tone: 'warn', text: TRY_RESULT.notRegistered, signAgain: false };
    case 'invalid_salt':
      return { kind: sim.kind, tone: 'bad', text: `The Intents salt changed while signing (${sim.message}). Sign again.`, signAgain: true };
    default:
      return { kind: sim.kind, tone: 'bad', text: humanError(sim.kind, sim.message), signAgain: false };
  }
}
