export type GateDecision =
  | { readonly kind: 'accept' }
  | { readonly kind: 'reject' }
  | { readonly kind: 'edit'; readonly guidance: string };

export type VerifyDecision =
  | { readonly kind: 'retry' }
  | { readonly kind: 'skip' }
  | { readonly kind: 'stop' };

export abstract class OperatorGate {
  abstract confirmPlan(planPreview: string): Promise<GateDecision>;
  abstract verifyFailed(sliceNumber: number, summary: string): Promise<VerifyDecision>;
  abstract askUser(prompt: string): Promise<string>;
  abstract confirmNextGroup(groupLabel: string): Promise<boolean>;
}

// Backward-compat re-exports — consumers migrate in Slice 5
export type { InterruptHandler, ProgressUpdate } from './progress-sink.port.js';
