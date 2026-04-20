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

## Notes

- Live auto-delivery appears in-session, so XML envelopes themselves are part of the observed result.
- Some edge cases are easier to probe with direct `MonitorManager` runtime scripts when the live session semantics would otherwise hide the behavior.
