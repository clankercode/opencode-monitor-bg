import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { makePrimeState } from "../lib/factories.ts";
import { allocateMonitorId, nextPrime, primeQueue } from "../lib/ids.ts";

describe("ids", () => {
  test("nextPrime yields increasing primes", () => {
    expect(nextPrime(2)).toBe(2);
    expect(nextPrime(3)).toBe(3);
    expect(nextPrime(4)).toBe(5);
    expect(nextPrime(10)).toBe(11);
  });

  test("primeQueue returns requested amount in order", () => {
    const result = primeQueue(makePrimeState(), 5);
    expect(result.queue).toEqual([2, 3, 5, 7, 11]);
    expect(result.state.nextCandidate).toBe(12);
  });

  test("allocateMonitorId uses requested id when unique", () => {
    const result = allocateMonitorId({
      requestedId: "server",
      existingIds: ["m2", "m3"],
      primeState: makePrimeState(),
    });

    expect(result.id).toBe("server");
  });

  test("allocateMonitorId appends prime suffix when requested id collides", () => {
    const result = allocateMonitorId({
      requestedId: "server",
      existingIds: ["server", "server-2"],
      primeState: makePrimeState(),
    });

    expect(result.id).toBe("server-3");
  });

  test("allocateMonitorId auto-generates prime-prefixed ids", () => {
    const first = allocateMonitorId({
      existingIds: [],
      primeState: makePrimeState(),
    });
    const second = allocateMonitorId({
      existingIds: [first.id],
      primeState: first.primeState,
    });

    expect(first.id).toBe("m2");
    expect(second.id).toBe("m3");
  });

  test("auto-generated ids stay unique", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 50 }), (count) => {
        let state = makePrimeState();
        const ids: string[] = [];
        for (let index = 0; index < count; index += 1) {
          const result = allocateMonitorId({ existingIds: ids, primeState: state });
          ids.push(result.id);
          state = result.primeState;
        }
        expect(new Set(ids).size).toBe(ids.length);
      }),
    );
  });
});
