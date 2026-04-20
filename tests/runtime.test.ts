import { describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "events";

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
    expect(await manager.listMonitors("root-4")).toEqual([]);
    expect(killed.length).toBeGreaterThanOrEqual(1);
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
});
