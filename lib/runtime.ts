import { spawn, type ChildProcess } from "child_process";
import {
  closeSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  watch,
  writeFileSync,
  type FSWatcher,
  type WriteStream,
} from "fs";
import path from "path";

import type { EventSessionCreated, EventSessionDeleted, Session } from "@opencode-ai/sdk";

import { appendDebugLog } from "./debug.ts";
import { commitDelivery, decideLineEvent, decideManualFetch, decideTimeEvent } from "./core.ts";
import { allocateMonitorId } from "./ids.ts";
import { appendChunk, flushRemainder } from "./lines.ts";
import type {
  CaptureMode,
  DeliveryBatch,
  IngestedLine,
  LineCollectorState,
  MonitorLifetime,
  MonitorRecord,
  OutputFormat,
  PersistentMonitorSnapshot,
  PrimeState,
  SchedulerState,
  SessionLeaseRecord,
  SessionMonitorsManifest,
  TriggerConfig,
} from "./types.ts";
import { formatBatchXml, formatDateTime } from "./xml.ts";

export interface StartMonitorInput {
  ownerSessionID: string;
  label: string;
  command: string;
  capture: CaptureMode;
  outputFormat?: OutputFormat;
  cwd: string;
  env?: Record<string, string>;
  triggers: TriggerConfig[];
  tagTemplate: string;
  lifetime?: MonitorLifetime;
  requestedId?: string;
  sendOnlyLatest?: boolean;
}

export interface MonitorSummary {
  ownerSessionID: string;
  label: string;
  monitorId: string;
  pid: number;
  status: MonitorRecord["status"];
  pendingCount: number;
  capture: CaptureMode;
  outputFormat: OutputFormat;
  triggers: TriggerConfig[];
  logPath: string;
  lifetime: MonitorLifetime;
  sendOnlyLatest: boolean;
}

export interface MonitorManagerOptions {
  now?: () => number;
  stateRoot: string;
  promptAsync: (sessionID: string, text: string) => Promise<void>;
  getRootSessionID: (sessionID: string) => Promise<string>;
  spawnProcess?: typeof spawn;
  setTimer?: (callback: () => void, delay: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
  debugEnabled?: boolean;
  debugLogPath?: string;
}

type TimerHandle = ReturnType<typeof setTimeout>;

type ProcessHandle = Pick<ChildProcess, "pid" | "kill"> & Partial<Pick<ChildProcess, "stdout" | "stderr" | "on" | "unref">>;

type RuntimeMonitor = {
  record: MonitorRecord;
  process: ProcessHandle;
  scheduler: SchedulerState;
  stdoutCollector: LineCollectorState;
  stderrCollector: LineCollectorState;
  stdoutPath: string;
  stderrPath: string;
  stdoutOffset: number;
  stderrOffset: number;
  stdoutWatcher: FSWatcher | null;
  stderrWatcher: FSWatcher | null;
  logStream: WriteStream;
  logFailed: boolean;
  draining: Promise<void> | null;
  destroyed: boolean;
  closed: boolean;
  removalPending: boolean;
  debounceTimer: TimerHandle | null;
  intervalTimers: TimerHandle[];
  healthTimer: TimerHandle | null;
};

export class MonitorManager {
  private readonly now: () => number;
  private readonly stateRoot: string;
  private readonly promptAsync: (sessionID: string, text: string) => Promise<void>;
  private readonly getRootSessionID: (sessionID: string) => Promise<string>;
  private readonly spawnProcess: typeof spawn;
  private readonly setTimer: (callback: () => void, delay: number) => TimerHandle;
  private readonly clearTimer: (handle: TimerHandle) => void;
  private readonly debugEnabled: boolean;
  private readonly debugLogPath?: string;
  private readonly bySession = new Map<string, Map<string, RuntimeMonitor>>();
  private readonly sessionIdle = new Map<string, boolean>();
  private primeState: PrimeState = { nextCandidate: 2, queue: [] };
  private readonly sessionRoots = new Map<string, string>();
  private readonly loadedSessions = new Set<string>();
  private readonly loadingSessions = new Map<string, Promise<void>>();
  private readonly loadErrors = new Map<string, Error>();
  private readonly leasedSessions = new Set<string>();

  constructor(options: MonitorManagerOptions) {
    this.now = options.now ?? Date.now;
    this.stateRoot = options.stateRoot;
    this.promptAsync = options.promptAsync;
    this.getRootSessionID = options.getRootSessionID;
    this.spawnProcess = options.spawnProcess ?? spawn;
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
    this.debugEnabled = options.debugEnabled ?? false;
    this.debugLogPath = options.debugLogPath;
  }

  cleanupLogs(olderThanMs = 7 * 24 * 60 * 60 * 1_000): void {
    mkdirSync(this.stateRoot, { recursive: true });
    const cutoff = this.now() - olderThanMs;
    for (const entry of readdirSync(this.stateRoot, { withFileTypes: true })) {
      const entryPath = path.join(this.stateRoot, entry.name);
      if (entry.isDirectory()) {
        const hasPersistentState =
          existsSync(path.join(entryPath, "monitors.json")) || existsSync(path.join(entryPath, "monitors.lease.json"));
        if (hasPersistentState) continue;
        for (const nested of readdirSync(entryPath, { withFileTypes: true })) {
          const nestedPath = path.join(entryPath, nested.name);
          if (nested.name === "monitors.json" || nested.name === "monitors.lease.json") continue;
          if (nested.isFile() && statSync(nestedPath).mtimeMs < cutoff) rmSync(nestedPath);
        }
        const remaining = readdirSync(entryPath).filter((name) => name !== "monitors.json" && name !== "monitors.lease.json");
        if (remaining.length === 0 && !existsSync(path.join(entryPath, "monitors.json")) && !existsSync(path.join(entryPath, "monitors.lease.json"))) {
          rmSync(entryPath, { recursive: true, force: true });
        }
        continue;
      }
      if (entry.isFile() && statSync(entryPath).mtimeMs < cutoff) rmSync(entryPath);
    }
  }

  rememberSessionCreated(event: EventSessionCreated): void {
    this.rememberSessionInfo(event.properties.info.id, event.properties.info.parentID ?? undefined);
  }

  rememberSessionDeleted(event: EventSessionDeleted): { sessionID: string; isRoot: boolean } {
    const sessionID = event.properties.info.id;
    const isRoot = !event.properties.info.parentID;
    this.sessionRoots.delete(sessionID);
    return { sessionID, isRoot };
  }

  setSessionIdle(sessionID: string, idle: boolean): void {
    this.sessionIdle.set(sessionID, idle);
  }

  rememberSessionInfo(sessionID: string, parentID?: string): void {
    this.sessionRoots.set(sessionID, parentID ? this.sessionRoots.get(parentID) ?? parentID : sessionID);
  }

  async ensureSessionLoaded(sessionID: string): Promise<void> {
    const rootSessionID = await this.resolveRootSessionID(sessionID);
    const priorError = this.loadErrors.get(rootSessionID);
    if (priorError) throw priorError;
    if (this.loadedSessions.has(rootSessionID)) return;
    const pending = this.loadingSessions.get(rootSessionID);
    if (pending) {
      await pending;
      return;
    }

    const load = this.loadPersistentSession(rootSessionID)
      .then(() => {
        this.loadedSessions.add(rootSessionID);
        this.loadErrors.delete(rootSessionID);
      })
      .catch((error) => {
        const normalized = error instanceof Error ? error : new Error(String(error));
        this.loadErrors.set(rootSessionID, normalized);
        throw normalized;
      })
      .finally(() => {
        this.loadingSessions.delete(rootSessionID);
      });

    this.loadingSessions.set(rootSessionID, load);
    await load;
  }

  async startMonitor(input: StartMonitorInput): Promise<MonitorSummary> {
    await this.ensureSessionLoaded(input.ownerSessionID);
    const rootSessionID = await this.resolveRootSessionID(input.ownerSessionID);
    const existing = this.bySession.get(rootSessionID) ?? new Map<string, RuntimeMonitor>();
    if (existing.has(input.label)) {
      const suggestion = this.suggestLabel(input.label, Array.from(existing.keys()));
      throw new Error(`Monitor label '${input.label}' already exists. Try '${suggestion}'.`);
    }

    const allocated = allocateMonitorId({
      requestedId: input.requestedId,
      existingIds: Array.from(existing.values()).map((monitor) => monitor.record.monitorId),
      primeState: this.primeState,
    });
    this.primeState = allocated.primeState;

    const lifetime = input.lifetime ?? "ephemeral";
    if (lifetime === "persistent") this.acquireSessionLease(rootSessionID);
    const runtime = this.createRuntimeMonitor({
      rootSessionID,
      record: {
        ownerSessionID: rootSessionID,
        label: input.label,
        monitorId: allocated.id,
        command: input.command,
        pid: -1,
        capture: input.capture,
        outputFormat: input.outputFormat ?? "compact",
        triggers: input.triggers,
        cwd: input.cwd,
        env: input.env ?? {},
        logPath: this.defaultLogPath(rootSessionID, input.label),
        tagTemplate: input.tagTemplate,
        lifetime,
        sendOnlyLatest: input.sendOnlyLatest ?? false,
        requestedMonitorId: input.requestedId,
        nextSeq: 1,
        pendingLines: [],
        status: "running",
      },
      restoreState: undefined,
      startMode: "spawn",
    });
    existing.set(input.label, runtime);
    this.bySession.set(rootSessionID, existing);
    this.persistSessionState(rootSessionID);
    this.logDebug("monitor.start", {
      ownerSessionID: rootSessionID,
      label: input.label,
      monitorId: runtime.record.monitorId,
      pid: runtime.record.pid,
      cwd: input.cwd,
      logPath: runtime.record.logPath,
      stdoutPath: runtime.stdoutPath,
      stderrPath: runtime.stderrPath,
      lifetime: runtime.record.lifetime,
      sendOnlyLatest: runtime.record.sendOnlyLatest,
    });
    return this.toSummary(runtime);
  }

  async listMonitors(sessionID: string, label?: string): Promise<MonitorSummary[]> {
    await this.ensureSessionLoaded(sessionID);
    const rootSessionID = await this.resolveRootSessionID(sessionID);
    const monitors = this.bySession.get(rootSessionID);
    if (!monitors) return [];
    const values = label ? [monitors.get(label)].filter(Boolean) as RuntimeMonitor[] : Array.from(monitors.values());
    return values.map((value) => this.toSummary(value));
  }

  async fetchPending(sessionID: string, label?: string): Promise<DeliveryBatch[]> {
    await this.ensureSessionLoaded(sessionID);
    const rootSessionID = await this.resolveRootSessionID(sessionID);
    const monitors = this.bySession.get(rootSessionID);
    if (!monitors) return [];

    const values = label ? [monitors.get(label)].filter(Boolean) as RuntimeMonitor[] : Array.from(monitors.values());
    const batches: DeliveryBatch[] = [];
    for (const monitor of values) {
      await this.serializedDrain(monitor, async () => {
        this.drainCapturedFiles(monitor);
        const decision = decideManualFetch(monitor.scheduler);
        if (!decision.deliverNow) return;
        const committed = commitDelivery({
          state: monitor.scheduler,
          monitorId: monitor.record.monitorId,
          sendOnlyLatest: monitor.record.sendOnlyLatest,
        });
        monitor.scheduler = committed.state;
        monitor.record.nextSeq = committed.state.nextSeq;
        monitor.record.pendingLines = committed.state.pendingLines;
        monitor.record.pendingExit = committed.state.pendingExit;
        this.persistSessionState(monitor.record.ownerSessionID);
        this.finalizeCompletedRuntime(monitor);
        batches.push(committed.batch);
      });
    }
    return batches;
  }

  async killMonitor(sessionID: string, label: string, signal: NodeJS.Signals = "SIGTERM"): Promise<MonitorSummary> {
    await this.ensureSessionLoaded(sessionID);
    const rootSessionID = await this.resolveRootSessionID(sessionID);
    const monitor = this.bySession.get(rootSessionID)?.get(label);
    if (!monitor) throw new Error(`Unknown monitor '${label}'.`);
    monitor.record.status = "killed";
    monitor.removalPending = true;
    this.logDebug("monitor.kill", {
      ownerSessionID: rootSessionID,
      label,
      monitorId: monitor.record.monitorId,
      pid: monitor.record.pid,
      signal,
    });
    this.persistSessionState(rootSessionID);
    this.killProcessTree(monitor, signal);
    return this.toSummary(monitor);
  }

  async handleIdle(sessionID: string): Promise<void> {
    await this.ensureSessionLoaded(sessionID);
    const rootSessionID = await this.resolveRootSessionID(sessionID);
    this.setSessionIdle(rootSessionID, true);
    this.logDebug("session.idle", { sessionID, rootSessionID });
    const monitors = this.bySession.get(rootSessionID);
    if (!monitors) return;
    await Promise.all(Array.from(monitors.values()).map((monitor) => this.tryAutoDeliver(monitor, "idle")));
  }

  async handleActivity(sessionID: string): Promise<void> {
    await this.ensureSessionLoaded(sessionID);
    const rootSessionID = await this.resolveRootSessionID(sessionID);
    this.setSessionIdle(rootSessionID, false);
    this.logDebug("session.active", { sessionID, rootSessionID });
  }

  async deleteSession(sessionID: string): Promise<void> {
    await this.ensureSessionLoaded(sessionID).catch(() => {});
    const rootSessionID = await this.resolveRootSessionID(sessionID);
    const monitors = this.bySession.get(rootSessionID);
    if (!monitors) return;
    for (const monitor of monitors.values()) {
      monitor.record.status = "killed";
      monitor.removalPending = true;
      this.killProcessTree(monitor, "SIGTERM");
    }
    this.sessionRoots.delete(rootSessionID);
    this.loadedSessions.delete(rootSessionID);
    this.loadErrors.delete(rootSessionID);
    this.deleteManifest(rootSessionID);
    this.releaseSessionLease(rootSessionID);
  }

  async shutdown(): Promise<void> {
    for (const monitors of this.bySession.values()) {
      for (const monitor of monitors.values()) {
        monitor.destroyed = true;
        this.clearScheduledTimers(monitor);
        this.closeWatchers(monitor);
        this.closeLogStream(monitor);
        try {
          const pid = monitor.process.pid;
          if (pid) process.kill(-pid, "SIGTERM");
        } catch {
          try {
            monitor.process.kill("SIGTERM");
          } catch {
            // best effort
          }
        }
      }
    }
  }

  private createRuntimeMonitor(input: {
    rootSessionID: string;
    record: MonitorRecord;
    restoreState?: PersistentMonitorSnapshot;
    startMode: "spawn" | "attach";
  }): RuntimeMonitor {
    const sessionDir = this.sessionDir(input.rootSessionID);
    mkdirSync(sessionDir, { recursive: true });
    const stdoutPath = input.restoreState?.stdoutPath ?? path.join(sessionDir, `${input.record.label}.stdout.log`);
    const stderrPath = input.restoreState?.stderrPath ?? path.join(sessionDir, `${input.record.label}.stderr.log`);
    this.ensureFile(stdoutPath);
    this.ensureFile(stderrPath);

    const processHandle =
      input.startMode === "attach"
        ? this.createAttachedProcessHandle(input.restoreState?.pid ?? input.record.pid)
        : this.spawnCapturedProcess(input.record.command, stdoutPath, stderrPath, input.record.cwd, input.record.env);

    input.record.pid = processHandle.pid ?? input.restoreState?.pid ?? input.record.pid;

    const runtime: RuntimeMonitor = {
      record: input.record,
      process: processHandle,
      scheduler: {
        pendingLines: input.restoreState?.pendingLines ?? [],
        pendingExit: input.restoreState?.pendingExit,
        nextSeq: input.restoreState?.nextSeq ?? input.record.nextSeq,
      },
      stdoutCollector: { remainder: input.restoreState?.stdoutRemainder ?? "" },
      stderrCollector: { remainder: input.restoreState?.stderrRemainder ?? "" },
      stdoutPath,
      stderrPath,
      stdoutOffset: input.restoreState?.stdoutOffset ?? 0,
      stderrOffset: input.restoreState?.stderrOffset ?? 0,
      stdoutWatcher: null,
      stderrWatcher: null,
      logStream: createWriteStream(input.record.logPath, { flags: "a" }),
      logFailed: false,
      draining: null,
      destroyed: false,
      closed: false,
      removalPending: false,
      debounceTimer: null,
      intervalTimers: [],
      healthTimer: null,
    };

    runtime.record.nextSeq = runtime.scheduler.nextSeq;
    runtime.record.pendingLines = runtime.scheduler.pendingLines;
    runtime.record.pendingExit = runtime.scheduler.pendingExit;

    runtime.logStream.on("error", () => {
      runtime.logFailed = true;
    });

    this.attachProcess(runtime);
    this.attachFileWatchers(runtime);
    this.setupIntervalTimers(runtime);
    this.setupHealthTimer(runtime);
    return runtime;
  }

  private spawnCapturedProcess(
    command: string,
    stdoutPath: string,
    stderrPath: string,
    cwd: string,
    env: Record<string, string>,
  ): ProcessHandle {
    const child = this.spawnProcess(this.buildCapturedCommand(command, stdoutPath, stderrPath), {
      cwd,
      env: { ...process.env, ...env },
      shell: true,
      detached: true,
      stdio: "ignore",
    });
    child.unref?.();
    return child;
  }

  private createAttachedProcessHandle(pid: number): ProcessHandle {
    return {
      pid,
      kill: (signal?: NodeJS.Signals) => {
        if (!pid) return;
        process.kill(pid, signal);
      },
    };
  }

  private attachProcess(runtime: RuntimeMonitor): void {
    const onLines = (stream: "stdout" | "stderr", lines: string[]) => {
      for (const line of lines) this.ingestLine(runtime, stream, line);
    };

    runtime.process.stdout?.on?.("data", (chunk: Buffer | string) => {
      const result = appendChunk(runtime.stdoutCollector, chunk.toString());
      runtime.stdoutCollector = result.state;
      onLines("stdout", result.lines);
    });
    runtime.process.stderr?.on?.("data", (chunk: Buffer | string) => {
      const result = appendChunk(runtime.stderrCollector, chunk.toString());
      runtime.stderrCollector = result.state;
      onLines("stderr", result.lines);
    });

    runtime.process.on?.("close", (code, signal) => {
      this.handleObservedProcessExit(runtime, code, signal ?? null);
    });
  }

  private attachFileWatchers(runtime: RuntimeMonitor): void {
    runtime.stdoutWatcher = this.watchStreamFile(runtime, "stdout", runtime.stdoutPath);
    runtime.stderrWatcher = this.watchStreamFile(runtime, "stderr", runtime.stderrPath);
  }

  private ingestLine(runtime: RuntimeMonitor, stream: "stdout" | "stderr", content: string): void {
    if (runtime.closed || runtime.removalPending) return;
    if (runtime.record.capture === "stdout" && stream !== "stdout") return;
    if (runtime.record.capture === "stderr" && stream !== "stderr") return;

    const line: IngestedLine = {
      stream,
      content,
      ingestedAt: this.now(),
    };
    runtime.scheduler.pendingLines = [...runtime.scheduler.pendingLines, line];
    runtime.record.pendingLines = runtime.scheduler.pendingLines;
    if (!runtime.logFailed) {
      runtime.logStream.write(`[${formatDateTime(line.ingestedAt)}] [${stream}] ${content}\n`);
    }
    this.persistSessionState(runtime.record.ownerSessionID);
    this.logDebug("line.ingested", {
      ownerSessionID: runtime.record.ownerSessionID,
      label: runtime.record.label,
      monitorId: runtime.record.monitorId,
      stream,
      pendingCount: runtime.scheduler.pendingLines.length,
      contentBytes: Buffer.byteLength(content),
    });

    const decision = decideLineEvent({
      state: runtime.scheduler,
      line,
      triggers: runtime.record.triggers,
      sessionIsIdle: this.sessionIdle.get(runtime.record.ownerSessionID) ?? false,
      now: line.ingestedAt,
    });

    if (decision.debounceUntil) {
      runtime.scheduler.debounceUntil = decision.debounceUntil;
      this.scheduleDebounce(runtime, decision.debounceUntil - this.now());
    }
    if (decision.deliverNow) {
      const reason = decision.reason === "fetch" ? "line" : (decision.reason ?? "line");
      this.fireAndForgetDeliver(runtime, reason);
    }
  }

  private async tryAutoDeliver(runtime: RuntimeMonitor, reason: "line" | "idle" | "interval" | "exit"): Promise<void> {
    await this.serializedDrain(runtime, async () => {
      this.drainCapturedFiles(runtime);
      const decision =
        reason === "idle"
          ? decideTimeEvent({
              state: runtime.scheduler,
              triggers: runtime.record.triggers,
              sessionIsIdle: true,
              now: this.now(),
              kind: "idle",
            })
          : reason === "interval"
            ? decideTimeEvent({
                state: runtime.scheduler,
                triggers: runtime.record.triggers,
                sessionIsIdle: this.sessionIdle.get(runtime.record.ownerSessionID) ?? false,
                now: this.now(),
                kind: "interval",
              })
            : runtime.scheduler.pendingExit && runtime.scheduler.pendingLines.length === 0
              ? { deliverNow: true, reason: "exit" as const }
              : { deliverNow: runtime.scheduler.pendingLines.length > 0, reason };

      if (!decision.deliverNow) return;
      const before = runtime.scheduler;
      const committed = commitDelivery({
        state: runtime.scheduler,
        monitorId: runtime.record.monitorId,
        sendOnlyLatest: runtime.record.sendOnlyLatest,
      });
      this.logDebug("delivery.attempt", {
        ownerSessionID: runtime.record.ownerSessionID,
        label: runtime.record.label,
        monitorId: runtime.record.monitorId,
        reason,
        seq: committed.batch.seq,
        lineCount: committed.batch.lines.length,
        hasExit: Boolean(committed.batch.exit),
      });
      try {
        await this.promptAsync(runtime.record.ownerSessionID, formatBatchXml({ record: runtime.record, batch: committed.batch }));
        runtime.scheduler = committed.state;
        runtime.record.nextSeq = committed.state.nextSeq;
        runtime.record.pendingLines = committed.state.pendingLines;
        runtime.record.pendingExit = committed.state.pendingExit;
        this.persistSessionState(runtime.record.ownerSessionID);
        this.logDebug("delivery.success", {
          ownerSessionID: runtime.record.ownerSessionID,
          label: runtime.record.label,
          monitorId: runtime.record.monitorId,
          reason,
          seq: committed.batch.seq,
          lineCount: committed.batch.lines.length,
          hasExit: Boolean(committed.batch.exit),
        });
        this.finalizeCompletedRuntime(runtime);
      } catch {
        runtime.scheduler = before;
        runtime.record.pendingLines = before.pendingLines;
        runtime.record.pendingExit = before.pendingExit;
        this.persistSessionState(runtime.record.ownerSessionID);
        this.logDebug("delivery.failure", {
          ownerSessionID: runtime.record.ownerSessionID,
          label: runtime.record.label,
          monitorId: runtime.record.monitorId,
          reason,
          seq: committed.batch.seq,
          lineCount: committed.batch.lines.length,
          hasExit: Boolean(committed.batch.exit),
        });
        throw new Error("promptAsync delivery failed");
      }
    });
  }

  private async serializedDrain(runtime: RuntimeMonitor, work: () => Promise<void>): Promise<void> {
    const prior = runtime.draining ?? Promise.resolve();
    const current = prior.then(work, work).finally(() => {
      if (runtime.draining === current) runtime.draining = null;
    });
    runtime.draining = current;
    await current;
  }

  private handleObservedProcessExit(runtime: RuntimeMonitor, code: number | null, signal: string | null): void {
    if (runtime.record.status !== "running" && !runtime.removalPending) return;
    this.clearScheduledTimers(runtime);
    this.drainCapturedFiles(runtime);
    if (runtime.removalPending) {
      this.closeLogStream(runtime);
      this.removeRuntime(runtime);
      return;
    }

    const stdoutFlushed = flushRemainder(runtime.stdoutCollector);
    runtime.stdoutCollector = stdoutFlushed.state;
    for (const line of stdoutFlushed.lines) this.ingestLine(runtime, "stdout", line);
    const stderrFlushed = flushRemainder(runtime.stderrCollector);
    runtime.stderrCollector = stderrFlushed.state;
    for (const line of stderrFlushed.lines) this.ingestLine(runtime, "stderr", line);

    runtime.record.status = runtime.record.status === "killed" ? "killed" : "exited";
    runtime.scheduler.pendingExit = {
      exitCode: code,
      signal,
      occurredAt: this.now(),
    };
    runtime.record.pendingExit = runtime.scheduler.pendingExit;
    runtime.record.pendingLines = runtime.scheduler.pendingLines;
    this.persistSessionState(runtime.record.ownerSessionID);
    this.logDebug("process.close", {
      ownerSessionID: runtime.record.ownerSessionID,
      label: runtime.record.label,
      monitorId: runtime.record.monitorId,
      pid: runtime.record.pid,
      code,
      signal,
    });
    this.fireAndForgetDeliver(runtime, "exit");
  }

  private killProcessTree(runtime: RuntimeMonitor, signal: NodeJS.Signals): void {
    if (runtime.debounceTimer) {
      this.clearTimer(runtime.debounceTimer);
      runtime.debounceTimer = null;
    }
    for (const timer of runtime.intervalTimers) this.clearTimer(timer);
    runtime.intervalTimers = [];
    this.closeWatchers(runtime);
    const pid = runtime.process.pid;
    if (!pid) return;
    try {
      process.kill(-pid, signal);
    } catch {
      try {
        runtime.process.kill(signal);
      } catch {
        // best effort
      }
    }
  }

  private isProcessAlive(pid: number): boolean {
    if (!pid || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private suggestLabel(label: string, existingLabels: string[]): string {
    let state = this.primeState;
    while (true) {
      const allocated = allocateMonitorId({ requestedId: label, existingIds: existingLabels, primeState: state });
      if (!existingLabels.includes(allocated.id)) return allocated.id;
      state = allocated.primeState;
    }
  }

  private scheduleDebounce(runtime: RuntimeMonitor, delay: number): void {
    if (runtime.debounceTimer) this.clearTimer(runtime.debounceTimer);
    runtime.debounceTimer = this.setTimer(() => {
      runtime.debounceTimer = null;
      this.fireAndForgetDeliver(runtime, "line");
    }, Math.max(0, delay));
  }

  private setupIntervalTimers(runtime: RuntimeMonitor): void {
    const intervalTriggers = runtime.record.triggers.filter((trigger) => trigger.type === "interval");
    for (const trigger of intervalTriggers) {
      if (trigger.everyMs <= 0) continue;
      const schedule = () => {
        if (runtime.destroyed || runtime.closed) return;
        const now = this.now();
        const offsetMs = trigger.offsetMs ?? 0;
        const elapsed = Math.max(0, now - offsetMs);
        const remainder = elapsed % trigger.everyMs;
        const delay = now < offsetMs ? offsetMs - now : remainder === 0 ? trigger.everyMs : trigger.everyMs - remainder;
        const handle = this.setTimer(() => {
          runtime.intervalTimers = runtime.intervalTimers.filter((timer) => timer !== handle);
          this.fireAndForgetDeliver(runtime, "interval");
          schedule();
        }, delay);
        runtime.intervalTimers.push(handle);
      };
      schedule();
    }
  }

  private setupHealthTimer(runtime: RuntimeMonitor): void {
    const schedule = () => {
      if (runtime.destroyed || runtime.closed) return;
      runtime.healthTimer = setTimeout(() => {
        runtime.healthTimer = null;
        if (runtime.destroyed || runtime.closed || runtime.record.status !== "running") return;
        if (!this.isProcessAlive(runtime.record.pid)) {
          this.handleObservedProcessExit(runtime, null, null);
          return;
        }
        schedule();
      }, 1_000);
    };
    schedule();
  }

  private async resolveRootSessionID(sessionID: string): Promise<string> {
    const seen = new Set<string>();
    let current = sessionID;
    while (!seen.has(current)) {
      seen.add(current);
      const cached = this.sessionRoots.get(current);
      if (!cached) break;
      if (cached === current) return current;
      current = cached;
    }
    const resolved = await this.getRootSessionID(sessionID);
    this.sessionRoots.set(sessionID, resolved);
    this.sessionRoots.set(resolved, resolved);
    return resolved;
  }

  private clearScheduledTimers(runtime: RuntimeMonitor): void {
    if (runtime.debounceTimer) {
      this.clearTimer(runtime.debounceTimer);
      runtime.debounceTimer = null;
    }
    if (runtime.healthTimer) {
      clearTimeout(runtime.healthTimer);
      runtime.healthTimer = null;
    }
    for (const timer of runtime.intervalTimers) this.clearTimer(timer);
    runtime.intervalTimers = [];
  }

  private closeLogStream(runtime: RuntimeMonitor): void {
    if (runtime.closed) return;
    runtime.closed = true;
    runtime.logStream.end();
  }

  private finalizeCompletedRuntime(runtime: RuntimeMonitor): void {
    if (runtime.record.status === "running") return;
    if (runtime.scheduler.pendingLines.length > 0) return;
    if (runtime.scheduler.pendingExit) return;
    this.removeRuntime(runtime);
  }

  private fireAndForgetDeliver(runtime: RuntimeMonitor, reason: "line" | "idle" | "interval" | "exit"): void {
    void this.tryAutoDeliver(runtime, reason).catch(() => {
      // Preserve pending state and avoid unhandled rejections on background delivery paths.
    });
  }

  private removeRuntime(runtime: RuntimeMonitor): void {
    if (runtime.destroyed && !this.bySession.get(runtime.record.ownerSessionID)?.has(runtime.record.label)) return;
    runtime.destroyed = true;
    this.clearScheduledTimers(runtime);
    this.closeWatchers(runtime);
    this.closeLogStream(runtime);
    const monitors = this.bySession.get(runtime.record.ownerSessionID);
    monitors?.delete(runtime.record.label);
    if (monitors && monitors.size === 0) this.bySession.delete(runtime.record.ownerSessionID);
    this.persistSessionState(runtime.record.ownerSessionID);
    this.logDebug("monitor.remove", {
      ownerSessionID: runtime.record.ownerSessionID,
      label: runtime.record.label,
      monitorId: runtime.record.monitorId,
      pid: runtime.record.pid,
      status: runtime.record.status,
    });
  }

  private toSummary(runtime: RuntimeMonitor): MonitorSummary {
    return {
      ownerSessionID: runtime.record.ownerSessionID,
      label: runtime.record.label,
      monitorId: runtime.record.monitorId,
      pid: runtime.record.pid,
      status: runtime.record.status,
      pendingCount: runtime.scheduler.pendingLines.length,
      capture: runtime.record.capture,
      outputFormat: runtime.record.outputFormat,
      triggers: runtime.record.triggers,
      logPath: runtime.record.logPath,
      lifetime: runtime.record.lifetime,
      sendOnlyLatest: runtime.record.sendOnlyLatest,
    };
  }

  private async loadPersistentSession(rootSessionID: string): Promise<void> {
    const manifest = this.readManifest(rootSessionID);
    if (!manifest || manifest.monitors.length === 0) return;
    this.acquireSessionLease(rootSessionID);

    const existing = this.bySession.get(rootSessionID) ?? new Map<string, RuntimeMonitor>();
    for (const snapshot of manifest.monitors) {
      if (snapshot.status !== "running") continue;
      if (existing.has(snapshot.label)) continue;
      const record: MonitorRecord = {
        ownerSessionID: rootSessionID,
        label: snapshot.label,
        monitorId: snapshot.monitorId,
        command: snapshot.command,
        pid: snapshot.pid,
        capture: snapshot.capture,
        outputFormat: snapshot.outputFormat,
        triggers: snapshot.triggers,
        cwd: snapshot.cwd,
        env: snapshot.env,
        logPath: snapshot.logPath,
        tagTemplate: snapshot.tagTemplate,
        lifetime: snapshot.lifetime,
        sendOnlyLatest: snapshot.sendOnlyLatest,
        requestedMonitorId: snapshot.requestedMonitorId,
        nextSeq: snapshot.nextSeq,
        pendingLines: snapshot.pendingLines,
        pendingExit: snapshot.pendingExit,
        status: "running",
      };
      const runtime = this.createRuntimeMonitor({
        rootSessionID,
        record,
        restoreState: snapshot,
        startMode: this.isProcessAlive(snapshot.pid) ? "attach" : "spawn",
      });
      existing.set(record.label, runtime);
    }
    if (existing.size > 0) this.bySession.set(rootSessionID, existing);
    this.persistSessionState(rootSessionID);
  }

  private persistSessionState(rootSessionID: string): void {
    const monitors = this.bySession.get(rootSessionID);
    const persistent = monitors
      ? Array.from(monitors.values())
          .filter(
            (runtime) =>
              runtime.record.lifetime === "persistent" &&
              runtime.record.status === "running" &&
              !runtime.removalPending,
          )
          .map((runtime) => this.snapshotRuntime(runtime))
      : [];

    if (persistent.length === 0) {
      this.deleteManifest(rootSessionID);
      this.releaseSessionLease(rootSessionID);
      return;
    }

    this.acquireSessionLease(rootSessionID);
    const manifest: SessionMonitorsManifest = {
      version: 1,
      rootSessionID,
      monitors: persistent,
    };
    this.writeJsonAtomic(this.manifestPath(rootSessionID), manifest);
  }

  private snapshotRuntime(runtime: RuntimeMonitor): PersistentMonitorSnapshot {
    return {
      ownerSessionID: runtime.record.ownerSessionID,
      label: runtime.record.label,
      monitorId: runtime.record.monitorId,
      command: runtime.record.command,
      pid: runtime.record.pid,
      capture: runtime.record.capture,
      outputFormat: runtime.record.outputFormat,
      triggers: runtime.record.triggers,
      cwd: runtime.record.cwd,
      env: runtime.record.env,
      logPath: runtime.record.logPath,
      stdoutPath: runtime.stdoutPath,
      stderrPath: runtime.stderrPath,
      stdoutOffset: runtime.stdoutOffset,
      stderrOffset: runtime.stderrOffset,
      stdoutRemainder: runtime.stdoutCollector.remainder,
      stderrRemainder: runtime.stderrCollector.remainder,
      tagTemplate: runtime.record.tagTemplate,
      lifetime: runtime.record.lifetime,
      sendOnlyLatest: runtime.record.sendOnlyLatest,
      requestedMonitorId: runtime.record.requestedMonitorId,
      nextSeq: runtime.scheduler.nextSeq,
      pendingLines: runtime.scheduler.pendingLines,
      pendingExit: runtime.scheduler.pendingExit,
      status: runtime.record.status,
    };
  }

  private acquireSessionLease(rootSessionID: string): void {
    if (this.leasedSessions.has(rootSessionID)) return;
    const existing = this.readLease(rootSessionID);
    if (existing && existing.ownerPid !== process.pid && this.isProcessAlive(existing.ownerPid)) {
      throw new Error(`Persistent monitors for session '${rootSessionID}' are already owned by pid ${existing.ownerPid}.`);
    }
    const lease: SessionLeaseRecord = {
      version: 1,
      rootSessionID,
      ownerPid: process.pid,
      acquiredAt: this.now(),
    };
    this.writeJsonAtomic(this.leasePath(rootSessionID), lease);
    this.leasedSessions.add(rootSessionID);
  }

  private releaseSessionLease(rootSessionID: string): void {
    const lease = this.readLease(rootSessionID);
    if (lease?.ownerPid === process.pid) {
      try {
        unlinkSync(this.leasePath(rootSessionID));
      } catch {
        // best effort
      }
    }
    this.leasedSessions.delete(rootSessionID);
  }

  private readManifest(rootSessionID: string): SessionMonitorsManifest | null {
    const filePath = this.manifestPath(rootSessionID);
    if (!existsSync(filePath)) return null;
    return JSON.parse(readFileSync(filePath, "utf8")) as SessionMonitorsManifest;
  }

  private readLease(rootSessionID: string): SessionLeaseRecord | null {
    const filePath = this.leasePath(rootSessionID);
    if (!existsSync(filePath)) return null;
    return JSON.parse(readFileSync(filePath, "utf8")) as SessionLeaseRecord;
  }

  private deleteManifest(rootSessionID: string): void {
    try {
      unlinkSync(this.manifestPath(rootSessionID));
    } catch {
      // best effort
    }
  }

  private writeJsonAtomic(filePath: string, value: unknown): void {
    mkdirSync(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.tmp-${process.pid}`;
    writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`);
    renameSync(tempPath, filePath);
  }

  private sessionDir(rootSessionID: string): string {
    return path.join(this.stateRoot, rootSessionID);
  }

  private manifestPath(rootSessionID: string): string {
    return path.join(this.sessionDir(rootSessionID), "monitors.json");
  }

  private leasePath(rootSessionID: string): string {
    return path.join(this.sessionDir(rootSessionID), "monitors.lease.json");
  }

  private defaultLogPath(rootSessionID: string, label: string): string {
    return path.join(this.sessionDir(rootSessionID), `${label}.log`);
  }

  private fireAndForgetDrain(runtime: RuntimeMonitor): void {
    void this.serializedDrain(runtime, async () => {
      this.drainCapturedFiles(runtime);
    }).catch(() => {
      // Ignore watcher races and preserve delivery state.
    });
  }

  private drainCapturedFiles(runtime: RuntimeMonitor): void {
    this.drainCapturedStream(runtime, "stdout");
    this.drainCapturedStream(runtime, "stderr");
  }

  private drainCapturedStream(runtime: RuntimeMonitor, stream: "stdout" | "stderr"): void {
    const filePath = stream === "stdout" ? runtime.stdoutPath : runtime.stderrPath;
    const offset = stream === "stdout" ? runtime.stdoutOffset : runtime.stderrOffset;
    const collector = stream === "stdout" ? runtime.stdoutCollector : runtime.stderrCollector;
    const chunk = this.readAppendedChunk(filePath, offset);
    if (!chunk) return;

    const result = appendChunk(collector, chunk.text);
    if (stream === "stdout") {
      runtime.stdoutCollector = result.state;
      runtime.stdoutOffset = chunk.nextOffset;
    } else {
      runtime.stderrCollector = result.state;
      runtime.stderrOffset = chunk.nextOffset;
    }
    if (result.lines.length > 0) {
      this.logDebug("capture.drain", {
        ownerSessionID: runtime.record.ownerSessionID,
        label: runtime.record.label,
        monitorId: runtime.record.monitorId,
        stream,
        bytes: chunk.text.length,
        lines: result.lines.length,
      });
    }
    for (const line of result.lines) this.ingestLine(runtime, stream, line);
  }

  private readAppendedChunk(filePath: string, offset: number): { text: string; nextOffset: number } | null {
    let size: number;
    try {
      size = statSync(filePath).size;
    } catch {
      return null;
    }
    const start = size < offset ? 0 : offset;
    if (size <= start) return null;

    const fd = openSync(filePath, "r");
    try {
      const buffer = Buffer.allocUnsafe(size - start);
      const bytesRead = readSync(fd, buffer, 0, buffer.length, start);
      if (bytesRead <= 0) return null;
      return {
        text: buffer.subarray(0, bytesRead).toString(),
        nextOffset: start + bytesRead,
      };
    } finally {
      closeSync(fd);
    }
  }

  private watchStreamFile(runtime: RuntimeMonitor, stream: "stdout" | "stderr", filePath: string): FSWatcher | null {
    try {
      return watch(filePath, { persistent: false }, (eventType) => {
        if (runtime.closed || runtime.destroyed || runtime.removalPending) return;
        if (eventType !== "change") return;
        this.logDebug("capture.watch", {
          ownerSessionID: runtime.record.ownerSessionID,
          label: runtime.record.label,
          monitorId: runtime.record.monitorId,
          stream,
        });
        this.fireAndForgetDrain(runtime);
      });
    } catch {
      return null;
    }
  }

  private closeWatchers(runtime: RuntimeMonitor): void {
    for (const watcher of [runtime.stdoutWatcher, runtime.stderrWatcher]) {
      if (!watcher) continue;
      try {
        watcher.close();
      } catch {
        // best effort
      }
    }
    runtime.stdoutWatcher = null;
    runtime.stderrWatcher = null;
  }

  private ensureFile(filePath: string): void {
    const fd = openSync(filePath, "a");
    closeSync(fd);
  }

  private buildCapturedCommand(command: string, stdoutPath: string, stderrPath: string): string {
    return `(${command}) >> ${this.quoteShellArg(stdoutPath)} 2>> ${this.quoteShellArg(stderrPath)}`;
  }

  private quoteShellArg(value: string): string {
    return `'${value.replaceAll("'", `'\\''`)}'`;
  }

  private logDebug(event: string, details: Record<string, unknown> = {}): void {
    if (!this.debugEnabled || !this.debugLogPath) return;
    appendDebugLog(this.debugLogPath, this.now(), event, details);
  }
}

export async function resolveRootSessionID(client: { session: { get: (options: { path: { id: string } }) => Promise<{ data?: Session }> } }, sessionID: string): Promise<string> {
  let current = sessionID;
  while (true) {
    const result = await client.session.get({ path: { id: current } });
    const session = result.data;
    const parentID = session?.parentID;
    if (!parentID) return current;
    current = parentID;
  }
}
