export type GateDecision =
  | { readonly kind: 'accept' }
  | { readonly kind: 'reject' }
  | { readonly kind: 'edit'; readonly guidance: string };

export type VerifyDecision =
  | { readonly kind: 'retry' }
  | { readonly kind: 'skip' }
  | { readonly kind: 'stop' };

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

export abstract class OperatorGate {
  abstract confirmPlan(planPreview: string): Promise<GateDecision>;
  abstract verifyFailed(sliceNumber: number, summary: string): Promise<VerifyDecision>;
  abstract askUser(prompt: string): Promise<string>;
  abstract confirmNextGroup(groupLabel: string): Promise<boolean>;
  abstract registerInterrupts(): InterruptHandler;
  abstract updateProgress(update: ProgressUpdate): void;
  abstract setActivity(summary: string): void;
  abstract teardown(): void;
}
