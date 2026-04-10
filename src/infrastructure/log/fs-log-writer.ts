import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { LogWriter } from "#application/ports/log-writer.port.js";

const formatLogLines = (badge: string, text: string): string => {
  const timestamp = new Date().toISOString();
  const lines = text === "" ? [""] : text.split(/\r?\n/);
  return lines.map((line) => `[${timestamp}] [${badge}] ${line}`).join("\n").concat("\n");
};

export class FsLogWriter extends LogWriter {
  private closed = false;

  constructor(private readonly filePath: string) {
    super();
    mkdirSync(dirname(filePath), { recursive: true });
  }

  write(badge: string, text: string): void {
    if (this.closed) {
      return;
    }

    appendFileSync(this.filePath, formatLogLines(badge, text), "utf-8");
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

export class NullLogWriter extends LogWriter {
  write(_badge: string, _text: string): void {}

  async close(): Promise<void> {}
}
