import { emit, sleep } from "./shared.ts";

await emit([
  { stream: "stdout", text: "build step 1/3: transpile" },
  { stream: "stdout", text: "build step 2/3: bundle", delayMs: 100 },
  { stream: "stderr", text: "warning: sourcemap references missing asset", delayMs: 100 },
  { stream: "stdout", text: "build step 3/3: write dist", delayMs: 100 },
  { stream: "stdout", text: "build complete in 421ms", delayMs: 100 },
]);

await sleep(1500);
