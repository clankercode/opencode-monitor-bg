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
  const attrs = `id=${escapeXml(input.record.monitorId)} seq=${input.batch.seq} label="${escapeXml(input.record.label)}" pid=${input.record.pid} at="${formatDateTime(batchAt)}"`;

  if (input.batch.lines.length === 0 && input.batch.exit) {
    return `<${tag}_exit ${attrs}>
${formatRelativeSeconds(input.batch.exit.occurredAt, batchAt)} exit_code=${input.batch.exit.exitCode ?? ""} signal=${escapeXml(input.batch.exit.signal ?? "")}
</${tag}_exit>`;
  }

  const linesXml = input.batch.lines
    .map((line) => {
      const prefix = input.record.capture === "both" ? `${line.stream}: ` : "";
      return `${formatRelativeSeconds(line.ingestedAt, batchAt)} ${prefix}${escapeXml(line.content)}`;
    })
    .join("\n");
  const exitXml = input.batch.exit
    ? `\n${formatRelativeSeconds(input.batch.exit.occurredAt, batchAt)} exit_code=${input.batch.exit.exitCode ?? ""} signal=${escapeXml(
        input.batch.exit.signal ?? "",
      )}`
    : "";

  return `<${tag} ${attrs}>\n${linesXml}${exitXml}\n</${tag}>`;
}
