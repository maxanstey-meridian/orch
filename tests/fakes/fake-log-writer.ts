import { LogWriter } from "#application/ports/log-writer.port.js";

export class FakeLogWriter extends LogWriter {
  readonly lines: Array<{ badge: string; text: string }> = [];
  closed = false;

  write(badge: string, text: string): void {
    this.lines.push({ badge, text });
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}
