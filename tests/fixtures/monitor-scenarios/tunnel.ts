import { emit, sleep } from "./shared.ts";

await emit([
  { stream: "stdout", text: "tunnel: assigned https://demo.example.test" },
  { stream: "stderr", text: "tunnel: heartbeat missed, reconnecting", delayMs: 900 },
  { stream: "stdout", text: "tunnel: reconnected", delayMs: 300 },
]);

await sleep(2200);
