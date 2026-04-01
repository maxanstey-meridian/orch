import { createWriteStream, mkdirSync } from "fs";
import { once } from "events";
import { dirname, join } from "path";
import { LogWriter } from "#application/ports/log-writer.port.js";

const formatLine = (badge: string, text: string): string => {
  const prefix = `[${new Date().toISOString()}] [${badge}] `;
  return text
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n")
    .concat("\n");
};

export class FsLogWriter implements LogWriter {
  private stream?: ReturnType<typeof createWriteStream>;

  constructor(private readonly logPath: string) {}

  private ensureStream(): ReturnType<typeof createWriteStream> {
    if (!this.stream) {
      mkdirSync(dirname(this.logPath), { recursive: true });
      this.stream = createWriteStream(this.logPath, { flags: "a" });
    }

    return this.stream;
  }

  write(badge: string, text: string): void {
    this.ensureStream().write(formatLine(badge, text));
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
