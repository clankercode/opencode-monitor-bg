import { emit, sleep } from "./shared.ts";

await emit([
  { stream: "stdout", text: "lint watch started" },
  { stream: "stdout", text: "src/core.ts:12:5 no-unused-vars", delayMs: 200 },
  { stream: "stdout", text: "src/runtime.ts:44:3 prefer-const", delayMs: 200 },
]);

await sleep(30000);
