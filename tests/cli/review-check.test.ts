import { describe, it, expect } from "vitest";
import { isCleanReview } from "../../src/infrastructure/cli/review-check.js";

describe("isCleanReview", () => {
  it("returns true for empty string", () => {
    expect(isCleanReview("")).toBe(true);
  });

  it("returns true for whitespace-only string", () => {
    expect(isCleanReview("   \n  ")).toBe(true);
  });

  it("returns true for NO_ISSUES_FOUND", () => {
    expect(isCleanReview("NO_ISSUES_FOUND")).toBe(true);
  });

  it('returns true for "No findings. No action required."', () => {
    expect(isCleanReview("No findings. No action required.")).toBe(true);
  });

  it("returns true for LGTM", () => {
    expect(isCleanReview("LGTM")).toBe(true);
  });

  it('returns true for "No bugs or issues found."', () => {
    expect(isCleanReview("No bugs or issues found.")).toBe(true);
  });

  it('returns true for "Looks good to me."', () => {
    expect(isCleanReview("Looks good to me.")).toBe(true);
  });

  it('returns true for "No problems detected"', () => {
    expect(isCleanReview("No problems detected")).toBe(true);
  });

  it("returns false for text listing issues", () => {
    expect(isCleanReview("Found 3 issues:\n1. Bug in parser")).toBe(false);
  });

  it("returns false for type error feedback", () => {
    expect(isCleanReview("The implementation has a type error on line 42")).toBe(false);
  });

  it("returns false for missing null check feedback", () => {
    expect(isCleanReview("Missing null check in handler")).toBe(false);
  });

  it('returns true for "Ship it"', () => {
    expect(isCleanReview("Ship it")).toBe(true);
  });

  it('returns true for "ship it!"', () => {
    expect(isCleanReview("ship it!")).toBe(true);
  });

  it('returns true for "No changes needed"', () => {
    expect(isCleanReview("No changes needed")).toBe(true);
  });

  it('returns true for "No change required"', () => {
    expect(isCleanReview("No change required")).toBe(true);
  });

  it('returns true for "Approved"', () => {
    expect(isCleanReview("Approved")).toBe(true);
  });

  it('returns true for "All good"', () => {
    expect(isCleanReview("All good")).toBe(true);
  });

  it('returns true for "Nothing to fix"', () => {
    expect(isCleanReview("Nothing to fix")).toBe(true);
  });

  it('returns true for "Nothing to change"', () => {
    expect(isCleanReview("Nothing to change")).toBe(true);
  });

  it('returns true for "Code is clean"', () => {
    expect(isCleanReview("Code is clean")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isCleanReview("lgtm")).toBe(true);
    expect(isCleanReview("no issues found")).toBe(true);
    expect(isCleanReview("LOOKS GOOD")).toBe(true);
  });
});
