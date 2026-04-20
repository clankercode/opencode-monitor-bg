# opencode-monitor-bg

OpenCode plugin that starts background processes, collects stdout/stderr lines, and delivers output back into the owning root session via `promptAsync` using XML envelopes.

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

## Development

```bash
bun test
bun run build
```

## Notes

- Logs default to `~/.local/state/opencode-monitor/`.
- Override log root with `MONITOR_LOG_DIR`.
- XML tags are templated and sanitized from `tagTemplate`.
- Model-facing XML uses readable UTC date-time strings without milliseconds.
