import { createWriteStream, mkdirSync } from "fs";
import { once } from "events";
import { dirname, join } from "path";
import { LogWriter } from "#application/ports/log-writer.port.js";

const formatLine = (badge: string, text: string): string =>
  `[${new Date().toISOString()}] [${badge}] ${text}\n`;

export class FsLogWriter implements LogWriter {
  private stream?: ReturnType<typeof createWriteStream>;

  constructor(private readonly logPath: string) {}

  write(badge: string, text: string): void {
    mkdirSync(dirname(this.logPath), { recursive: true });
    if (!this.stream) {
      this.stream = createWriteStream(this.logPath, { flags: "a" });
    }

    this.stream.write(formatLine(badge, text));
  }

  async close(): Promise<void> {
    if (!this.stream) {
      return;
    }

    this.stream.end();
    await once(this.stream, "finish");
    this.stream = undefined;
  }
}

export class NullLogWriter implements LogWriter {
  write(_badge: string, _text: string): void {}

  async close(): Promise<void> {}
}

export const logPathForPlan = (orchDir: string, planId: string): string =>
  join(orchDir, "logs", `plan-${planId}.log`);
