import { appendFileSync, mkdirSync } from "fs";
import path from "path";

import { formatDateTime } from "./xml.ts";

export const MONITOR_LOG_DIR_ENV = "MONITOR_LOG_DIR";
export const DEBUG_LOG_ENV = "PLUGIN_OC_MONITOR_DEBUG_LOG";

export function defaultStateRoot(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env[MONITOR_LOG_DIR_ENV];
  if (configured) return configured;

  const home = env.HOME ?? "/tmp";
  const xdgStateHome = env.XDG_STATE_HOME;
  const stateHome =
    xdgStateHome && path.isAbsolute(xdgStateHome) ? xdgStateHome : path.join(home, ".local", "state");

  return path.join(stateHome, "opencode-monitor");
}

export function defaultDebugLogPath(stateRoot: string): string {
  return path.join(stateRoot, "plugin-debug.jsonl");
}

export function debugLoggingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[DEBUG_LOG_ENV];
  // TODO disable the default-on fallback once the detached monitor lifecycle fix has soaked long enough.
  if (!raw) return true;
  return !/^(0|false|off|no)$/i.test(raw);
}

export function appendDebugLog(
  logPath: string,
  now: number,
  event: string,
  details: Record<string, unknown> = {},
): void {
  try {
    mkdirSync(path.dirname(logPath), { recursive: true });
    appendFileSync(
      logPath,
      `${JSON.stringify({
        at: formatDateTime(now),
        event,
        pid: process.pid,
        ...details,
      })}\n`,
    );
  } catch {
    // Debug logging must never break monitor delivery.
  }
}
