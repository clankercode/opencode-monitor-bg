import { emit } from "./shared.ts";

await emit([
  { stream: "stdout", text: "migration start" },
  { stream: "stdout", text: "apply 20260420_add_monitors_table", delayMs: 200 },
  { stream: "stdout", text: "apply 20260420_add_trigger_indexes", delayMs: 200 },
  { stream: "stdout", text: "migration complete", delayMs: 200 },
]);
