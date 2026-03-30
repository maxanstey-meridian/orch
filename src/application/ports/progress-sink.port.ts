export type InterruptHandler = {
  onGuide(callback: (text: string) => void): void;
  onInterrupt(callback: (text: string) => void): void;
};

export type ProgressUpdate = {
  readonly totalSlices?: number;
  readonly completedSlices?: number;
  readonly groupName?: string;
  readonly groupSliceCount?: number;
  readonly groupCompleted?: number;
  readonly currentSlice?: { readonly number: number };
  readonly activeAgent?: string;
  readonly activeAgentActivity?: string;
  readonly startTime?: number;
};

export abstract class ProgressSink {
  abstract registerInterrupts(): InterruptHandler;
  abstract updateProgress(update: ProgressUpdate): void;
  abstract setActivity(summary: string): void;
  abstract teardown(): void;
}
