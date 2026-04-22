import { describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { EventEmitter } from "events";
import os from "os";
import path from "path";

import { MonitorManager } from "../lib/runtime.ts";

type FakeChild = EventEmitter & {
  pid: number;
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: (signal?: NodeJS.Signals) => void;
};

function createFakeChild(pid = 12345): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  return child;
}

describe("runtime", () => {
  test("root-session ownership resolution keeps monitors under root", async () => {
    const fakeChild = createFakeChild();
    const promptAsync = mock(async () => {});
    const manager = new MonitorManager({
      stateRoot: "/tmp/opencode-monitor-runtime-test-1",
      promptAsync,
      getRootSessionID: async () => "root-1",
      now: () => Date.parse("2026-04-21T12:00:00Z"),
      spawnProcess: (() => fakeChild) as any,
    });

    const start = await manager.startMonitor({
      ownerSessionID: "child-1",
      label: "server",
      command: "ignored",
      capture: "stdout",
      cwd: "/tmp",
      triggers: [{ type: "idle" }],
      tagTemplate: "monitor_{id}",
    });

    expect(start.ownerSessionID).toBe("root-1");
    const listed = await manager.listMonitors("child-1");
    expect(listed).toHaveLength(1);
    expect(listed[0]?.ownerSessionID).toBe("root-1");
  });

  test("multi-level cached session ancestry still resolves to root", async () => {
    const fakeChild = createFakeChild();
    const manager = new MonitorManager({
      stateRoot: "/tmp/opencode-monitor-runtime-test-1b",
      promptAsync: async () => {},
      getRootSessionID: async () => "root-1b",
      now: () => Date.parse("2026-04-21T12:00:00Z"),
      spawnProcess: (() => fakeChild) as any,
    });

    manager.rememberSessionCreated({
      type: "session.created",
      properties: { info: { id: "root-1b" } },
    } as any);
    manager.rememberSessionCreated({
      type: "session.created",
      properties: { info: { id: "child-1b", parentID: "root-1b" } },
    } as any);
    manager.rememberSessionCreated({
      type: "session.created",
      properties: { info: { id: "grandchild-1b", parentID: "child-1b" } },
    } as any);

    const start = await manager.startMonitor({
      ownerSessionID: "grandchild-1b",
      label: "server",
      command: "ignored",
      capture: "stdout",
      cwd: "/tmp",
      triggers: [{ type: "idle" }],
      tagTemplate: "monitor_{id}",
    });

    expect(start.ownerSessionID).toBe("root-1b");
  });

  test("fetchPending returns pending state without injection", async () => {
    const fakeChild = createFakeChild();
    const promptAsync = mock(async () => {});
    const manager = new MonitorManager({
      stateRoot: "/tmp/opencode-monitor-runtime-test-2",
      promptAsync,
      getRootSessionID: async (sessionID) => sessionID,
      now: () => Date.parse("2026-04-21T12:00:00Z"),
      spawnProcess: (() => fakeChild) as any,
    });

    await manager.startMonitor({
      ownerSessionID: "root-2",
      label: "server",
      command: "ignored",
      capture: "stdout",
      cwd: "/tmp",
      triggers: [{ type: "line", windowMs: 60_000 }],
      tagTemplate: "monitor_{id}",
    });

    fakeChild.stdout.emit("data", Buffer.from("hello\n"));
    const batches = await manager.fetchPending("root-2", "server");
    expect(batches.length).toBe(1);
    expect(batches[0]?.lines[0]?.content).toBe("hello");
    expect(promptAsync).not.toHaveBeenCalled();
  });

  test("duplicate label rejection suggests a prime-suffixed label", async () => {
    const fakeChild = createFakeChild();
    const manager = new MonitorManager({
      stateRoot: "/tmp/opencode-monitor-runtime-test-3",
      promptAsync: async () => {},
      getRootSessionID: async () => "root-3",
      now: () => Date.parse("2026-04-21T12:00:00Z"),
      spawnProcess: (() => fakeChild) as any,
    });

    await manager.startMonitor({
      ownerSessionID: "root-3",
      label: "server",
      command: "ignored",
      capture: "stdout",
      cwd: "/tmp",
      triggers: [{ type: "idle" }],
      tagTemplate: "monitor_{id}",
    });

    await expect(
      manager.startMonitor({
        ownerSessionID: "root-3",
        label: "server",
        command: "ignored",
        capture: "stdout",
        cwd: "/tmp",
        triggers: [{ type: "idle" }],
        tagTemplate: "monitor_{id}",
      }),
    ).rejects.toThrow("Try 'server-");
  });

  test("deleteSession tears down root-session monitors", async () => {
    const fakeChild = createFakeChild();
    const killed: string[] = [];
    fakeChild.kill = (signal) => {
      killed.push(signal ?? "SIGTERM");
    };
    const manager = new MonitorManager({
      stateRoot: "/tmp/opencode-monitor-runtime-test-4",
      promptAsync: async () => {},
      getRootSessionID: async () => "root-4",
      now: () => Date.parse("2026-04-21T12:00:00Z"),
      spawnProcess: (() => fakeChild) as any,
    });

    await manager.startMonitor({
      ownerSessionID: "root-4",
      label: "server",
      command: "ignored",
      capture: "stdout",
      cwd: "/tmp",
      triggers: [{ type: "idle" }],
      tagTemplate: "monitor_{id}",
    });

    await manager.deleteSession("root-4");
    expect(await manager.listMonitors("root-4")).toHaveLength(1);

    fakeChild.emit("close", 0, null);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await manager.listMonitors("root-4")).toEqual([]);
    expect(killed.length).toBeGreaterThanOrEqual(1);
  });

  test("deleting a child session does not tear down root-owned monitors", async () => {
    const fakeChild = createFakeChild();
    const manager = new MonitorManager({
      stateRoot: "/tmp/opencode-monitor-runtime-test-4b",
      promptAsync: async () => {},
      getRootSessionID: async (sessionID) => (sessionID === "child-4b" ? "root-4b" : sessionID),
      now: () => Date.parse("2026-04-21T12:00:00Z"),
      spawnProcess: (() => fakeChild) as any,
    });

    manager.rememberSessionCreated({
      type: "session.created",
      properties: { info: { id: "root-4b" } },
    } as any);
    manager.rememberSessionCreated({
      type: "session.created",
      properties: { info: { id: "child-4b", parentID: "root-4b" } },
    } as any);

    await manager.startMonitor({
      ownerSessionID: "root-4b",
      label: "server",
      command: "ignored",
      capture: "stdout",
      cwd: "/tmp",
      triggers: [{ type: "idle" }],
      tagTemplate: "monitor_{id}",
    });

    const deleted = manager.rememberSessionDeleted({
      type: "session.deleted",
      properties: { info: { id: "child-4b", parentID: "root-4b" } },
    } as any);
    expect(deleted.isRoot).toBeFalse();
    expect(await manager.listMonitors("root-4b")).toHaveLength(1);
  });

  test("line debounce schedules later delivery with fake timer", async () => {
    const fakeChild = createFakeChild();
    const timers: Array<() => void> = [];
    const promptAsync = mock(async () => {});
    const manager = new MonitorManager({
      stateRoot: "/tmp/opencode-monitor-runtime-test-5",
      promptAsync,
      getRootSessionID: async () => "root-5",
      now: () => Date.parse("2026-04-21T12:00:00Z"),
      spawnProcess: (() => fakeChild) as any,
      setTimer: ((callback: () => void) => {
        timers.push(callback);
        return timers.length as any;
      }) as any,
      clearTimer: (() => {}) as any,
    });

    await manager.startMonitor({
      ownerSessionID: "root-5",
      label: "server",
      command: "ignored",
      capture: "stdout",
      cwd: "/tmp",
      triggers: [{ type: "line", windowMs: 5_000 }],
      tagTemplate: "monitor_{id}",
    });

    fakeChild.stdout.emit("data", Buffer.from("hello\n"));
    expect(promptAsync).not.toHaveBeenCalled();
    expect(timers).toHaveLength(1);

    await timers[0]?.();
    expect(promptAsync).toHaveBeenCalledTimes(1);
  });

  test("background debounce delivery swallows promptAsync rejection and preserves pending output", async () => {
    const fakeChild = createFakeChild();
    const timers: Array<() => void> = [];
    const promptAsync = mock(async () => {
      throw new Error("boom");
    });
    const manager = new MonitorManager({
      stateRoot: "/tmp/opencode-monitor-runtime-test-5b",
      promptAsync,
      getRootSessionID: async () => "root-5b",
      now: () => Date.parse("2026-04-21T12:00:00Z"),
      spawnProcess: (() => fakeChild) as any,
      setTimer: ((callback: () => void) => {
        timers.push(callback);
        return timers.length as any;
      }) as any,
      clearTimer: (() => {}) as any,
    });

    await manager.startMonitor({
      ownerSessionID: "root-5b",
      label: "server",
      command: "ignored",
      capture: "stdout",
      cwd: "/tmp",
      triggers: [{ type: "line", windowMs: 5_000 }],
      tagTemplate: "monitor_{id}",
    });

    fakeChild.stdout.emit("data", Buffer.from("hello\n"));
    await timers[0]?.();
    const batches = await manager.fetchPending("root-5b", "server");
    expect(batches).toHaveLength(1);
    expect(batches[0]?.lines[0]?.content).toBe("hello");
  });

  test("promptAsync failure keeps pending data available for fetch", async () => {
    const fakeChild = createFakeChild();
    const promptAsync = mock(async () => {
      throw new Error("boom");
    });
    const manager = new MonitorManager({
      stateRoot: "/tmp/opencode-monitor-runtime-test-6",
      promptAsync,
      getRootSessionID: async () => "root-6",
      now: () => Date.parse("2026-04-21T12:00:00Z"),
      spawnProcess: (() => fakeChild) as any,
    });

    await manager.startMonitor({
      ownerSessionID: "root-6",
      label: "server",
      command: "ignored",
      capture: "stdout",
      cwd: "/tmp",
      triggers: [{ type: "idle" }],
      tagTemplate: "monitor_{id}",
    });

    fakeChild.stdout.emit("data", Buffer.from("hello\n"));
    await manager.handleIdle("root-6").catch(() => {});
    const batches = await manager.fetchPending("root-6", "server");
    expect(batches).toHaveLength(1);
    expect(batches[0]?.lines[0]?.content).toBe("hello");
  });

  test("idle trigger flushes buffered lines as XML on idle transition", async () => {
    const fakeChild = createFakeChild();
    const promptAsync = mock(async () => {});
    const manager = new MonitorManager({
      stateRoot: "/tmp/opencode-monitor-runtime-test-6b",
      promptAsync,
      getRootSessionID: async () => "root-6b",
      now: () => Date.parse("2026-04-21T12:00:00Z"),
      spawnProcess: (() => fakeChild) as any,
    });

    await manager.startMonitor({
      ownerSessionID: "root-6b",
      label: "server",
      command: "ignored",
      capture: "stdout",
      cwd: "/tmp",
      triggers: [{ type: "idle" }],
      tagTemplate: "idle_{id}",
    });

    fakeChild.stdout.emit("data", Buffer.from("hello\n"));
    expect(promptAsync).not.toHaveBeenCalled();

    await manager.handleIdle("root-6b");

    expect(promptAsync).toHaveBeenCalledTimes(1);
    expect(promptAsync).toHaveBeenCalledWith(
      "root-6b",
      `<idle_m2 id=m2 seq=1 label="server" at="2026-04-21T12:00:00Z">\nhello\n</idle_m2>`,
    );
  });

  test("interval trigger with instantWhenIdle flushes next line immediately as XML", async () => {
    const fakeChild = createFakeChild();
    const promptAsync = mock(async () => {});
    const manager = new MonitorManager({
      stateRoot: "/tmp/opencode-monitor-runtime-test-6c",
      promptAsync,
      getRootSessionID: async () => "root-6c",
      now: () => Date.parse("2026-04-21T12:00:00Z"),
      spawnProcess: (() => fakeChild) as any,
    });

    await manager.startMonitor({
      ownerSessionID: "root-6c",
      label: "server",
      command: "ignored",
      capture: "stdout",
      cwd: "/tmp",
      triggers: [{ type: "interval", everyMs: 60_000, instantWhenIdle: true }],
      tagTemplate: "instant_{id}",
    });

    await manager.handleIdle("root-6c");
    fakeChild.stdout.emit("data", Buffer.from("hello\n"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(promptAsync).toHaveBeenCalledTimes(1);
    expect(promptAsync).toHaveBeenCalledWith(
      "root-6c",
      `<instant_m2 id=m2 seq=1 label="server" at="2026-04-21T12:00:00Z">\nhello\n</instant_m2>`,
    );
  });

  test("interval trigger with deliverWhenEmpty emits an empty heartbeat as XML", async () => {
    const fakeChild = createFakeChild();
    const timers: Array<() => void> = [];
    const promptAsync = mock(async () => {});
    const manager = new MonitorManager({
      stateRoot: "/tmp/opencode-monitor-runtime-test-6d",
      promptAsync,
      getRootSessionID: async () => "root-6d",
      now: () => 1_000,
      spawnProcess: (() => fakeChild) as any,
      setTimer: ((callback: () => void) => {
        timers.push(callback);
        return timers.length as any;
      }) as any,
      clearTimer: (() => {}) as any,
    });

    await manager.startMonitor({
      ownerSessionID: "root-6d",
      label: "server",
      command: "ignored",
      capture: "stdout",
      cwd: "/tmp",
      triggers: [{ type: "interval", everyMs: 1_000, deliverWhenEmpty: true }],
      tagTemplate: "empty_{id}",
    });

    await timers[0]?.();

    expect(promptAsync).toHaveBeenCalledTimes(1);
    expect(promptAsync).toHaveBeenCalledWith(
      "root-6d",
      `<empty_m2 id=m2 seq=1 label="server" at="1970-01-01T00:00:00Z">\n\n</empty_m2>`,
    );
  });

  test("very compact format trims outer attrs but keeps line prefixes", async () => {
    const fakeChild = createFakeChild();
    const promptAsync = mock(async () => {});
    const manager = new MonitorManager({
      stateRoot: "/tmp/opencode-monitor-runtime-test-6e",
      promptAsync,
      getRootSessionID: async () => "root-6e",
      now: () => Date.parse("2026-04-21T12:00:00Z"),
      spawnProcess: (() => fakeChild) as any,
    });

    await manager.startMonitor({
      ownerSessionID: "root-6e",
      label: "server",
      command: "ignored",
      capture: "both",
      outputFormat: "very-compact",
      cwd: "/tmp",
      triggers: [{ type: "idle" }],
      tagTemplate: "compact_{id}",
    });

    fakeChild.stdout.emit("data", Buffer.from("hello\n"));
    fakeChild.stderr.emit("data", Buffer.from("boom\n"));
    await manager.handleIdle("root-6e");

    expect(promptAsync).toHaveBeenCalledWith(
      "root-6e",
      `<compact_m2 id=m2 at="2026-04-21T12:00:00Z">\n+0.00s stdout: hello\n+0.00s stderr: boom\n</compact_m2>`,
    );
  });

  test("natural exit cleans up runtime and frees label for restart", async () => {
    const firstChild = createFakeChild(20001);
    const secondChild = createFakeChild(20002);
    let spawnCount = 0;
    const manager = new MonitorManager({
      stateRoot: "/tmp/opencode-monitor-runtime-test-8",
      promptAsync: async () => {},
      getRootSessionID: async () => "root-8",
      now: () => Date.parse("2026-04-21T12:00:00Z"),
      spawnProcess: (() => {
        spawnCount += 1;
        return (spawnCount === 1 ? firstChild : secondChild) as any;
      }) as any,
    });

    await manager.startMonitor({
      ownerSessionID: "root-8",
      label: "server",
      command: "ignored",
      capture: "stdout",
      cwd: "/tmp",
      triggers: [{ type: "idle" }],
      tagTemplate: "monitor_{id}",
    });

    firstChild.emit("close", 0, null);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await manager.listMonitors("root-8")).toHaveLength(0);

    await manager.startMonitor({
      ownerSessionID: "root-8",
      label: "server",
      command: "ignored",
      capture: "stdout",
      cwd: "/tmp",
      triggers: [{ type: "idle" }],
      tagTemplate: "monitor_{id}",
    });

    expect(await manager.listMonitors("root-8")).toHaveLength(1);
  });

  test("deleteSession waits for close before final removal", async () => {
    const fakeChild = createFakeChild(20003);
    const manager = new MonitorManager({
      stateRoot: "/tmp/opencode-monitor-runtime-test-9",
      promptAsync: async () => {},
      getRootSessionID: async () => "root-9",
      now: () => Date.parse("2026-04-21T12:00:00Z"),
      spawnProcess: (() => fakeChild) as any,
    });

    await manager.startMonitor({
      ownerSessionID: "root-9",
      label: "server",
      command: "ignored",
      capture: "stdout",
      cwd: "/tmp",
      triggers: [{ type: "idle" }],
      tagTemplate: "monitor_{id}",
    });

    await manager.deleteSession("root-9");
    fakeChild.stdout.emit("data", Buffer.from("late shutdown line\n"));
    expect(await manager.listMonitors("root-9")).toHaveLength(1);

    fakeChild.emit("close", 0, null);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await manager.listMonitors("root-9")).toHaveLength(0);
  });

  test("fetchPending is serialized with runtime state access", async () => {
    const fakeChild = createFakeChild();
    const manager = new MonitorManager({
      stateRoot: "/tmp/opencode-monitor-runtime-test-7",
      promptAsync: async () => {},
      getRootSessionID: async () => "root-7",
      now: () => Date.parse("2026-04-21T12:00:00Z"),
      spawnProcess: (() => fakeChild) as any,
    });

    await manager.startMonitor({
      ownerSessionID: "root-7",
      label: "server",
      command: "ignored",
      capture: "stdout",
      cwd: "/tmp",
      triggers: [{ type: "line", windowMs: 60_000 }],
      tagTemplate: "monitor_{id}",
    });

    fakeChild.stdout.emit("data", Buffer.from("hello\nworld\n"));
    const first = await manager.fetchPending("root-7", "server");
    const second = await manager.fetchPending("root-7", "server");
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });

  test("serialized drain clears runtime queue after successful work", async () => {
    const fakeChild = createFakeChild();
    const promptAsync = mock(async () => {});
    const manager = new MonitorManager({
      stateRoot: "/tmp/opencode-monitor-runtime-test-10",
      promptAsync,
      getRootSessionID: async () => "root-10",
      now: () => Date.parse("2026-04-21T12:00:00Z"),
      spawnProcess: (() => fakeChild) as any,
    });

    await manager.startMonitor({
      ownerSessionID: "root-10",
      label: "server",
      command: "ignored",
      capture: "stdout",
      cwd: "/tmp",
      triggers: [{ type: "idle" }],
      tagTemplate: "monitor_{id}",
    });

    fakeChild.stdout.emit("data", Buffer.from("hello\n"));
    await manager.handleIdle("root-10");
    expect(promptAsync).toHaveBeenCalledTimes(1);

    fakeChild.stdout.emit("data", Buffer.from("world\n"));
    await manager.handleIdle("root-10");
    expect(promptAsync).toHaveBeenCalledTimes(2);
  });

  test("writes debug jsonl when enabled", async () => {
    const fakeChild = createFakeChild();
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), "opencode-monitor-debug-"));
    const debugLogPath = path.join(tempRoot, "plugin-debug.jsonl");
    const promptAsync = mock(async () => {});
    try {
      const manager = new MonitorManager({
        stateRoot: tempRoot,
        promptAsync,
        getRootSessionID: async () => "root-debug",
        now: () => Date.parse("2026-04-21T12:00:00Z"),
        spawnProcess: (() => fakeChild) as any,
        debugEnabled: true,
        debugLogPath,
      });

      await manager.startMonitor({
        ownerSessionID: "root-debug",
        label: "server",
        command: "ignored",
        capture: "stdout",
        cwd: "/tmp",
        triggers: [{ type: "idle" }],
        tagTemplate: "monitor_{id}",
      });

      fakeChild.stdout.emit("data", Buffer.from("hello\n"));
      await manager.handleIdle("root-debug");

      const contents = readFileSync(debugLogPath, "utf8");
      expect(contents).toContain('"event":"monitor.start"');
      expect(contents).toContain('"event":"delivery.success"');
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("cleanupLogs preserves session directories that still have persistent state", async () => {
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), "opencode-monitor-cleanup-"));
    try {
      const sessionDir = path.join(tempRoot, "root-cleanup");
      mkdirSync(sessionDir, { recursive: true });
      await Bun.write(
        path.join(sessionDir, "monitors.json"),
        JSON.stringify({ version: 1, rootSessionID: "root-cleanup", monitors: [] }),
      );
      await Bun.write(path.join(sessionDir, "old.log"), "stale\n");

      const manager = new MonitorManager({
        stateRoot: tempRoot,
        promptAsync: async () => {},
        getRootSessionID: async () => "root-cleanup",
        now: () => Date.parse("2026-04-22T02:00:00Z"),
      });

      manager.cleanupLogs(0);

      expect(readFileSync(path.join(sessionDir, "old.log"), "utf8")).toContain("stale");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("detached monitor process survives launcher exit until explicitly killed", async () => {
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), "opencode-monitor-persist-"));
    const script = [
      `import { MonitorManager } from ${JSON.stringify(path.join(process.cwd(), "lib/runtime.ts"))};`,
      `const manager = new MonitorManager({`,
      `  stateRoot: ${JSON.stringify(tempRoot)},`,
      `  promptAsync: async () => {},`,
      `  getRootSessionID: async () => "root-persist",`,
      `});`,
      `const summary = await manager.startMonitor({`,
      `  ownerSessionID: "root-persist",`,
      `  label: "loop",`,
      `  command: "while sleep 0.2; do echo blah; done",`,
      `  capture: "stdout",`,
      `  cwd: "/tmp",`,
      `  triggers: [{ type: "line", windowMs: 5_000 }],`,
      `  tagTemplate: "monitor_{id}",`,
      `});`,
      `console.log(String(summary.pid));`,
      `setTimeout(() => process.exit(0), 100);`,
    ].join("\n");
    const proc = Bun.spawn(["bun", "--eval", script], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdoutText = await new Response(proc.stdout).text();
    const stderrText = await new Response(proc.stderr).text();
    await proc.exited;

    const pid = Number(stdoutText.trim());
    expect(stderrText).toBe("");
    expect(Number.isInteger(pid)).toBeTrue();

    try {
      await Bun.sleep(650);
      expect(() => process.kill(pid, 0)).not.toThrow();
    } finally {
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        // best effort cleanup
      }
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("persistent monitors write a session manifest with lifetime and latest-only config", async () => {
    const fakeChild = createFakeChild(31001);
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), "opencode-monitor-session-manifest-"));
    try {
      const manager = new MonitorManager({
        stateRoot: tempRoot,
        promptAsync: async () => {},
        getRootSessionID: async () => "root-manifest",
        now: () => Date.parse("2026-04-22T01:00:00Z"),
        spawnProcess: (() => fakeChild) as any,
      });

      await manager.startMonitor({
        ownerSessionID: "root-manifest",
        label: "heartbeat",
        command: "while true; do echo ok; sleep 1; done",
        capture: "stdout",
        cwd: "/tmp",
        triggers: [{ type: "interval", everyMs: 60_000, deliverWhenEmpty: true }],
        tagTemplate: "monitor_{id}",
        lifetime: "persistent",
        sendOnlyLatest: true,
      });

      const manifest = JSON.parse(readFileSync(path.join(tempRoot, "root-manifest", "monitors.json"), "utf8"));
      expect(manifest.version).toBe(1);
      expect(manifest.monitors).toHaveLength(1);
      expect(manifest.monitors[0]?.label).toBe("heartbeat");
      expect(manifest.monitors[0]?.lifetime).toBe("persistent");
      expect(manifest.monitors[0]?.sendOnlyLatest).toBeTrue();
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("ensureSessionLoaded restores persistent monitors with saved backlog and latest-only policy", async () => {
    const firstChild = createFakeChild(32001);
    const secondChild = createFakeChild(32002);
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), "opencode-monitor-restore-"));
    const promptAsync = mock(async () => {});
    try {
      const writer = new MonitorManager({
        stateRoot: tempRoot,
        promptAsync: async () => {},
        getRootSessionID: async () => "root-restore",
        now: () => Date.parse("2026-04-22T01:10:00Z"),
        spawnProcess: (() => firstChild) as any,
      });

      await writer.startMonitor({
        ownerSessionID: "root-restore",
        label: "heartbeat",
        command: "while true; do echo ok; sleep 1; done",
        capture: "stdout",
        cwd: "/tmp",
        triggers: [{ type: "idle" }],
        tagTemplate: "monitor_{id}",
        lifetime: "persistent",
        sendOnlyLatest: true,
      });
      firstChild.stdout.emit("data", Buffer.from("old\nnew\n"));
      await writer.shutdown();

      const reader = new MonitorManager({
        stateRoot: tempRoot,
        promptAsync,
        getRootSessionID: async () => "root-restore",
        now: () => Date.parse("2026-04-22T01:11:00Z"),
        spawnProcess: (() => secondChild) as any,
      });

      await reader.ensureSessionLoaded("root-restore");
      const listed = await reader.listMonitors("root-restore");
      expect(listed).toHaveLength(1);
      expect(listed[0]?.label).toBe("heartbeat");
      expect(listed[0]?.lifetime).toBe("persistent");
      expect(listed[0]?.sendOnlyLatest).toBeTrue();

      const batches = await reader.fetchPending("root-restore", "heartbeat");
      expect(batches).toHaveLength(1);
      expect(batches[0]?.lines.map((line) => line.content)).toEqual(["new"]);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("ensureSessionLoaded rejects a live foreign session lease", async () => {
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), "opencode-monitor-lease-"));
    const foreign = Bun.spawn(["sleep", "5"], { stdout: "ignore", stderr: "ignore" });
    try {
      const sessionDir = path.join(tempRoot, "root-lease");
      mkdirSync(sessionDir, { recursive: true });
      await Bun.write(
        path.join(sessionDir, "monitors.json"),
        JSON.stringify(
          {
            version: 1,
            rootSessionID: "root-lease",
            monitors: [
              {
                ownerSessionID: "root-lease",
                label: "heartbeat",
                monitorId: "m2",
                command: "while true; do echo ok; sleep 1; done",
                pid: foreign.pid,
                capture: "stdout",
                outputFormat: "compact",
                triggers: [{ type: "idle" }],
                cwd: "/tmp",
                env: {},
                logPath: path.join(sessionDir, "heartbeat.log"),
                stdoutPath: path.join(sessionDir, "heartbeat.stdout.log"),
                stderrPath: path.join(sessionDir, "heartbeat.stderr.log"),
                stdoutOffset: 0,
                stderrOffset: 0,
                stdoutRemainder: "",
                stderrRemainder: "",
                tagTemplate: "monitor_{id}",
                lifetime: "persistent",
                sendOnlyLatest: false,
                nextSeq: 1,
                pendingLines: [],
                status: "running",
              },
            ],
          },
          null,
          2,
        ),
      );
      await Bun.write(
        path.join(sessionDir, "monitors.lease.json"),
        JSON.stringify({ version: 1, rootSessionID: "root-lease", ownerPid: foreign.pid, acquiredAt: Date.now() }),
      );

      const manager = new MonitorManager({
        stateRoot: tempRoot,
        promptAsync: async () => {},
        getRootSessionID: async () => "root-lease",
        spawnProcess: (() => createFakeChild(33001)) as any,
      });

      await expect(manager.ensureSessionLoaded("root-lease")).rejects.toThrow("already owned");
    } finally {
      foreign.kill();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
