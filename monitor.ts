import type { Event, EventSessionCreated, EventSessionDeleted, EventSessionUpdated } from "@opencode-ai/sdk";
import { tool, type Plugin } from "@opencode-ai/plugin";

import { debugLoggingEnabled, defaultDebugLogPath, defaultStateRoot } from "./lib/debug.ts";
import { MonitorManager, resolveRootSessionID } from "./lib/runtime.ts";

export const MonitorPlugin: Plugin = async (ctx) => {
  const stateRoot = defaultStateRoot();
  const manager = new MonitorManager({
    stateRoot,
    promptAsync: async (sessionID, text) => {
      await ctx.client.session.promptAsync({
        path: { id: sessionID },
        body: { parts: [{ type: "text", text }] },
        throwOnError: true,
      });
    },
    getRootSessionID: async (sessionID) => resolveRootSessionID(ctx.client, sessionID),
    debugEnabled: debugLoggingEnabled(),
    debugLogPath: defaultDebugLogPath(stateRoot),
  });

  let shutdownStarted = false;
  const shutdown = () => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    void manager.shutdown();
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.once(signal, shutdown);
  }
  process.once("exit", shutdown);

  const startRestoreScan = () => {
    let attemptsRemaining = 60;
    const tick = async () => {
      if (attemptsRemaining <= 0) return;
      attemptsRemaining -= 1;
      try {
        const result = await ctx.client.session.status?.();
        const statuses = (result as { data?: Record<string, unknown> } | undefined)?.data ?? {};
        await Promise.all(Object.keys(statuses).map((sessionID) => manager.ensureSessionLoaded(sessionID).catch(() => {})));
      } catch {
        // best effort
      }
      if (attemptsRemaining > 0) setTimeout(() => void tick(), 1_000);
    };
    setTimeout(() => void tick(), 1_000);
  };
  startRestoreScan();

  try {
    manager.cleanupLogs();
  } catch {
    // If state-root cleanup fails, keep the plugin loaded and let per-monitor startup report the real error.
  }

  return {
    tool: {
      monitor_start: tool({
        description:
          "Starts a background process and monitors its stdout/stderr lines for later delivery to the root session. Use this to watch long-running processes without blocking.",
        args: {
          command: tool.schema.string().describe("Shell command to run in the background"),
          label: tool.schema.string().describe("Unique monitor label within the root session"),
          capture: tool.schema.enum(["stdout", "stderr", "both"]).default("both"),
          outputFormat: tool.schema.enum(["compact", "very-compact"]).default("compact"),
          cwd: tool.schema.string().optional(),
          env: tool.schema.record(tool.schema.string(), tool.schema.string()).optional(),
          tagTemplate: tool.schema.string().default("monitor_{id}"),
          lifetime: tool.schema.enum(["ephemeral", "persistent"]).default("ephemeral"),
          requestedId: tool.schema.string().optional(),
          send_only_latest: tool.schema.boolean().default(false),
          triggers: tool.schema
            .array(
              tool.schema.union([
                tool.schema.object({ type: tool.schema.literal("line"), windowMs: tool.schema.number().optional() }),
                tool.schema.object({ type: tool.schema.literal("idle") }),
                tool.schema.object({
                  type: tool.schema.literal("interval"),
                  everyMs: tool.schema.number().positive(),
                  offsetMs: tool.schema.number().optional(),
                  deliverWhenEmpty: tool.schema.boolean().optional(),
                  instantWhenIdle: tool.schema.boolean().optional(),
                }),
              ]),
            )
            .default([{ type: "idle" }]),
        },
        async execute(args, context) {
          await manager.ensureSessionLoaded(context.sessionID);
          const summary = await manager.startMonitor({
            ownerSessionID: context.sessionID,
            label: args.label,
            command: args.command,
            capture: args.capture,
            outputFormat: args.outputFormat,
            cwd: args.cwd ?? context.directory,
            env: args.env as Record<string, string> | undefined,
            triggers: args.triggers,
            tagTemplate: args.tagTemplate,
            lifetime: args.lifetime,
            requestedId: args.requestedId,
            sendOnlyLatest: args.send_only_latest,
          });
          return {
            output: JSON.stringify(summary, null, 2),
            metadata: { monitorId: summary.monitorId, pid: summary.pid },
          };
        },
      }),
      monitor_list: tool({
        description: "Lists monitors owned by the current root session.",
        args: {
          label: tool.schema.string().optional(),
        },
        async execute(args, context) {
          await manager.ensureSessionLoaded(context.sessionID);
          const monitors = await manager.listMonitors(context.sessionID, args.label);
          return JSON.stringify(monitors, null, 2);
        },
      }),
      monitor_fetch: tool({
        description: "Fetches pending monitor output as tool result only without injecting it into the session.",
        args: {
          label: tool.schema.string().optional(),
        },
        async execute(args, context) {
          await manager.ensureSessionLoaded(context.sessionID);
          const batches = await manager.fetchPending(context.sessionID, args.label);
          return JSON.stringify(batches, null, 2);
        },
      }),
      monitor_kill: tool({
        description: "Kills a monitored background process owned by the current root session.",
        args: {
          label: tool.schema.string(),
          signal: tool.schema.enum(["SIGTERM", "SIGKILL"]).default("SIGTERM"),
        },
        async execute(args, context) {
          await manager.ensureSessionLoaded(context.sessionID);
          const summary = await manager.killMonitor(context.sessionID, args.label, args.signal);
          return JSON.stringify(summary, null, 2);
        },
      }),
    },
    event: async ({ event }: { event: Event }) => {
      if (event.type === "session.created") {
        manager.rememberSessionCreated(event as EventSessionCreated);
        await manager.ensureSessionLoaded(event.properties.info.id).catch(() => {});
        return;
      }
      if (event.type === "session.updated") {
        const updated = event as EventSessionUpdated;
        manager.rememberSessionInfo(updated.properties.info.id, updated.properties.info.parentID ?? undefined);
        await manager.ensureSessionLoaded(updated.properties.info.id).catch(() => {});
        return;
      }
      if (event.type === "session.idle") {
        await manager.ensureSessionLoaded(event.properties.sessionID).catch(() => {});
        await manager.handleIdle(event.properties.sessionID);
        return;
      }
      if (event.type === "session.deleted") {
        const deleted = manager.rememberSessionDeleted(event as EventSessionDeleted);
        if (deleted.isRoot) await manager.deleteSession(deleted.sessionID);
        return;
      }
      if (event.type === "session.status") {
        await manager.ensureSessionLoaded(event.properties.sessionID).catch(() => {});
        const idle = event.properties.status.type === "idle";
        if (idle) await manager.handleIdle(event.properties.sessionID);
        else await manager.handleActivity(event.properties.sessionID);
      }
    },
  };
};

export default MonitorPlugin;
