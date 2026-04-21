import { emit } from "./shared.ts";

await emit([
  { stream: "stdout", text: "cli: starting" },
  { stream: "stderr", text: "cli: upstream handshake failed", delayMs: 150 },
]);

process.exit(2);
