import { emit, sleep } from "./shared.ts";

await emit([
  { stream: "stdout", text: "status: repo clean" },
  { stream: "stderr", text: "debug: skipped optional probe", delayMs: 100 },
  { stream: "stdout", text: "status: 3 services healthy", delayMs: 100 },
]);

await sleep(1500);
