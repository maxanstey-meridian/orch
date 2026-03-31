export type RuntimeInteractionRequest =
  | { readonly kind: "commandApproval"; readonly summary: string; readonly command?: string }
  | {
      readonly kind: "fileChangeApproval";
      readonly summary: string;
      readonly files: readonly string[];
    }
  | { readonly kind: "permissionApproval"; readonly summary: string };

export type RuntimeInteractionDecision =
  | { readonly kind: "approve" }
  | { readonly kind: "reject" }
  | { readonly kind: "cancel" };

export abstract class RuntimeInteractionGate {
  abstract decide(request: RuntimeInteractionRequest): Promise<RuntimeInteractionDecision>;
}
