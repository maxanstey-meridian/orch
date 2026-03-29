import type { CreditSignal } from "../agent/credit-detection.js";

export class CreditExhaustedError extends Error {
  readonly kind: CreditSignal["kind"];
  constructor(message: string, kind: CreditSignal["kind"]) {
    super(message);
    this.kind = kind;
  }
}
