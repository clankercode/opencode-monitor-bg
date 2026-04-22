import { describe, expect, mock, test } from "bun:test";

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

describe("plugin", () => {
  test("session.deleted uses event.properties.info.id", async () => {
    await withEnv({ XDG_STATE_HOME: "/tmp/opencode-monitor-plugin-test" }, async () => {
      const promptAsync = mock(async () => ({}));
      const sessionGet = mock(async ({ path }: { path: { id: string } }) => ({
        data: { id: path.id, directory: "/tmp", projectID: "p1", title: "t", version: "1", time: { created: 0, updated: 0 } },
      }));

      const plugin = await MonitorPlugin({
        client: {
          session: {
            promptAsync,
            get: sessionGet,
          },
        } as any,
        project: {} as any,
        directory: "/tmp",
        worktree: "/tmp",
        experimental_workspace: { register() {} },
        serverUrl: new URL("http://localhost:4096"),
        $: {} as any,
      });

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
    await withEnv({ XDG_STATE_HOME: "/tmp/opencode-monitor-plugin-test" }, async () => {
      const promptAsync = mock(async () => ({}));
      const sessionGet = mock(async ({ path }: { path: { id: string } }) => ({
        data: { id: path.id, directory: "/tmp", projectID: "p1", title: "t", version: "1", time: { created: 0, updated: 0 } },
      }));

      const plugin = await MonitorPlugin({
        client: {
          session: {
            promptAsync,
            get: sessionGet,
          },
        } as any,
        project: {} as any,
        directory: "/tmp",
        worktree: "/tmp",
        experimental_workspace: { register() {} },
        serverUrl: new URL("http://localhost:4096"),
        $: {} as any,
      });

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

  test("monitor_start accepts lifetime and send_only_latest arguments", async () => {
    await withEnv({ XDG_STATE_HOME: "/tmp/opencode-monitor-plugin-test" }, async () => {
      const promptAsync = mock(async () => ({}));
      const sessionGet = mock(async ({ path }: { path: { id: string } }) => ({
        data: { id: path.id, directory: "/tmp", projectID: "p1", title: "t", version: "1", time: { created: 0, updated: 0 } },
      }));
      const sessionStatus = mock(async () => ({ data: { "root-3": { type: "idle" } } }));

      const plugin = await MonitorPlugin({
        client: {
          session: {
            promptAsync,
            get: sessionGet,
            status: sessionStatus,
          },
        } as any,
        project: {} as any,
        directory: "/tmp",
        worktree: "/tmp",
        experimental_workspace: { register() {} },
        serverUrl: new URL("http://localhost:4096"),
        $: {} as any,
      });

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
          send_only_latest: true,
        } as any,
        { sessionID: "root-3", directory: "/tmp" } as any,
      );

      expect(String(result?.output ?? result)).toContain('"label": "heartbeat"');
      expect(String(result?.output ?? result)).toContain('"lifetime": "persistent"');
      expect(String(result?.output ?? result)).toContain('"sendOnlyLatest": true');
    });
  });
});
