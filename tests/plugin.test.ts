import { describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import os from "os";
import path from "path";

import MonitorPlugin from "../monitor.ts";

async function withEnv<T>(env: Record<string, string | undefined>, work: () => Promise<T>): Promise<T> {
  const prior = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    prior.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await work();
  } finally {
    for (const [key, value] of prior) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function withTempStateRoot<T>(work: () => Promise<T>): Promise<T> {
  const xdgStateHome = mkdtempSync(path.join(os.tmpdir(), "opencode-monitor-plugin-test-"));
  try {
    return await withEnv({ XDG_STATE_HOME: xdgStateHome }, work);
  } finally {
    rmSync(xdgStateHome, { recursive: true, force: true });
  }
}

async function waitFor(check: () => boolean, timeoutMs = 1_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (check()) return;
    await Bun.sleep(20);
  }
  throw new Error(`Condition not met within ${timeoutMs}ms`);
}

async function makePlugin(options?: {
  promptAsync?: ReturnType<typeof mock>;
  sessionGet?: ReturnType<typeof mock>;
  sessionStatus?: ReturnType<typeof mock>;
}) {
  const promptAsync = options?.promptAsync ?? mock(async () => ({}));
  const sessionGet =
    options?.sessionGet ??
    mock(async ({ path }: { path: { id: string } }) => ({
      data: { id: path.id, directory: "/tmp", projectID: "p1", title: "t", version: "1", time: { created: 0, updated: 0 } },
    }));

  const plugin = await MonitorPlugin({
    client: {
      session: {
        promptAsync,
        get: sessionGet,
        status: options?.sessionStatus,
      },
    } as any,
    project: {} as any,
    directory: "/tmp",
    worktree: "/tmp",
    experimental_workspace: { register() {} },
    serverUrl: new URL("http://localhost:4096"),
    $: {} as any,
  });

  return { plugin, promptAsync, sessionGet, sessionStatus: options?.sessionStatus };
}

describe("plugin", () => {
  test("session.deleted uses event.properties.info.id", async () => {
    await withTempStateRoot(async () => {
      const { plugin, promptAsync } = await makePlugin();

      await plugin.event?.({
        event: {
          type: "session.created",
          properties: {
            info: { id: "root-1", parentID: null },
          },
        } as any,
      });

      await plugin.event?.({
        event: {
          type: "session.deleted",
          properties: {
            info: { id: "root-1", parentID: null },
          },
        } as any,
      });

      expect(promptAsync).not.toHaveBeenCalled();
    });
  });

  test("session.status routes idle and busy correctly", async () => {
    await withTempStateRoot(async () => {
      const { plugin, promptAsync } = await makePlugin();

      await plugin.event?.({
        event: {
          type: "session.status",
          properties: {
            sessionID: "root-2",
            status: { type: "idle" },
          },
        } as any,
      });

      await plugin.event?.({
        event: {
          type: "session.status",
          properties: {
            sessionID: "root-2",
            status: { type: "busy" },
          },
        } as any,
      });

      expect(promptAsync).not.toHaveBeenCalled();
    });
  });

  test("monitor_start accepts lifetime and truncate arguments", async () => {
    await withTempStateRoot(async () => {
      const sessionStatus = mock(async () => ({ data: { "root-3": { type: "idle" } } }));
      const { plugin } = await makePlugin({ sessionStatus });

      const result = await plugin.tool?.monitor_start.execute(
        {
          command: "echo ok",
          label: "heartbeat",
          capture: "stdout",
          outputFormat: "compact",
          cwd: "/tmp",
          triggers: [{ type: "idle" }],
          tagTemplate: "monitor_{id}",
          lifetime: "persistent",
          truncate: 200,
        } as any,
        { sessionID: "root-3", directory: "/tmp" } as any,
      );

      expect(String(result?.output ?? result)).toContain('"label": "heartbeat"');
      expect(String(result?.output ?? result)).toContain('"lifetime": "persistent"');
      expect(String(result?.output ?? result)).toContain('"truncate": 200');
    });
  });

  test("monitor_start keeps send_only_latest separate from truncate", async () => {
    await withTempStateRoot(async () => {
      const sessionStatus = mock(async () => ({ data: { "root-3b": { type: "idle" } } }));
      const { plugin } = await makePlugin({ sessionStatus });

      const result = await plugin.tool?.monitor_start.execute(
        {
          command: "echo ok",
          label: "heartbeat",
          capture: "stdout",
          outputFormat: "compact",
          cwd: "/tmp",
          triggers: [{ type: "idle" }],
          tagTemplate: "monitor_{id}",
          truncate: 80,
          send_only_latest: true,
        } as any,
        { sessionID: "root-3b", directory: "/tmp" } as any,
      );

      expect(String(result?.output ?? result)).toContain('"truncate": 80');
      expect(String(result?.output ?? result)).toContain('"sendOnlyLatest": true');
    });
  });

  test("monitor_start hydrates current idle status so idle trigger can fire without a new idle event", async () => {
    await withTempStateRoot(async () => {
      const sessionStatus = mock(async () => ({ data: { "root-idle-start": { type: "idle" } } }));
      const promptAsync = mock(async () => ({}));
      const { plugin } = await makePlugin({ sessionStatus, promptAsync });

      await plugin.tool?.monitor_start.execute(
        {
          command: "printf 'hello\\n'; sleep 5",
          label: "heartbeat",
          capture: "stdout",
          outputFormat: "compact",
          cwd: "/tmp",
          triggers: [{ type: "idle" }],
          tagTemplate: "monitor_{id}",
        } as any,
        { sessionID: "root-idle-start", directory: "/tmp" } as any,
      );

      await waitFor(() => promptAsync.mock.calls.length > 0, 500);
      expect(promptAsync.mock.calls[0]?.[0]?.path?.id).toBe("root-idle-start");

      await plugin.tool?.monitor_kill.execute(
        { label: "heartbeat", signal: "SIGTERM" } as any,
        { sessionID: "root-idle-start", directory: "/tmp" } as any,
      );
    });
  });

  test("promptAsync delivery uses the agent selected when the monitor was started", async () => {
    await withTempStateRoot(async () => {
      const sessionStatus = mock(async () => ({ data: { "root-agent": { type: "idle" } } }));
      const promptAsync = mock(async () => ({}));
      const { plugin } = await makePlugin({ sessionStatus, promptAsync });

      await plugin.tool?.monitor_start.execute(
        {
          command: "printf 'hello\\n'; sleep 5",
          label: "heartbeat",
          capture: "stdout",
          outputFormat: "compact",
          cwd: "/tmp",
          triggers: [{ type: "idle" }],
          tagTemplate: "monitor_{id}",
        } as any,
        { sessionID: "root-agent", directory: "/tmp", agent: "plan" } as any,
      );

      await waitFor(() => promptAsync.mock.calls.length > 0, 500);
      expect(promptAsync.mock.calls[0]?.[0]?.body?.agent).toBe("plan");

      await plugin.tool?.monitor_kill.execute(
        { label: "heartbeat", signal: "SIGTERM" } as any,
        { sessionID: "root-agent", directory: "/tmp" } as any,
      );
    });
  });

  test("monitor_list includes the original command and launch metadata", async () => {
    await withTempStateRoot(async () => {
      const sessionStatus = mock(async () => ({ data: { "root-list": { type: "idle" } } }));
      const { plugin } = await makePlugin({ sessionStatus });

      await plugin.tool?.monitor_start.execute(
        {
          command: "bun run dev --hot",
          label: "heartbeat",
          capture: "stdout",
          outputFormat: "compact",
          cwd: "/tmp",
          triggers: [{ type: "idle" }],
          tagTemplate: "build_{id}",
          requestedId: "user-picked-id",
        } as any,
        { sessionID: "root-list", directory: "/tmp" } as any,
      );

      const result = await plugin.tool?.monitor_list.execute({} as any, {
        sessionID: "root-list",
        directory: "/tmp",
      } as any);
      const output = String(result?.output ?? result);

      expect(output).toContain('"command": "bun run dev --hot"');
      expect(output).toContain('"cwd": "/tmp"');
      expect(output).toContain('"tagTemplate": "build_{id}"');
      expect(output).toContain('"requestedMonitorId": "user-picked-id"');
    });
  });

  test("session.updated triggers a restore lookup for the updated session", async () => {
    await withTempStateRoot(async () => {
      const sessionGet = mock(async ({ path }: { path: { id: string } }) => ({
        data: {
          id: path.id,
          parentID: path.id === "child-updated" ? "root-updated" : undefined,
          directory: "/tmp",
          projectID: "p1",
          title: "t",
          version: "1",
          time: { created: 0, updated: 0 },
        },
      }));
      const { plugin } = await makePlugin({ sessionGet });

      await plugin.event?.({
        event: {
          type: "session.updated",
          properties: {
            info: { id: "child-updated", parentID: "root-updated" },
          },
        } as any,
      });

      expect(sessionGet).toHaveBeenCalledWith({ path: { id: "child-updated" } });
    });
  });

  test("startup restore scan polls session.status and resolves listed sessions", async () => {
    await withTempStateRoot(async () => {
      const sessionStatus = mock(async () => ({ data: { "root-scan": { type: "idle" } } }));
      const sessionGet = mock(async ({ path }: { path: { id: string } }) => ({
        data: { id: path.id, directory: "/tmp", projectID: "p1", title: "t", version: "1", time: { created: 0, updated: 0 } },
      }));

      await makePlugin({ sessionGet, sessionStatus });
      await Bun.sleep(1_100);

      expect(sessionStatus).toHaveBeenCalled();
      expect(sessionGet).toHaveBeenCalledWith({ path: { id: "root-scan" } });
    });
  });

  test("startup restore scan applies idle status to restored backlog", async () => {
    await withTempStateRoot(async () => {
      const sessionStatus = mock(async () => ({ data: { "root-restore-idle": { type: "idle" } } }));
      const promptAsync = mock(async () => ({}));
      const stateRoot = path.join(process.env.XDG_STATE_HOME!, "opencode-monitor");
      const sessionDir = path.join(stateRoot, "root-restore-idle");
      mkdirSync(sessionDir, { recursive: true });
      await Bun.write(
        path.join(sessionDir, "monitors.json"),
        JSON.stringify({
          version: 1,
          rootSessionID: "root-restore-idle",
          monitors: [
            {
              ownerSessionID: "root-restore-idle",
              label: "heartbeat",
              monitorId: "m2",
              command: "while true; do echo ok; sleep 1; done",
              pid: process.pid,
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
              truncate: 0,
              nextSeq: 1,
              pendingLines: [{ stream: "stdout", content: "hello", ingestedAt: Date.parse("2026-04-22T08:00:00Z") }],
              status: "running",
            },
          ],
        }),
      );

      await makePlugin({ promptAsync, sessionStatus });
      await waitFor(() => promptAsync.mock.calls.length > 0, 1_500);

      expect(promptAsync.mock.calls[0]?.[0]?.path?.id).toBe("root-restore-idle");
    });
  });

  test("session events surface persistent lease conflicts", async () => {
    await withTempStateRoot(async () => {
      const foreign = Bun.spawn(["sleep", "5"], { stdout: "ignore", stderr: "ignore" });
      try {
        const stateRoot = path.join(process.env.XDG_STATE_HOME!, "opencode-monitor");
        const sessionDir = path.join(stateRoot, "root-conflict");
        mkdirSync(sessionDir, { recursive: true });
        await Bun.write(
          path.join(sessionDir, "monitors.json"),
          JSON.stringify({
            version: 1,
            rootSessionID: "root-conflict",
            monitors: [
              {
                ownerSessionID: "root-conflict",
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
                truncate: 0,
                nextSeq: 1,
                pendingLines: [],
                status: "running",
              },
            ],
          }),
        );
        await Bun.write(
          path.join(sessionDir, "monitors.lease.json"),
          JSON.stringify({
            version: 1,
            rootSessionID: "root-conflict",
            ownerPid: foreign.pid,
            acquiredAt: Date.now(),
          }),
        );

        const { plugin } = await makePlugin();
        await expect(
          plugin.event?.({
            event: {
              type: "session.status",
              properties: {
                sessionID: "root-conflict",
                status: { type: "idle" },
              },
            } as any,
          }),
        ).rejects.toThrow("already owned");
      } finally {
        foreign.kill();
        await foreign.exited;
      }
    });
  });
});
