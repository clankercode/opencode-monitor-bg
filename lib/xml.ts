import type { DeliveryBatch, MonitorRecord } from "./types.ts";

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function formatDateTime(epochMs: number): string {
  return new Date(epochMs).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function formatRelativeSeconds(epochMs: number, baseMs: number): string {
  const seconds = Math.max(0, epochMs - baseMs) / 1_000;
  return `+${seconds.toFixed(2)}s`;
}

function formatBatchAttrs(record: MonitorRecord, batch: DeliveryBatch, batchAt: number): string {
  if (record.outputFormat === "very-compact") {
    return `id=${escapeXml(record.monitorId)} at="${formatDateTime(batchAt)}"`;
  }

  return `id=${escapeXml(record.monitorId)} seq=${batch.seq} label="${escapeXml(record.label)}" at="${formatDateTime(batchAt)}"`;
}

function formatExitEvent(exit: NonNullable<DeliveryBatch["exit"]>): string {
  const parts: string[] = [];
  if (exit.exitCode === null) parts.push("exit");
  else parts.push(`exit=${exit.exitCode}`);
  if (exit.signal) parts.push(`signal=${escapeXml(exit.signal)}`);
  return `[${parts.join(" ")}]`;
}

function truncateLine(content: string, limit: number): string {
  if (limit < 1 || content.length <= limit) return content;
  return `${content.slice(0, limit)}…`;
}

function formatContentLine(record: MonitorRecord, line: DeliveryBatch["lines"][number]): string {
  const prefix = record.capture === "both" ? `${line.stream}: ` : "";
  return `${prefix}${escapeXml(truncateLine(line.content, record.truncate))}`;
}

function formatTimedLine(text: string, includeOffset: boolean, at: number, baseMs: number): string {
  return includeOffset ? `${formatRelativeSeconds(at, baseMs)} ${text}` : text;
}

export function formatTagName(template: string, values: { id: string; label: string }): string {
  const rendered = template
    .replaceAll("{id}", values.id)
    .replaceAll("{label}", values.label);
  const sanitized = rendered.replaceAll(/[^A-Za-z0-9_.-]/g, "_");
  if (!sanitized) return "monitor_update";
  return /^[A-Za-z_]/.test(sanitized) ? sanitized : `m_${sanitized}`;
}

export function formatBatchXml(input: { record: MonitorRecord; batch: DeliveryBatch }): string {
  const tag = formatTagName(input.record.tagTemplate, {
    id: input.record.monitorId,
    label: input.record.label,
  });
  const firstLineAt = input.batch.lines[0]?.ingestedAt;
  const batchAt = firstLineAt ?? input.batch.exit?.occurredAt ?? 0;
  const attrs = formatBatchAttrs(input.record, input.batch, batchAt);

  if (input.batch.lines.length === 0 && input.batch.exit) {
    return `<${tag}_exit ${attrs}>
${formatExitEvent(input.batch.exit)}
</${tag}_exit>`;
  }

  const includeOffsets = input.batch.lines.length > 1 || (input.batch.lines.length === 1 && Boolean(input.batch.exit));
  const linesXml = input.batch.lines
    .map((line) => formatTimedLine(formatContentLine(input.record, line), includeOffsets, line.ingestedAt, batchAt))
    .join("\n");
  const exitXml = input.batch.exit
    ? `\n${formatTimedLine(formatExitEvent(input.batch.exit), includeOffsets, input.batch.exit.occurredAt, batchAt)}`
    : "";

  return `<${tag} ${attrs}>\n${linesXml}${exitXml}\n</${tag}>`;
}
