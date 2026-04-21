import { emit, sleep } from "./shared.ts";

const service = process.argv[2] ?? "worker";

await emit([
  { stream: "stdout", text: `${service}: boot` },
  { stream: "stdout", text: `${service}: ready`, delayMs: 150 },
  { stream: "stdout", text: `${service}: processed job 1`, delayMs: 800 },
]);

await sleep(1800);
