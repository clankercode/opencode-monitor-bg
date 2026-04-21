import { emit, sleep } from "./shared.ts";

await emit([
  { stream: "stdout", text: "dev-server booting on :3000" },
  { stream: "stdout", text: "hmr connected", delayMs: 150 },
  { stream: "stdout", text: "GET /api/health 200 4ms", delayMs: 900 },
  { stream: "stdout", text: "rebuilt app shell in 182ms", delayMs: 900 },
]);

await sleep(2000);
