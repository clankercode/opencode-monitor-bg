import { describe, expect, mock, test } from "bun:test";

import MonitorPlugin from "../monitor.ts";

describe("plugin", () => {
  test("session.deleted uses event.properties.info.id", async () => {
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

  test("session.status routes idle and busy correctly", async () => {
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
