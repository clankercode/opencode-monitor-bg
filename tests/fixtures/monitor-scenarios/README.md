# Monitor Scenarios

Mock scripts for manual monitor testing. Each script produces deterministic stdout/stderr timing patterns so trigger behavior and XML formatting can be exercised with `monitor_start`.

## Scenario Mapping

- `dev-server.ts`: use cases 1 and 14
- `test-watcher.ts`: use cases 2 and 13
- `build-bursts.ts`: use case 3
- `migration-job.ts`: use case 4
- `flaky-tool.ts`: use case 5
- `clean-status.ts`: use case 6
- `heartbeat.ts`: use case 7
- `chatty-bursts.ts`: use case 8
- `sync-job.ts`: use case 9 and 16
- `lint-watch.ts`: use case 10
- `worker-service.ts`: use cases 11, 12, and 20
- `unexpected-exit.ts`: use case 15
- `formatter.ts`: use case 17
- `tunnel.ts`: use case 18
- `xml-danger.ts`: use case 19

## Suggested Commands

- `bun tests/fixtures/monitor-scenarios/dev-server.ts`
- `bun tests/fixtures/monitor-scenarios/test-watcher.ts`
- `bun tests/fixtures/monitor-scenarios/worker-service.ts api`
- `bun tests/fixtures/monitor-scenarios/worker-service.ts worker`
- `bun tests/fixtures/monitor-scenarios/worker-service.ts frontend`
