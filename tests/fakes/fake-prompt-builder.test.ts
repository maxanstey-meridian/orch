import { describe, expect, it } from "vitest";
import {
  DIRECT_PROMPT_SENTINEL,
  DIRECT_TEST_PASS_PROMPT_SENTINEL,
  PassthroughPromptBuilder,
} from "./fake-prompt-builder.js";

describe("PassthroughPromptBuilder", () => {
  it("uses an explicit direct execution sentinel for whole-request runs", () => {
    const builder = new PassthroughPromptBuilder();

    expect(builder.directExecute("implement request")).toBe(
      `${DIRECT_PROMPT_SENTINEL} implement request`,
    );
  });

  it("uses an explicit direct test-pass sentinel for whole-request runs", () => {
    const builder = new PassthroughPromptBuilder();

    expect(builder.directTestPass("implement request")).toBe(
      `${DIRECT_TEST_PASS_PROMPT_SENTINEL} implement request`,
    );
  });
});
