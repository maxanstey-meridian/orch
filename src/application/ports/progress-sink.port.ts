import type { ExecutionMode } from "#domain/config.js";
import type { AgentRole } from "#domain/agent-types.js";
import type { Slice } from "#domain/plan.js";

export type InterruptHandler = {
  onGuide(callback: (text: string) => void): void;
  onInterrupt(callback: (text: string) => void): void;
  onSkip(callback: () => boolean): void;
  onQuit(callback: () => void): void;
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
  abstract log(text: string): void;
  abstract logExecutionMode(executionMode: ExecutionMode): void;
  abstract createStreamer(role: AgentRole): (text: string) => void;
  abstract logSliceIntro(slice: Slice): void;
  abstract logBadge(role: AgentRole, phase: string): void;
  abstract clearSkipping(): void;
  abstract teardown(): void;
}
