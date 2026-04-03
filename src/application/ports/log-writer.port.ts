export abstract class LogWriter {
  abstract write(badge: string, text: string): void;
  abstract close(): Promise<void>;
}
