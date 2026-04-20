import type { Event, EventSessionCreated, EventSessionDeleted } from "@opencode-ai/sdk";
import { tool, type Plugin } from "@opencode-ai/plugin";

import { MonitorManager, resolveRootSessionID } from "./lib/runtime.ts";
import { formatBatchXml } from "./lib/xml.ts";

const MONITOR_LOG_DIR_ENV = "MONITOR_LOG_DIR";

function defaultStateRoot(): string {
  const home = process.env.HOME ?? "/tmp";
  return process.env[MONITOR_LOG_DIR_ENV] ?? `${home}/.local/state/opencode-monitor`;
}

export const MonitorPlugin: Plugin = async (ctx) => {
  const manager = new MonitorManager({
    stateRoot: defaultStateRoot(),
    promptAsync: async (sessionID, text) => {
      await (ctx.client.session as any).promptAsync({
        path: { id: sessionID },
        body: { parts: [{ type: "text", text }] },
        url: "/session/{id}/prompt_async",
        throwOnError: true,
      });
    },
    getRootSessionID: async (sessionID) => resolveRootSessionID(ctx.client as any, sessionID),
  });

  manager.cleanupLogs();

  return {
    tool: {
      monitor_start: tool({
        description:
          "Starts a background process and monitors its stdout/stderr lines for later delivery to the root session. Use this to watch long-running processes without blocking.",
        args: {
          command: tool.schema.string().describe("Shell command to run in the background"),
          label: tool.schema.string().describe("Unique monitor label within the root session"),
          capture: tool.schema.enum(["stdout", "stderr", "both"]).default("both"),
          cwd: tool.schema.string().optional(),
          env: tool.schema.record(tool.schema.string()).optional(),
          tagTemplate: tool.schema.string().default("monitor_{id}"),
          requestedId: tool.schema.string().optional(),
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
          const summary = await manager.startMonitor({
            ownerSessionID: context.sessionID,
            label: args.label,
            command: args.command,
            capture: args.capture,
            cwd: args.cwd ?? context.directory,
            env: args.env,
            triggers: args.triggers,
            tagTemplate: args.tagTemplate,
            requestedId: args.requestedId,
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
          const summary = await manager.killMonitor(context.sessionID, args.label, args.signal);
          return JSON.stringify(summary, null, 2);
        },
      }),
    },
    event: async ({ event }: { event: Event }) => {
      if (event.type === "session.created") {
        manager.rememberSessionCreated(event as EventSessionCreated);
        return;
      }
      if (event.type === "session.idle") {
        await manager.handleIdle(event.properties.sessionID);
        return;
      }
      if (event.type === "session.deleted") {
        const deleted = manager.rememberSessionDeleted(event as EventSessionDeleted);
        if (deleted.isRoot) await manager.deleteSession(deleted.sessionID);
        return;
      }
      if (event.type === "session.status") {
        const idle = event.properties.status === "idle";
        if (idle) await manager.handleIdle(event.properties.sessionID);
        else await manager.handleActivity(event.properties.sessionID);
      }
    },
  };
};

export default MonitorPlugin;
