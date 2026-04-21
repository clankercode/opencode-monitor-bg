import { emit, sleep } from "./shared.ts";

await emit([
  { stream: "stdout", text: "watch mode: waiting for changes" },
  { stream: "stderr", text: "FAIL src/runtime.test.ts" },
  { stream: "stderr", text: "  expected 1 to be 2", delayMs: 50 },
  { stream: "stdout", text: "rerunning failed tests", delayMs: 800 },
]);

await sleep(3000);
