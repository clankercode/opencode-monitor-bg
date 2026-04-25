export type StreamType = "stdout" | "stderr";

export type CaptureMode = "stdout" | "stderr" | "both";

export type OutputFormat = "compact" | "very-compact";

export type MonitorLifetime = "ephemeral" | "persistent";

export type TriggerConfig =
  | { type: "line"; windowMs?: number }
  | { type: "idle" }
  | {
      type: "interval";
      everyMs: number;
      offsetMs?: number;
      deliverWhenEmpty?: boolean;
      instantWhenIdle?: boolean;
    };

export interface IngestedLine {
  stream: StreamType;
  content: string;
  ingestedAt: number;
}

export interface PendingExit {
  exitCode: number | null;
  signal: string | null;
  occurredAt: number;
}

export interface MonitorRecord {
  ownerSessionID: string;
  label: string;
  monitorId: string;
  command: string;
  pid: number;
  capture: CaptureMode;
  outputFormat: OutputFormat;
  agent?: string;
  triggers: TriggerConfig[];
  cwd: string;
  env: Record<string, string>;
  logPath: string;
  tagTemplate: string;
  lifetime: MonitorLifetime;
  truncate: number;
  sendOnlyLatest: boolean;
  requestedMonitorId?: string;
  nextSeq: number;
  pendingLines: IngestedLine[];
  pendingExit?: PendingExit;
  status: "running" | "exited" | "killed";
}

export interface PrimeState {
  nextCandidate: number;
  queue: number[];
}

export interface IdAllocationResult {
  id: string;
  primeState: PrimeState;
}

export interface LineCollectorState {
  remainder: string;
}

export interface EmittedLine {
  state: LineCollectorState;
  lines: string[];
}

export interface DeliveryBatch {
  monitorId: string;
  seq: number;
  lines: IngestedLine[];
  exit?: PendingExit;
}

export interface SchedulerState {
  pendingLines: IngestedLine[];
  pendingExit?: PendingExit;
  nextSeq: number;
  debounceUntil?: number;
}

export interface SchedulerDecision {
  deliverNow: boolean;
  reason?: "line" | "idle" | "interval" | "exit" | "fetch";
  debounceUntil?: number;
}

export interface PersistentMonitorSnapshot {
  ownerSessionID: string;
  label: string;
  monitorId: string;
  command: string;
  pid: number;
  capture: CaptureMode;
  outputFormat: OutputFormat;
  agent?: string;
  triggers: TriggerConfig[];
  cwd: string;
  env: Record<string, string>;
  logPath: string;
  stdoutPath: string;
  stderrPath: string;
  stdoutOffset: number;
  stderrOffset: number;
  stdoutRemainder: string;
  stderrRemainder: string;
  tagTemplate: string;
  lifetime: MonitorLifetime;
  truncate?: number | boolean;
  sendOnlyLatest?: boolean;
  requestedMonitorId?: string;
  nextSeq: number;
  pendingLines: IngestedLine[];
  pendingExit?: PendingExit;
  status: "running" | "exited" | "killed";
}

export interface SessionMonitorsManifest {
  version: 1;
  rootSessionID: string;
  monitors: PersistentMonitorSnapshot[];
}

export interface SessionLeaseRecord {
  version: 1;
  rootSessionID: string;
  ownerPid: number;
  acquiredAt: number;
}
