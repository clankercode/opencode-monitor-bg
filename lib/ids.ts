import type { IdAllocationResult, PrimeState } from "./types.ts";

function isPrime(value: number): boolean {
  if (value < 2) return false;
  if (value === 2) return true;
  if (value % 2 === 0) return false;
  for (let divisor = 3; divisor * divisor <= value; divisor += 2) {
    if (value % divisor === 0) return false;
  }
  return true;
}

export function nextPrime(start: number): number {
  let candidate = Math.max(2, Math.floor(start));
  while (!isPrime(candidate)) candidate += 1;
  return candidate;
}

export function primeQueue(primeState: PrimeState, count: number): { queue: number[]; state: PrimeState } {
  const queue = [...primeState.queue];
  let nextCandidate = primeState.nextCandidate;
  while (queue.length < count) {
    const prime = nextPrime(nextCandidate);
    queue.push(prime);
    nextCandidate = prime + 1;
  }
  return { queue, state: { queue, nextCandidate } };
}

function shiftPrime(primeState: PrimeState): { prime: number; state: PrimeState } {
  const filled = primeQueue(primeState, 1);
  const [prime, ...rest] = filled.queue;
  return {
    prime,
    state: {
      queue: rest,
      nextCandidate: filled.state.nextCandidate,
    },
  };
}

export function allocateMonitorId(input: {
  requestedId?: string;
  existingIds: string[];
  primeState: PrimeState;
}): IdAllocationResult {
  const existing = new Set(input.existingIds);
  if (input.requestedId && !existing.has(input.requestedId)) {
    return { id: input.requestedId, primeState: input.primeState };
  }

  let state = input.primeState;
  if (input.requestedId) {
    while (true) {
      const shifted = shiftPrime(state);
      state = shifted.state;
      const candidate = `${input.requestedId}-${shifted.prime}`;
      if (!existing.has(candidate)) return { id: candidate, primeState: state };
    }
  }

  while (true) {
    const shifted = shiftPrime(state);
    state = shifted.state;
    const candidate = `m${shifted.prime}`;
    if (!existing.has(candidate)) return { id: candidate, primeState: state };
  }
}
