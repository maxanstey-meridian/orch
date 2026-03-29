export type Idle = { readonly kind: "Idle" };
export type Planning = { readonly kind: "Planning"; readonly sliceNumber: number; readonly attempt: number };
export type Gated = { readonly kind: "Gated"; readonly sliceNumber: number; readonly planText: string; readonly attempt: number };
export type Executing = { readonly kind: "Executing"; readonly sliceNumber: number; readonly planText: string | null };
export type Verifying = { readonly kind: "Verifying"; readonly sliceNumber: number };
export type CompletenessCheck = { readonly kind: "CompletenessCheck"; readonly sliceNumber: number };
export type Reviewing = { readonly kind: "Reviewing"; readonly sliceNumber: number; readonly cycle: number };
export type GapAnalysis = { readonly kind: "GapAnalysis"; readonly groupName: string };
export type FinalPasses = { readonly kind: "FinalPasses"; readonly passIndex: number };
export type Complete = { readonly kind: "Complete" };

export type Phase =
  | Idle
  | Planning
  | Gated
  | Executing
  | Verifying
  | CompletenessCheck
  | Reviewing
  | GapAnalysis
  | FinalPasses
  | Complete;
