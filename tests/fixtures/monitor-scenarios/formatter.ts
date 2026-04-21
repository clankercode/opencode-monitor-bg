import { emit, sleep } from "./shared.ts";

await emit([
  { stream: "stdout", text: "format write src/core.ts" },
  { stream: "stdout", text: "format write src/runtime.ts", delayMs: 50 },
  { stream: "stdout", text: "format write tests/runtime.test.ts", delayMs: 50 },
  { stream: "stdout", text: "format summary: 3 files changed", delayMs: 300 },
]);

await sleep(1500);
