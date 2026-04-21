import { emit, sleep } from "./shared.ts";

await emit([
  { stream: "stdout", text: "burst a1" },
  { stream: "stdout", text: "burst a2", delayMs: 50 },
  { stream: "stdout", text: "burst a3", delayMs: 50 },
]);

await sleep(1400);

await emit([
  { stream: "stdout", text: "burst b1" },
  { stream: "stdout", text: "burst b2", delayMs: 50 },
]);

await sleep(1500);
