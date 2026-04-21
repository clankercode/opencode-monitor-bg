export function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

export function err(line: string): void {
  process.stderr.write(`${line}\n`);
}

export async function sleep(ms: number): Promise<void> {
  await Bun.sleep(ms);
}

export async function emit(lines: Array<{ stream: "stdout" | "stderr"; text: string; delayMs?: number }>): Promise<void> {
  for (const line of lines) {
    if (line.delayMs) await sleep(line.delayMs);
    if (line.stream === "stdout") out(line.text);
    else err(line.text);
  }
}
