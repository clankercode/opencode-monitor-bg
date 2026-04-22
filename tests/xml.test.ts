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
      record: makeMonitorRecord({ monitorId: "m17", label: "server", tagTemplate: "build_{id}", capture: "stdout" }),
      batch: {
        monitorId: "m17",
        seq: 3,
        lines: [makeLine({ content: "<danger>", ingestedAt: Date.parse("2026-04-21T12:00:00Z") })],
        exit: undefined,
      },
    });

    expect(xml).toContain('<build_m17 id=m17 seq=3');
    expect(xml).not.toContain("pid=");
    expect(xml).toContain('at="2026-04-21T12:00:00Z"');
    expect(xml).toContain('&lt;danger&gt;');
    expect(xml).not.toContain('+0.00s');
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
    expect(xml).toContain('[exit=0]');
    expect(xml).not.toContain('+0.00s');
  });

  test("formatBatchXml supports very compact output", () => {
    const xml = formatBatchXml({
      record: makeMonitorRecord({
        monitorId: "m17",
        label: "server",
        tagTemplate: "build_{id}",
        capture: "both",
        outputFormat: "very-compact",
      }),
      batch: {
        monitorId: "m17",
        seq: 3,
        lines: [makeLine({ content: "hello" }), makeLine({ stream: "stderr", content: "boom", ingestedAt: 1_700_000_001_000 })],
        exit: makeExit({ occurredAt: 1_700_000_002_000, signal: "SIGTERM", exitCode: null }),
      },
    });

    expect(xml).toContain('<build_m17 id=m17 at="2023-11-14T22:13:20Z">');
    expect(xml).not.toContain("seq=");
    expect(xml).not.toContain('label="server"');
    expect(xml).toContain('+0.00s stdout: hello');
    expect(xml).toContain('+1.00s stderr: boom');
    expect(xml).toContain('+2.00s [exit signal=SIGTERM]');
  });

  test("formatBatchXml keeps offsets aligned for single line plus exit", () => {
    const xml = formatBatchXml({
      record: makeMonitorRecord({ monitorId: "m17", label: "server", tagTemplate: "build_{id}" }),
      batch: {
        monitorId: "m17",
        seq: 5,
        lines: [makeLine({ content: "done", ingestedAt: Date.parse("2026-04-21T12:00:00Z") })],
        exit: makeExit({ occurredAt: Date.parse("2026-04-21T12:00:02Z") }),
      },
    });

    expect(xml).toContain('+0.00s stdout: done');
    expect(xml).toContain('+2.00s [exit=0]');
  });

  test("formatBatchXml truncates long lines when truncate is at least one", () => {
    const xml = formatBatchXml({
      record: makeMonitorRecord({ monitorId: "m17", truncate: 5 }),
      batch: {
        monitorId: "m17",
        seq: 6,
        lines: [makeLine({ content: "abcdefgh" })],
        exit: undefined,
      },
    });

    expect(xml).toContain("stdout: abcde…");
    expect(xml).not.toContain("abcdefgh");
  });

  test("formatBatchXml does not truncate lines when truncate is below one", () => {
    const xml = formatBatchXml({
      record: makeMonitorRecord({ monitorId: "m17", truncate: 0 }),
      batch: {
        monitorId: "m17",
        seq: 7,
        lines: [makeLine({ content: "abcdefgh" })],
        exit: undefined,
      },
    });

    expect(xml).toContain("stdout: abcdefgh");
    expect(xml).not.toContain("abcde…");
  });
});
