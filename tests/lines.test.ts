import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { appendChunk, flushRemainder } from "../lib/lines.ts";

describe("lines", () => {
  test("splits complete lines and retains remainder", () => {
    const result = appendChunk({ remainder: "" }, "one\ntwo\npar");
    expect(result.lines).toEqual(["one", "two"]);
    expect(result.state.remainder).toBe("par");
  });

  test("flushRemainder emits trailing partial line once", () => {
    const flushed = flushRemainder({ remainder: "tail" });
    expect(flushed.lines).toEqual(["tail"]);
    expect(flushed.state.remainder).toBe("");
  });

  test("chunk splitting preserves exact line content", () => {
    fc.assert(
      fc.property(fc.string(), fc.array(fc.integer({ min: 1, max: 6 }), { minLength: 1, maxLength: 20 }), (raw, widths) => {
        const source = raw.includes("\n") ? raw : `${raw}\nend`;
        let offset = 0;
        let state = { remainder: "" };
        const lines: string[] = [];

        for (const width of widths) {
          if (offset >= source.length) break;
          const chunk = source.slice(offset, offset + width);
          offset += width;
          const result = appendChunk(state, chunk);
          state = result.state;
          lines.push(...result.lines);
        }

        if (offset < source.length) {
          const result = appendChunk(state, source.slice(offset));
          state = result.state;
          lines.push(...result.lines);
        }

        const flushed = flushRemainder(state);
        lines.push(...flushed.lines);

        const expected = source.endsWith("\n")
          ? source.slice(0, -1).split("\n")
          : source.split("\n");

        expect(lines).toEqual(expected);
      }),
    );
  });
});
