import { describe, expect, test } from "bun:test";

import { makeExit, makeLine, makeMonitorRecord } from "../lib/factories.ts";
import { formatBatchXml, formatDateTime, formatTagName } from "../lib/xml.ts";

describe("xml", () => {
  test("formatDateTime emits readable utc string without milliseconds", () => {
    expect(formatDateTime(1_713_700_800_123)).toBe("2024-04-21T12:00:00Z");
  });

  test("formatTagName sanitizes invalid characters", () => {
    expect(formatTagName("build-{id}!", { id: "m17", label: "server" })).toBe("build-m17_");
  });

  test("formatBatchXml escapes data and includes readable times", () => {
    const xml = formatBatchXml({
      record: makeMonitorRecord({ monitorId: "m17", label: "server", tagTemplate: "build_{id}" }),
      batch: {
        monitorId: "m17",
        seq: 3,
        lines: [makeLine({ content: "<danger>", ingestedAt: Date.parse("2026-04-21T12:00:00Z") })],
        exit: undefined,
      },
    });

    expect(xml).toContain('<build_m17 id="m17" seq="3"');
    expect(xml).toContain('at="2026-04-21T12:00:00Z"');
    expect(xml).toContain("&lt;danger&gt;");
  });

  test("formatBatchXml renders exit-only envelopes", () => {
    const xml = formatBatchXml({
      record: makeMonitorRecord({ monitorId: "m17", label: "server", tagTemplate: "build_{id}" }),
      batch: {
        monitorId: "m17",
        seq: 4,
        lines: [],
        exit: makeExit({ occurredAt: Date.parse("2026-04-21T12:00:09Z") }),
      },
    });

    expect(xml).toContain("<build_m17_exit");
    expect(xml).toContain('at="2026-04-21T12:00:09Z"');
  });
});
