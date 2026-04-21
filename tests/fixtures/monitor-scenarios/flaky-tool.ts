import { emit, sleep } from "./shared.ts";

await emit([
  { stream: "stdout", text: "connecting to flaky backend" },
  { stream: "stderr", text: "warning: socket stalled", delayMs: 200 },
  { stream: "stdout", text: "retrying request", delayMs: 200 },
  { stream: "stderr", text: "error: retry budget exhausted", delayMs: 200 },
  { stream: "stdout", text: "falling back to cached response", delayMs: 200 },
]);

await sleep(2000);
