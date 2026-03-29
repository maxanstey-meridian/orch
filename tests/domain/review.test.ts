import { describe, it, expect } from "vitest";
import { shouldReview } from "../../src/domain/review.js";

describe("shouldReview", () => {
  it("returns true when total equals threshold", () => {
    expect(shouldReview({ total: 30 }, 30)).toBe(true);
  });

  it("returns true when total exceeds threshold", () => {
    expect(shouldReview({ total: 31 }, 30)).toBe(true);
  });

  it("returns false when total is below threshold", () => {
    expect(shouldReview({ total: 29 }, 30)).toBe(false);
  });

  it("returns false when total is zero", () => {
    expect(shouldReview({ total: 0 }, 30)).toBe(false);
  });
});
