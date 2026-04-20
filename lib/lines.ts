import type { EmittedLine, LineCollectorState } from "./types.ts";

export function appendChunk(state: LineCollectorState, chunk: string): EmittedLine {
  const combined = state.remainder + chunk;
  const parts = combined.split(/\r?\n/);
  const remainder = parts.pop() ?? "";
  return {
    state: { remainder },
    lines: parts,
  };
}

export function flushRemainder(state: LineCollectorState): EmittedLine {
  if (!state.remainder) return { state: { remainder: "" }, lines: [] };
  return {
    state: { remainder: "" },
    lines: [state.remainder],
  };
}
