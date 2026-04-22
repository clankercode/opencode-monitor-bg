# opencode-monitor-bg

OpenCode plugin that starts background processes, collects stdout/stderr lines, and delivers output back into the owning root session via compact XML envelopes.

## Features

- `monitor_start`
- `monitor_list`
- `monitor_fetch`
- `monitor_kill`
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
- Override log root with `MONITOR_LOG_DIR`.
- Background command output is captured via per-monitor state files instead of parent-owned stdout/stderr pipes, so quiet loops keep running even if the plugin host restarts.
- Debug logging writes JSONL to `${MONITOR_LOG_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/opencode-monitor}/plugin-debug.jsonl`.
- `PLUGIN_OC_MONITOR_DEBUG_LOG=1` enables debug logging, and it is currently default-on when unset.
- Set `PLUGIN_OC_MONITOR_DEBUG_LOG=0` to disable the debug JSONL once you no longer need lifecycle traces.
- XML tags are templated and sanitized from `tagTemplate`.
- Model-facing XML uses readable UTC date-time strings without milliseconds.
- `outputFormat` defaults to `compact`; `very-compact` drops sequence and label attrs.
