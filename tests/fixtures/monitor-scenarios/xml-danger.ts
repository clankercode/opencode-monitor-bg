import { emit, sleep } from "./shared.ts";

await emit([
  { stream: "stdout", text: "payload <step id=\"1\"> & ready" },
  { stream: "stdout", text: "quoted 'single' and \"double\" markers", delayMs: 150 },
]);

await sleep(1500);
