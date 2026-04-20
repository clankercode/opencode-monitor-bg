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
});
