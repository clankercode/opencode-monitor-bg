import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { makeExit, makeLine, makeLines, makeSchedulerState } from "../lib/factories.ts";
import { commitDelivery, decideLineEvent, decideManualFetch, decideTimeEvent } from "../lib/core.ts";

describe("core", () => {
  test("line trigger delivers immediately when no debounce window", () => {
    const decision = decideLineEvent({
      state: makeSchedulerState(),
      line: makeLine(),
      triggers: [{ type: "line" }],
      sessionIsIdle: false,
      now: 1_700_000_000_000,
    });

    expect(decision.deliverNow).toBeTrue();
    expect(decision.reason).toBe("line");
  });

  test("line trigger debounces when windowMs is set", () => {
    const now = 1_700_000_000_000;
    const decision = decideLineEvent({
      state: makeSchedulerState(),
      line: makeLine({ ingestedAt: now }),
      triggers: [{ type: "line", windowMs: 5_000 }],
      sessionIsIdle: false,
      now,
    });

    expect(decision.deliverNow).toBeFalse();
    expect(decision.debounceUntil).toBe(now + 5_000);
  });

  test("idle trigger delivers immediately when session is already idle", () => {
    const decision = decideLineEvent({
      state: makeSchedulerState(),
      line: makeLine(),
      triggers: [{ type: "idle" }],
      sessionIsIdle: true,
      now: 1_700_000_000_000,
    });

    expect(decision.deliverNow).toBeTrue();
    expect(decision.reason).toBe("idle");
  });

  test("interval trigger can deliver immediately when idle if configured", () => {
    const decision = decideLineEvent({
      state: makeSchedulerState(),
      line: makeLine(),
      triggers: [{ type: "interval", everyMs: 60_000, instantWhenIdle: true }],
      sessionIsIdle: true,
      now: 1_700_000_000_000,
    });

    expect(decision.deliverNow).toBeTrue();
    expect(decision.reason).toBe("interval");
  });

  test("interval trigger fires at configured schedule", () => {
    const decision = decideTimeEvent({
      state: makeSchedulerState({ pendingLines: makeLines(2) }),
      triggers: [{ type: "interval", everyMs: 60_000, offsetMs: 10_000 }],
      sessionIsIdle: false,
      now: 130_000,
      kind: "interval",
    });

    expect(decision.deliverNow).toBeTrue();
    expect(decision.reason).toBe("interval");
  });

  test("interval trigger can deliver empty heartbeat when configured", () => {
    const decision = decideTimeEvent({
      state: makeSchedulerState(),
      triggers: [{ type: "interval", everyMs: 60_000, deliverWhenEmpty: true }],
      sessionIsIdle: false,
      now: 120_000,
      kind: "interval",
    });

    expect(decision.deliverNow).toBeTrue();
    expect(decision.reason).toBe("interval");
  });

  test("interval trigger tolerates small timer jitter for pending output", () => {
    const decision = decideTimeEvent({
      state: makeSchedulerState({ pendingLines: makeLines(1) }),
      triggers: [{ type: "interval", everyMs: 1_000 }],
      sessionIsIdle: false,
      now: 2_003,
      kind: "interval",
    });

    expect(decision.deliverNow).toBeTrue();
    expect(decision.reason).toBe("interval");
  });

  test("interval trigger tolerates small timer jitter for empty heartbeat", () => {
    const decision = decideTimeEvent({
      state: makeSchedulerState(),
      triggers: [{ type: "interval", everyMs: 1_000, deliverWhenEmpty: true }],
      sessionIsIdle: false,
      now: 2_003,
      kind: "interval",
    });

    expect(decision.deliverNow).toBeTrue();
    expect(decision.reason).toBe("interval");
  });

  test("interval trigger does not fire far from its schedule", () => {
    const decision = decideTimeEvent({
      state: makeSchedulerState({ pendingLines: makeLines(1) }),
      triggers: [{ type: "interval", everyMs: 1_000 }],
      sessionIsIdle: false,
      now: 2_250,
      kind: "interval",
    });

    expect(decision.deliverNow).toBeFalse();
  });

  test("exit-only delivery happens with no pending lines", () => {
    const decision = decideTimeEvent({
      state: makeSchedulerState({ pendingExit: makeExit() }),
      triggers: [{ type: "idle" }],
      sessionIsIdle: true,
      now: 1_700_000_010_000,
      kind: "idle",
    });

    expect(decision.deliverNow).toBeTrue();
    expect(decision.reason).toBe("exit");
  });

  test("manual fetch always delivers pending state", () => {
    const decision = decideManualFetch(makeSchedulerState({ pendingLines: makeLines(1) }));
    expect(decision.deliverNow).toBeTrue();
    expect(decision.reason).toBe("fetch");
  });

  test("commitDelivery drains pending lines and increments seq", () => {
    const state = makeSchedulerState({ pendingLines: makeLines(2), nextSeq: 3 });
    const committed = commitDelivery({ state, monitorId: "m11" });

    expect(committed.batch).toEqual({
      monitorId: "m11",
      seq: 3,
      lines: state.pendingLines,
      exit: undefined,
    });
    expect(committed.state.pendingLines).toEqual([]);
    expect(committed.state.nextSeq).toBe(4);
  });

  test("commitDelivery combines output and exit in one final batch", () => {
    const exit = makeExit();
    const state = makeSchedulerState({ pendingLines: makeLines(1), pendingExit: exit, nextSeq: 4 });
    const committed = commitDelivery({ state, monitorId: "m13" });

    expect(committed.batch.exit).toEqual(exit);
    expect(committed.batch.seq).toBe(4);
    expect(committed.state.pendingExit).toBeUndefined();
  });

  test("committed deliveries preserve line ordering", () => {
    fc.assert(
      fc.property(fc.array(fc.string(), { minLength: 1, maxLength: 20 }), (contents) => {
        const lines = contents.map((content, index) =>
          makeLine({ content, ingestedAt: 1_700_000_000_000 + index * 1_000 }),
        );
        const committed = commitDelivery({
          state: makeSchedulerState({ pendingLines: lines, nextSeq: 1 }),
          monitorId: "m17",
        });

        expect(committed.batch.lines.map((line) => line.content)).toEqual(contents);
      }),
    );
  });
});
