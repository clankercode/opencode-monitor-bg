# opencode-monitor-bg

OpenCode plugin that starts background processes, collects stdout/stderr lines, and delivers output back into the owning root session via compact XML envelopes.

## Features

- `monitor_start`
- `monitor_list`
- `monitor_fetch`
- `monitor_kill`
- persistent monitor resume across OpenCode restarts
- optional truncation to the latest pending line for heartbeat-style monitors
- root-session ownership isolation
- readable date-time strings in model-facing XML
- pure, property-tested scheduling/ID/line-framing core

## Install

```bash
bun install
bun run build
cp dist/monitor.js ~/.config/opencode/plugins/monitor.js
```

OpenCode also loads project-local plugins from `.opencode/plugins/` if you want to install it there instead.

To have the global OpenCode plugin always track the latest local build from this repo, symlink it instead:

```bash
ln -sfn /home/xertrov/src/opencode-monitor-bg/dist/monitor.js ~/.config/opencode/plugins/monitor.js
```

After that, rerunning `bun run build` in this repo updates what new OpenCode sessions load globally.

## Development

```bash
bun test
bun run build
```

## Notes

- State files default to `${XDG_STATE_HOME:-$HOME/.local/state}/opencode-monitor/`.
- Persistent monitor manifests live at `${XDG_STATE_HOME:-$HOME/.local/state}/opencode-monitor/<rootSessionID>/monitors.json`.
- Per-session ownership leases live at `${XDG_STATE_HOME:-$HOME/.local/state}/opencode-monitor/<rootSessionID>/monitors.lease.json`.
- Startup cleanup skips any session directory that still has a monitor manifest or lease, so persistent sessions do not lose capture files just because they are old.
- Override log root with `MONITOR_LOG_DIR`.
- Background command output is captured via per-monitor state files instead of parent-owned stdout/stderr pipes, so quiet loops keep running even if the plugin host restarts.
- `monitor_start` accepts `lifetime: "ephemeral" | "persistent"` and defaults to `ephemeral`.
- Persistent monitors are auto-restored once per root session after plugin startup or first session touch. If another live OpenCode process already owns that session lease, restore is rejected.
- If a previously-conflicting lease owner exits, a later restore attempt in the same OpenCode instance can reclaim the stale lease and continue.
- Persistent monitors are best-effort killed when the OpenCode host exits cleanly, but their saved desired-active state remains so the next session resume can restart them.
- `monitor_start` accepts `truncate: number` and defaults to `0`. Values below `1` disable truncation; values `>= 1` truncate each emitted line to that many characters and append `…`.
- `monitor_start` accepts `send_only_latest: true|false` independently. When enabled, grouped deliveries and `monitor_fetch` keep only the newest pending line while still preserving any exit event.
- Debug logging writes JSONL to `${MONITOR_LOG_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/opencode-monitor}/plugin-debug.jsonl`.
- `PLUGIN_OC_MONITOR_DEBUG_LOG=1` enables debug logging, and it is currently default-on when unset.
- Set `PLUGIN_OC_MONITOR_DEBUG_LOG=0` to disable the debug JSONL once you no longer need lifecycle traces.
- XML tags are templated and sanitized from `tagTemplate`.
- Model-facing XML uses readable UTC date-time strings without milliseconds.
- `outputFormat` defaults to `compact`; `very-compact` drops sequence and label attrs.
