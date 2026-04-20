import type { DeliveryBatch, IngestedLine, SchedulerDecision, SchedulerState, TriggerConfig } from "./types.ts";

function hasPending(state: SchedulerState): boolean {
  return state.pendingLines.length > 0 || Boolean(state.pendingExit);
}

export function decideLineEvent(input: {
  state: SchedulerState;
  line: IngestedLine;
  triggers: TriggerConfig[];
  sessionIsIdle: boolean;
  now: number;
}): SchedulerDecision {
  if (input.sessionIsIdle && input.triggers.some((trigger) => trigger.type === "idle")) {
    return { deliverNow: true, reason: "idle" };
  }

  if (
    input.sessionIsIdle &&
    input.triggers.some((trigger) => trigger.type === "interval" && Boolean(trigger.instantWhenIdle))
  ) {
    return { deliverNow: true, reason: "interval" };
  }

  const lineTrigger = input.triggers.find((trigger) => trigger.type === "line");
  if (!lineTrigger) return { deliverNow: false };
  if (!lineTrigger.windowMs) return { deliverNow: true, reason: "line" };
  return {
    deliverNow: false,
    debounceUntil: input.now + lineTrigger.windowMs,
  };
}

export function decideTimeEvent(input: {
  state: SchedulerState;
  triggers: TriggerConfig[];
  sessionIsIdle: boolean;
  now: number;
  kind: "idle" | "interval";
}): SchedulerDecision {
  if (input.state.pendingExit && input.state.pendingLines.length === 0) {
    return { deliverNow: true, reason: "exit" };
  }
  if (input.kind === "interval") {
    const intervalTriggers = input.triggers.filter((trigger) => trigger.type === "interval");
    for (const trigger of intervalTriggers) {
      const offsetMs = trigger.offsetMs ?? 0;
      if (input.now < offsetMs) continue;
      if ((input.now - offsetMs) % trigger.everyMs === 0) {
        if (hasPending(input.state) || trigger.deliverWhenEmpty) {
          return { deliverNow: true, reason: "interval" };
        }
      }
    }
  }

  if (!hasPending(input.state)) return { deliverNow: false };
  if (input.kind === "idle" && input.sessionIsIdle && input.triggers.some((trigger) => trigger.type === "idle")) {
    return { deliverNow: true, reason: "idle" };
  }

  return { deliverNow: false };
}

export function decideManualFetch(state: SchedulerState): SchedulerDecision {
  if (!hasPending(state)) return { deliverNow: false };
  return { deliverNow: true, reason: "fetch" };
}

export function commitDelivery(input: {
  state: SchedulerState;
  monitorId: string;
}): { batch: DeliveryBatch; state: SchedulerState } {
  const batch: DeliveryBatch = {
    monitorId: input.monitorId,
    seq: input.state.nextSeq,
    lines: input.state.pendingLines,
    exit: input.state.pendingExit,
  };

  return {
    batch,
    state: {
      pendingLines: [],
      nextSeq: input.state.nextSeq + 1,
      debounceUntil: undefined,
    },
  };
}
