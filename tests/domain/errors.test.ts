import { describe, it, expect } from "vitest";
import { CreditExhaustedError } from "#domain/errors.js";

describe("CreditExhaustedError", () => {
  it("stores message and mid-response kind", () => {
    const err = new CreditExhaustedError("credit gone", "mid-response");
    expect(err.message).toBe("credit gone");
    expect(err.kind).toBe("mid-response");
    expect(err).toBeInstanceOf(Error);
  });

  it("stores message and rejected kind", () => {
    const err = new CreditExhaustedError("rejected", "rejected");
    expect(err.message).toBe("rejected");
    expect(err.kind).toBe("rejected");
    expect(err).toBeInstanceOf(Error);
  });
});
