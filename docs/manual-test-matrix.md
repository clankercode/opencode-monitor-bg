# Manual Test Matrix

## Goal

Exercise live monitor behavior through the installed tools, with emphasis on long-running processes, timing jitter, delivery triggers, XML formatting, and cleanup.

## Coverage

1. Interval trigger
- Verify repeated auto-delivery across multiple intervals.
- Verify delivery continues while process is still running.
- Verify natural exit emits a final `_exit` envelope.

2. Interval trigger with `deliverWhenEmpty`
- Verify empty heartbeats can be emitted while no lines are pending.
- Verify real timer jitter does not suppress heartbeat delivery.

3. Interval trigger with `instantWhenIdle`
- Verify a line ingested while session is idle is delivered immediately.

4. Idle trigger
- Verify pending lines stay buffered while session is busy.
- Verify pending lines flush on idle transition.

5. Line trigger without debounce
- Verify each ingested line can trigger immediate delivery.

6. Line trigger with debounce
- Verify bursts are batched into a single delivery.
- Verify a later burst produces a later batch with incremented sequence numbers.

7. Stream capture filtering
- Verify `stdout` excludes stderr.
- Verify `stderr` excludes stdout.
- Verify `both` includes both streams with correct stream attributes.

8. XML formatting
- Verify custom tag templates render correctly.
- Verify invalid tag characters are sanitized.
- Verify line content is XML-escaped.
- Verify exit-only envelopes use the `_exit` tag form.

9. Manual fetch behavior
- Verify `monitor_fetch` returns pending output without injecting it.
- Verify repeated fetch drains pending state once.

10. Label and lifecycle edge cases
- Verify duplicate labels are rejected while a monitor is active.
- Verify a label becomes reusable after natural exit.
- Verify `monitor_kill` changes status and ends the process.

11. Log output
- Verify log files are created.
- Verify log lines include readable timestamps and stream names.

12. Detached lifecycle robustness
- Verify a long-silent process survives after the launcher process exits.
- Verify the next emitted line is still captured after that detach boundary.

13. Debug logging
- Verify `${XDG_STATE_HOME:-$HOME/.local/state}/opencode-monitor/plugin-debug.jsonl` is created by default.
- Verify `PLUGIN_OC_MONITOR_DEBUG_LOG=0` suppresses debug-log writes.

14. Persistent monitor resume
- Verify `lifetime: "persistent"` writes `monitors.json` and `monitors.lease.json` under the root-session state directory.
- Verify restarting after the session directory has old capture files does not prune them while the manifest or lease still exists.
- Verify restarting OpenCode and revisiting the same session restores persistent monitors only once.
- Verify a persistent monitor whose prior PID is gone is auto-restarted on resume.
- Verify a second live OpenCode process trying to load the same session gets a lease conflict instead of double-owning the monitors.
- Verify the original instance can retry successfully after the conflicting lease owner exits.

15. Latest-only grouped delivery
- Verify `send_only_latest: true` collapses a multi-line burst to the newest line.
- Verify `monitor_fetch` follows the same collapse behavior.
- Verify exit events are still included with the kept latest line.

## Planned Live Scenarios

### Scenario A: Long interval stream
- Start a process that emits one line roughly every second for several seconds.
- Use `interval` trigger with a 1 second cadence.
- Expect multiple XML deliveries before exit, then a final exit envelope.

### Scenario B: Empty heartbeat
- Start a mostly silent process.
- Use `interval` trigger with `deliverWhenEmpty: true`.
- Expect one or more empty heartbeat envelopes before exit.

### Scenario C: Idle flush
- Start a process with a `line` trigger that has a long debounce or only `idle`.
- Keep session active initially, then let it go idle.
- Expect no delivery until idle, then a flush.

### Scenario D: Debounced bursts
- Start a process that emits two quick bursts separated by more than the debounce window.
- Expect two XML deliveries with increasing sequence numbers.

### Scenario E: Mixed streams
- Start a process that alternates stdout and stderr.
- Run separate monitors for `stdout`, `stderr`, and `both` as needed.
- Expect filtered stream behavior to match capture mode.

### Scenario F: Manual fetch drain
- Start a buffered monitor with long debounce.
- Use `monitor_fetch` twice.
- Expect first fetch to return lines and second fetch to return nothing.

### Scenario G: Quiet loop persistence
- Start a process like `while sleep 240; do echo blah; done`.
- Leave it idle long enough that the next `echo` would previously have hit a broken pipe after host teardown.
- Expect the process to stay alive and the next emitted line to be captured.

### Scenario H: Debug JSONL
- Start any monitor with default settings.
- Confirm `plugin-debug.jsonl` appears under the monitor state root and records start, delivery, and exit events.
- Repeat with `PLUGIN_OC_MONITOR_DEBUG_LOG=0` and expect no new debug entries.

### Scenario I: Persistent resume
- Start a monitor with `lifetime: "persistent"`.
- Restart OpenCode or reload the plugin host, then revisit the same session.
- Expect the monitor to reappear in `monitor_list` and resume capturing output.
- Repeat with the original monitored PID already gone and expect the command to auto-restart.

### Scenario J: Latest-only heartbeat
- Start a monitor that emits repetitive lines in quick bursts with `send_only_latest: true`.
- Trigger a grouped delivery via `idle`, `interval`, or `monitor_fetch`.
- Expect only the newest pending line to be delivered, plus any exit marker if the process finished.

## Notes

- Live auto-delivery appears in-session, so XML envelopes themselves are part of the observed result.
- Some edge cases are easier to probe with direct `MonitorManager` runtime scripts when the live session semantics would otherwise hide the behavior.
