import { describe, expect, it } from "vitest";
import { IncompleteRunError } from "#domain/errors.js";
import { InkOperatorGate } from "#infrastructure/gate/ink-operator-gate.js";
import { InkRuntimeInteractionGate } from "#infrastructure/gate/ink-runtime-interaction-gate.js";
import { SilentOperatorGate } from "#infrastructure/gate/silent-operator-gate.js";
import { SilentRuntimeInteractionGate } from "#infrastructure/gate/silent-runtime-interaction-gate.js";
import { FakeHud } from "../../fakes/fake-hud.js";

describe("InkOperatorGate", () => {
  it("returns accept on y", async () => {
    const hud = new FakeHud();
    hud.queueAskAnswer("y");
    const gate = new InkOperatorGate(hud);

    await expect(gate.confirmPlan("preview")).resolves.toEqual({ kind: "accept" });
  });

  it("returns reject on n-like replan input", async () => {
    const hud = new FakeHud();
    hud.queueAskAnswer("r");
    const gate = new InkOperatorGate(hud);

    await expect(gate.confirmPlan("preview")).resolves.toEqual({ kind: "reject" });
  });

  it("returns edit with guidance", async () => {
    const hud = new FakeHud();
    hud.queueAskAnswer("e", "tighten the acceptance criteria");
    const gate = new InkOperatorGate(hud);

    await expect(gate.confirmPlan("preview")).resolves.toEqual({
      kind: "edit",
      guidance: "tighten the acceptance criteria",
    });
  });

  it("returns retry for retryable verify failures on r", async () => {
    const hud = new FakeHud();
    hud.queueAskAnswer("r");
    const gate = new InkOperatorGate(hud);

    await expect(gate.verifyFailed("Slice 1", "tests failed", true)).resolves.toEqual({
      kind: "retry",
    });
  });

  it("returns stop for non-retryable verify failures even if r is entered", async () => {
    const hud = new FakeHud();
    hud.queueAskAnswer("r");
    const gate = new InkOperatorGate(hud);

    await expect(gate.verifyFailed("Slice 1", "non-retryable failure", false)).resolves.toEqual({
      kind: "stop",
    });
    expect(hud.askPrompts).toEqual([
      "Slice 1 verification failed:\nnon-retryable failure\n\n(s)kip / s(t)op? ",
    ]);
  });

  it("returns skip for verify failures on s", async () => {
    const hud = new FakeHud();
    hud.queueAskAnswer("s");
    const gate = new InkOperatorGate(hud);

    await expect(gate.verifyFailed("Slice 1", "tests failed", true)).resolves.toEqual({
      kind: "skip",
    });
  });

  it("returns stop for retryable verify failures on t", async () => {
    const hud = new FakeHud();
    hud.queueAskAnswer("t");
    const gate = new InkOperatorGate(hud);

    await expect(gate.verifyFailed("Slice 1", "tests failed", true)).resolves.toEqual({
      kind: "stop",
    });
  });

  it("returns retry on credit exhaustion when r is entered", async () => {
    const hud = new FakeHud();
    hud.queueAskAnswer("r");
    const gate = new InkOperatorGate(hud);

    await expect(gate.creditExhausted("review", "quota reset soon")).resolves.toEqual({
      kind: "retry",
    });
  });

  it("returns quit on credit exhaustion when q is entered", async () => {
    const hud = new FakeHud();
    hud.queueAskAnswer("q");
    const gate = new InkOperatorGate(hud);

    await expect(gate.creditExhausted("review", "quota reset soon")).resolves.toEqual({
      kind: "quit",
    });
  });

  it("returns user input directly from askUser", async () => {
    const hud = new FakeHud();
    hud.queueAskAnswer("operator guidance");
    const gate = new InkOperatorGate(hud);

    await expect(gate.askUser("Prompt: ")).resolves.toBe("operator guidance");
  });

  it("returns false from confirmNextGroup when the operator answers n", async () => {
    const hud = new FakeHud();
    hud.queueAskAnswer("n");
    const gate = new InkOperatorGate(hud);

    await expect(gate.confirmNextGroup("Group 2")).resolves.toBe(false);
  });

  it("returns true from confirmNextGroup when the operator accepts the default", async () => {
    const hud = new FakeHud();
    hud.queueAskAnswer("");
    const gate = new InkOperatorGate(hud);

    await expect(gate.confirmNextGroup("Group 2")).resolves.toBe(true);
  });
});

describe("SilentOperatorGate", () => {
  it("auto-accepts plan confirmation", async () => {
    const gate = new SilentOperatorGate();

    await expect(gate.confirmPlan("preview")).resolves.toEqual({ kind: "accept" });
  });

  it("throws IncompleteRunError for verify failures in auto mode", async () => {
    const gate = new SilentOperatorGate();

    await expect(gate.verifyFailed("Slice 2", "tests failed", true)).rejects.toThrow(
      IncompleteRunError,
    );
  });

  it("auto-quits on credit exhaustion", async () => {
    const gate = new SilentOperatorGate();

    await expect(gate.creditExhausted("review", "quota exhausted")).resolves.toEqual({
      kind: "quit",
    });
  });

  it("returns an empty string from askUser", async () => {
    const gate = new SilentOperatorGate();

    await expect(gate.askUser("Prompt: ")).resolves.toBe("");
  });

  it("auto-confirms the next group", async () => {
    const gate = new SilentOperatorGate();

    await expect(gate.confirmNextGroup("Group 3")).resolves.toBe(true);
  });
});

describe("runtime interaction gates", () => {
  it("InkRuntimeInteractionGate rejects on n", async () => {
    const hud = new FakeHud();
    hud.queueAskAnswer("n");
    const gate = new InkRuntimeInteractionGate(hud);

    await expect(
      gate.decide({ kind: "commandApproval", summary: "Run build", command: "pnpm build" }),
    ).resolves.toEqual({ kind: "reject" });
    expect(hud.askPrompts).toEqual(["Run build — (y)es / (n)o / (c)ancel: "]);
  });

  it("InkRuntimeInteractionGate rejects on no", async () => {
    const hud = new FakeHud();
    hud.queueAskAnswer("no");
    const gate = new InkRuntimeInteractionGate(hud);

    await expect(
      gate.decide({ kind: "commandApproval", summary: "Run build", command: "pnpm build" }),
    ).resolves.toEqual({ kind: "reject" });
  });

  it("InkRuntimeInteractionGate cancels on c", async () => {
    const hud = new FakeHud();
    hud.queueAskAnswer("c");
    const gate = new InkRuntimeInteractionGate(hud);

    await expect(
      gate.decide({ kind: "permissionApproval", summary: "Allow network access" }),
    ).resolves.toEqual({ kind: "cancel" });
  });

  it("InkRuntimeInteractionGate cancels on cancel", async () => {
    const hud = new FakeHud();
    hud.queueAskAnswer("cancel");
    const gate = new InkRuntimeInteractionGate(hud);

    await expect(
      gate.decide({ kind: "permissionApproval", summary: "Allow network access" }),
    ).resolves.toEqual({ kind: "cancel" });
  });

  it("InkRuntimeInteractionGate approves by default", async () => {
    const hud = new FakeHud();
    hud.queueAskAnswer("");
    const gate = new InkRuntimeInteractionGate(hud);

    await expect(
      gate.decide({
        kind: "fileChangeApproval",
        summary: "Apply file changes",
        files: ["src/main.ts"],
      }),
    ).resolves.toEqual({ kind: "approve" });
  });

  it("SilentRuntimeInteractionGate auto-approves", async () => {
    const gate = new SilentRuntimeInteractionGate();

    await expect(
      gate.decide({ kind: "permissionApproval", summary: "Allow shell execution" }),
    ).resolves.toEqual({ kind: "approve" });
  });
});
