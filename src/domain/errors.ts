export class CreditExhaustedError extends Error {
  readonly kind: "mid-response" | "rejected";
  constructor(message: string, kind: "mid-response" | "rejected") {
    super(message);
    this.kind = kind;
  }
}

export class IncompleteRunError extends Error {
  constructor(message: string) {
    super(message);
  }
}
