import type {
  IngestedLine,
  MonitorRecord,
  PendingExit,
  PrimeState,
  SchedulerState,
  TriggerConfig,
} from "./types.ts";

export function makeLine(overrides: Partial<IngestedLine> = {}): IngestedLine {
  return {
    stream: "stdout",
    content: "hello",
    ingestedAt: 1_700_000_000_000,
    ...overrides,
  };
}

export function makeLines(count: number, overrides: Partial<IngestedLine> = {}): IngestedLine[] {
  const base = overrides.ingestedAt ?? 1_700_000_000_000;
  return Array.from({ length: count }, (_, index) =>
    makeLine({
      content: `line ${index + 1}`,
      ingestedAt: base + index * 1_000,
      ...overrides,
    }),
  );
}

export function makeExit(overrides: Partial<PendingExit> = {}): PendingExit {
  return {
    exitCode: 0,
    signal: null,
    occurredAt: 1_700_000_010_000,
    ...overrides,
  };
}

export function makeTrigger(trigger: TriggerConfig): TriggerConfig {
  return trigger;
}

export function makePrimeState(overrides: Partial<PrimeState> = {}): PrimeState {
  return {
    nextCandidate: 2,
    queue: [],
    ...overrides,
  };
}

export function makeMonitorRecord(overrides: Partial<MonitorRecord> = {}): MonitorRecord {
  return {
    ownerSessionID: "session-root",
    label: "server",
    monitorId: "m2",
    command: "bun run dev",
    pid: 12345,
    capture: "both",
    outputFormat: "compact",
    triggers: [{ type: "idle" }],
    cwd: "/tmp/project",
    env: {},
    logPath: "/tmp/opencode-monitor/server.log",
    tagTemplate: "monitor_{id}",
    lifetime: "ephemeral",
    truncate: 0,
    sendOnlyLatest: false,
    nextSeq: 1,
    pendingLines: [],
    status: "running",
    ...overrides,
  };
}

export function makeSchedulerState(overrides: Partial<SchedulerState> = {}): SchedulerState {
  return {
    pendingLines: [],
    nextSeq: 1,
    ...overrides,
  };
}
