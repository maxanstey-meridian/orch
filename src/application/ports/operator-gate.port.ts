export type GateDecision =
  | { readonly kind: "accept" }
  | { readonly kind: "reject" }
  | { readonly kind: "edit"; readonly guidance: string };

export type VerifyDecision =
  | { readonly kind: "retry" }
  | { readonly kind: "skip" }
  | { readonly kind: "stop" };

export type CreditDecision = { readonly kind: "retry" } | { readonly kind: "quit" };

export abstract class OperatorGate {
  abstract confirmPlan(planPreview: string): Promise<GateDecision>;
  abstract verifyFailed(
    executionUnitLabel: string,
    summary: string,
    retryable: boolean,
  ): Promise<VerifyDecision>;
  abstract creditExhausted(label: string, message: string): Promise<CreditDecision>;
  abstract askUser(prompt: string): Promise<string>;
  abstract confirmNextGroup(groupLabel: string): Promise<boolean>;
}
