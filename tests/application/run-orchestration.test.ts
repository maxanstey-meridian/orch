import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentResult } from "../../src/domain/agent-types.js";
import type { AgentHandle } from "../../src/application/ports/agent-spawner.port.js";
import type { OrchestratorConfig } from "../../src/domain/config.js";
import type { Slice, Group } from "../../src/domain/plan.js";
import { RunOrchestration } from "../../src/application/run-orchestration.js";

// ── Helpers ──

const makeConfig = (overrides?: Partial<OrchestratorConfig>): OrchestratorConfig => ({
  cwd: "/tmp/test",
  planPath: "/tmp/plan.json",
  planContent: "plan content",
  brief: "brief",
  noInteraction: false,
  auto: false,
  reviewThreshold: 0,
  maxReviewCycles: 3,
  stateFile: "/tmp/state.json",
  tddSkill: "test",
  reviewSkill: "test",
  verifySkill: "test",
  gapDisabled: true,
  planDisabled: false,
  maxReplans: 3,
  ...overrides,
});

const makeResult = (overrides?: Partial<AgentResult>): AgentResult => ({
  exitCode: 0,
  assistantText: "",
  resultText: "",
  needsInput: false,
  sessionId: "test-session",
  ...overrides,
});

const makeAgent = (resultOverrides?: Partial<AgentResult>, stderr = ""): AgentHandle => ({
  sessionId: "agent-sess",
  style: { label: "Test", color: "#fff", badge: "[T]" },
  alive: true,
  stderr,
  send: vi.fn().mockResolvedValue(makeResult(resultOverrides)),
  sendQuiet: vi.fn().mockResolvedValue("quiet response"),
  inject: vi.fn(),
  kill: vi.fn(),
});

const makeSlice = (overrides?: Partial<Slice>): Slice => ({
  number: 1,
  title: "Test Slice",
  content: "slice content",
  why: "test why",
  files: [{ path: "src/test.ts", action: "new" }],
  details: "test details",
  tests: "test tests",
  ...overrides,
});

const makePorts = () => {
  const spawner = {
    spawn: vi.fn().mockReturnValue(makeAgent()),
  };
  const persistence = {
    load: vi.fn().mockResolvedValue({}),
    save: vi.fn().mockResolvedValue(undefined),
    clear: vi.fn().mockResolvedValue(undefined),
  };
  const gate = {
    confirmPlan: vi.fn().mockResolvedValue({ kind: "accept" as const }),
    verifyFailed: vi.fn().mockResolvedValue({ kind: "retry" as const }),
    askUser: vi.fn().mockResolvedValue(""),
    confirmNextGroup: vi.fn().mockResolvedValue(true),
  };
  const progressSink = {
    registerInterrupts: vi.fn().mockReturnValue({
      onGuide: vi.fn(),
      onInterrupt: vi.fn(),
    }),
    updateProgress: vi.fn(),
    setActivity: vi.fn(),
    teardown: vi.fn(),
  };
  const git = {
    captureRef: vi.fn().mockResolvedValue("sha0"),
    hasChanges: vi.fn().mockResolvedValue(false),
    hasDirtyTree: vi.fn().mockResolvedValue(false),
    getStatus: vi.fn().mockResolvedValue(""),
    stashBackup: vi.fn().mockResolvedValue(false),
    measureDiff: vi.fn().mockResolvedValue({ added: 0, removed: 0, total: 0 }),
  };
  const prompts = {
    plan: vi.fn().mockReturnValue("plan prompt"),
    tdd: vi.fn().mockReturnValue("tdd prompt"),
    tddExecute: vi.fn().mockReturnValue("tdd execute prompt"),
    review: vi.fn().mockReturnValue("review prompt"),
    completeness: vi.fn().mockReturnValue("completeness prompt"),
    gap: vi.fn().mockReturnValue("gap prompt"),
    commitSweep: vi.fn().mockReturnValue("commit sweep prompt"),
    finalPasses: vi.fn().mockReturnValue([]),
    withBrief: vi.fn().mockImplementation((p: string) => `brief: ${p}`),
    rulesReminder: vi.fn().mockReturnValue("rules reminder"),
  };
  return { spawner, persistence, gate, progressSink, git, prompts };
};

const makeUc = (
  ports = makePorts(),
  config = makeConfig(),
) => {
  const uc = new RunOrchestration(
    ports.spawner as any,
    ports.persistence as any,
    ports.gate as any,
    ports.git as any,
    ports.prompts as any,
    config,
    ports.progressSink as any,
  );
  uc.retryDelayMs = 0;
  return { uc, ...ports };
};

// ── Tests ──

describe("RunOrchestration", () => {
  describe("Cycle 1: scaffold", () => {
    it("resolves immediately for empty group list", async () => {
      const { uc } = makeUc();
      await expect(uc.execute([])).resolves.toBeUndefined();
    });
  });

  describe("Cycles 2-4: withRetry", () => {
    it("retries on transient API error then succeeds", async () => {
      const { uc, progressSink } = makeUc();
      const agent = makeAgent();
      const failResult = makeResult({ exitCode: 1, resultText: "529 overloaded" });
      const okResult = makeResult({ assistantText: "done" });
      const fn = vi.fn().mockResolvedValueOnce(failResult).mockResolvedValueOnce(okResult);

      const result = await uc.withRetry(fn, agent, "test-label");

      expect(fn).toHaveBeenCalledTimes(2);
      expect(result).toBe(okResult);
      expect(progressSink.setActivity).toHaveBeenCalled();
    });

    it("throws CreditExhaustedError on terminal API error", async () => {
      const { uc, persistence } = makeUc();
      const agent = makeAgent();
      const failResult = makeResult({
        exitCode: 1,
        resultText: "credit exhausted limit exceeded",
      });
      const fn = vi.fn().mockResolvedValue(failResult);

      await expect(uc.withRetry(fn, agent, "test-label")).rejects.toThrow("Terminal API error");
      expect(persistence.save).toHaveBeenCalled();
    });

    it("returns result when no API error", async () => {
      const { uc } = makeUc();
      const agent = makeAgent();
      const expected = makeResult({ assistantText: "done" });
      const fn = vi.fn().mockResolvedValue(expected);

      const result = await uc.withRetry(fn, agent, "test-label");

      expect(fn).toHaveBeenCalledOnce();
      expect(result).toBe(expected);
    });

    it("detects API error via agent.stderr, not result.stderr", async () => {
      const { uc } = makeUc();
      // Agent has stderr with overloaded message, result has no stderr
      const agent = makeAgent(undefined, "529 overloaded");
      const failResult = makeResult({ exitCode: 1 });
      const okResult = makeResult({ assistantText: "done" });
      const fn = vi.fn().mockResolvedValueOnce(failResult).mockResolvedValueOnce(okResult);

      const result = await uc.withRetry(fn, agent, "test-label");

      expect(fn).toHaveBeenCalledTimes(2);
      expect(result).toBe(okResult);
    });
  });

  describe("checkCredit", () => {
    it("throws CreditExhaustedError for terminal error on bare send", async () => {
      const { uc, persistence } = makeUc();
      const agent = makeAgent(undefined, "credit exhausted limit exceeded");
      const result = makeResult({ exitCode: 1 });

      await expect(uc.checkCredit(result, agent)).rejects.toThrow("Terminal API error");
      expect(persistence.save).toHaveBeenCalled();
    });

    it("does nothing when result is successful", async () => {
      const { uc, persistence } = makeUc();
      const agent = makeAgent();
      const result = makeResult({ exitCode: 0 });

      await expect(uc.checkCredit(result, agent)).resolves.toBeUndefined();
      expect(persistence.save).not.toHaveBeenCalled();
    });
  });

  describe("Cycles 5-6: followUp", () => {
    it("loops until agent stops requesting input", async () => {
      const { uc, gate } = makeUc();
      const finalResult = makeResult({ needsInput: false, assistantText: "done" });
      const agent = makeAgent();
      (agent.send as ReturnType<typeof vi.fn>).mockResolvedValue(finalResult);
      gate.askUser.mockResolvedValue("user answer");

      const firstResult = makeResult({ needsInput: true });
      const result = await uc.followUp(firstResult, agent);

      expect(gate.askUser).toHaveBeenCalledOnce();
      expect(agent.send).toHaveBeenCalledOnce();
      expect(result.needsInput).toBe(false);
    });

    it("sends autonomous message when user gives empty answer", async () => {
      const { uc, gate } = makeUc();
      const finalResult = makeResult({ needsInput: false });
      const agent = makeAgent();
      (agent.send as ReturnType<typeof vi.fn>).mockResolvedValue(finalResult);
      gate.askUser.mockResolvedValue("");

      const firstResult = makeResult({ needsInput: true });
      await uc.followUp(firstResult, agent);

      const sendCall = (agent.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(sendCall).toContain("proceed with your best judgement");
    });
  });

  describe("Cycles 9-11: planThenExecute", () => {
    it("sends slice directly to TDD when plan is disabled", async () => {
      const ports = makePorts();
      const config = makeConfig({ planDisabled: true });
      const { uc, prompts, spawner } = makeUc(ports, config);
      uc.tddAgent = makeAgent();
      uc.phase = { kind: "Planning", sliceNumber: 1, attempt: 1 };
      prompts.tdd.mockReturnValue("tdd prompt");
      prompts.withBrief.mockImplementation((p: string) => `brief: ${p}`);

      const result = await uc.planThenExecute("slice content", 1);

      expect(prompts.tdd).toHaveBeenCalledWith("slice content", undefined, 1);
      expect(spawner.spawn).not.toHaveBeenCalledWith("plan", expect.anything());
      expect(result.skipped).toBe(false);
      expect(result.replan).toBeUndefined();
    });

    it("spawns plan agent, gates operator, executes on accept", async () => {
      const ports = makePorts();
      const config = makeConfig({ planDisabled: false });
      const { uc, spawner, gate, prompts } = makeUc(ports, config);
      const tddAgent = makeAgent();
      const planAgent = makeAgent({ planText: "the plan" });
      uc.tddAgent = tddAgent;
      uc.phase = { kind: "Planning", sliceNumber: 1, attempt: 1 };

      spawner.spawn.mockReturnValue(planAgent);
      gate.confirmPlan.mockResolvedValue({ kind: "accept" as const });
      prompts.tddExecute.mockReturnValue("exec prompt");

      const result = await uc.planThenExecute("slice content", 1);

      expect(spawner.spawn).toHaveBeenCalledWith("plan", expect.anything());
      expect(gate.confirmPlan).toHaveBeenCalledWith("the plan");
      expect(planAgent.kill).toHaveBeenCalled();
      expect(tddAgent.send).toHaveBeenCalled();
      expect(result.planText).toBe("the plan");
      expect(result.skipped).toBe(false);
    });

    it("returns replan flag when operator rejects plan", async () => {
      const ports = makePorts();
      const config = makeConfig({ planDisabled: false });
      const { uc, spawner, gate } = makeUc(ports, config);
      const planAgent = makeAgent({ planText: "the plan" });
      uc.tddAgent = makeAgent();
      uc.phase = { kind: "Planning", sliceNumber: 1, attempt: 1 };

      spawner.spawn.mockReturnValue(planAgent);
      gate.confirmPlan.mockResolvedValue({ kind: "reject" as const });

      const result = await uc.planThenExecute("slice content", 1);

      expect(result.replan).toBe(true);
      expect(planAgent.kill).toHaveBeenCalled();
      expect((uc.tddAgent!.send as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    });
  });

  describe("Cycles 25-26: respawn", () => {
    it("respawnTdd kills old agent, spawns new, saves state", async () => {
      const ports = makePorts();
      const { uc, spawner, persistence } = makeUc(ports);
      const oldAgent = makeAgent();
      uc.tddAgent = oldAgent;
      const newAgent = makeAgent({ sessionId: "new-tdd" });
      spawner.spawn.mockReturnValue(newAgent);

      await uc.respawnTdd();

      expect(oldAgent.kill).toHaveBeenCalled();
      expect(spawner.spawn).toHaveBeenCalledWith("tdd", expect.anything());
      expect(persistence.save).toHaveBeenCalled();
      expect(uc.tddAgent).toBe(newAgent);
      expect(uc.tddIsFirst).toBe(true);
    });

    it("respawnBoth kills tdd + review + verify, spawns fresh pair", async () => {
      const ports = makePorts();
      const { uc, spawner, persistence } = makeUc(ports);
      const oldTdd = makeAgent();
      const oldReview = makeAgent();
      const oldVerify = makeAgent();
      uc.tddAgent = oldTdd;
      uc.reviewAgent = oldReview;
      uc.verifyAgent = oldVerify;

      const newTdd = makeAgent({ sessionId: "new-tdd" });
      const newReview = makeAgent({ sessionId: "new-review" });
      spawner.spawn
        .mockReturnValueOnce(newTdd)
        .mockReturnValueOnce(newReview);

      await uc.respawnBoth();

      expect(oldTdd.kill).toHaveBeenCalled();
      expect(oldReview.kill).toHaveBeenCalled();
      expect(oldVerify.kill).toHaveBeenCalled();
      expect(uc.verifyAgent).toBeNull();
      expect(uc.tddAgent).toBe(newTdd);
      expect(uc.reviewAgent).toBe(newReview);
      expect(persistence.save).toHaveBeenCalled();
      expect(uc.tddIsFirst).toBe(true);
      expect(uc.reviewIsFirst).toBe(true);
    });
  });

  describe("Cycles 21-24: execute", () => {
    it("processes single slice end-to-end with plan disabled", async () => {
      const ports = makePorts();
      const config = makeConfig({
        planDisabled: true,
        gapDisabled: true,
        verifySkill: null,
        reviewSkill: null,
      });
      const { uc, spawner, persistence } = makeUc(ports, config);
      const tddAgent = makeAgent();
      const reviewAgent = makeAgent();
      spawner.spawn
        .mockReturnValueOnce(tddAgent)   // tdd
        .mockReturnValueOnce(reviewAgent); // review

      const groups: Group[] = [
        { name: "G1", slices: [makeSlice({ number: 1 })] },
      ];
      await uc.execute(groups);

      // TDD agent was sent the slice
      expect(tddAgent.send).toHaveBeenCalled();
      // State was persisted
      expect(persistence.save).toHaveBeenCalled();
    });

    it("skips slices already completed in persisted state", async () => {
      const ports = makePorts();
      const config = makeConfig({
        planDisabled: true,
        gapDisabled: true,
        verifySkill: null,
        reviewSkill: null,
      });
      ports.persistence.load.mockResolvedValue({ lastCompletedSlice: 1 });
      const { uc, spawner } = makeUc(ports, config);
      const tddAgent = makeAgent();
      const reviewAgent = makeAgent();
      spawner.spawn
        .mockReturnValueOnce(tddAgent)
        .mockReturnValueOnce(reviewAgent);

      const groups: Group[] = [
        {
          name: "G1",
          slices: [makeSlice({ number: 1 }), makeSlice({ number: 2 })],
        },
      ];
      await uc.execute(groups);

      // TDD send should only happen for slice 2, not slice 1
      // The first send is the rules reminder (sendQuiet), then tdd prompt for slice 2
      expect(tddAgent.send).toHaveBeenCalledTimes(1);
    });

    it("replans up to maxReplans then force-accepts", async () => {
      const ports = makePorts();
      const config = makeConfig({
        planDisabled: false,
        gapDisabled: true,
        maxReplans: 3,
        verifySkill: null,
        reviewSkill: null,
      });
      const { uc, spawner, gate } = makeUc(ports, config);
      const tddAgent = makeAgent();
      const reviewAgent = makeAgent();
      const planAgent = makeAgent({ planText: "the plan" });

      let spawnCount = 0;
      spawner.spawn.mockImplementation((role: string) => {
        if (role === "tdd") return tddAgent;
        if (role === "review") return reviewAgent;
        return planAgent; // plan agent
      });

      // Reject first 3 times, then gate won't be called (force-accept)
      gate.confirmPlan
        .mockResolvedValueOnce({ kind: "reject" as const })
        .mockResolvedValueOnce({ kind: "reject" as const })
        .mockResolvedValueOnce({ kind: "reject" as const })
        .mockResolvedValueOnce({ kind: "accept" as const });

      const groups: Group[] = [
        { name: "G1", slices: [makeSlice({ number: 1 })] },
      ];
      await uc.execute(groups);

      // Plan agent spawned 4 times (3 rejects + 1 force-accept which skips gate)
      const planSpawns = spawner.spawn.mock.calls.filter(
        (c: any[]) => c[0] === "plan",
      );
      expect(planSpawns.length).toBe(4);
      // Gate called only 3 times (4th is force-accept, skips gate)
      expect(gate.confirmPlan).toHaveBeenCalledTimes(3);
    });
  });

  describe("Cycles 19-20: runSlice", () => {
    it("skips verify/review when already implemented", async () => {
      const ports = makePorts();
      const { uc, git, persistence, spawner } = makeUc(ports);
      // Same SHA = no changes
      git.captureRef.mockResolvedValue("sha0");
      uc.tddAgent = makeAgent();
      uc.reviewAgent = makeAgent();

      const tddResult = makeResult({ assistantText: "already implemented" });
      const result = await uc.runSlice(makeSlice(), "sha0", tddResult, "sha0");

      expect(result.skipped).toBe(false);
      expect(persistence.save).toHaveBeenCalled();
      // Verify agent should NOT have been spawned
      expect(spawner.spawn).not.toHaveBeenCalledWith("verify", expect.anything());
    });

    it("runs verify, diff check, review, and summary for real implementation", async () => {
      const ports = makePorts();
      const config = makeConfig({ verifySkill: "test", reviewSkill: "test", reviewThreshold: 0 });
      const { uc, git, spawner, persistence } = makeUc(ports, config);
      uc.phase = { kind: "Verifying", sliceNumber: 1 };
      // Different SHA = real changes
      git.captureRef.mockResolvedValue("sha1");
      git.hasChanges.mockResolvedValue(true);
      git.measureDiff.mockResolvedValue({ added: 30, removed: 20, total: 50 });

      // Verify passes
      const verifyAgent = makeAgent({
        assistantText: "### VERIFY_RESULT\n**Status:** PASS\n",
      });
      spawner.spawn.mockReturnValue(verifyAgent);

      // Review clean
      const reviewAgent = makeAgent({ assistantText: "REVIEW_CLEAN" });
      uc.reviewAgent = reviewAgent;

      const tddAgent = makeAgent();
      uc.tddAgent = tddAgent;

      const tddResult = makeResult({ assistantText: "implemented feature" });
      const result = await uc.runSlice(makeSlice(), "sha0", tddResult, "sha0");

      expect(result.skipped).toBe(false);
      // Verify agent was used
      expect(spawner.spawn).toHaveBeenCalledWith("verify", expect.anything());
      // Review was run
      expect(reviewAgent.send).toHaveBeenCalled();
      // Summary was requested
      expect(tddAgent.sendQuiet).toHaveBeenCalled();
      // State was persisted
      expect(persistence.save).toHaveBeenCalled();
    });
  });

  describe("Cycles 17-18: reviewFix", () => {
    it("exits after one cycle when review is clean", async () => {
      const ports = makePorts();
      const { uc, git } = makeUc(ports);
      const reviewAgent = makeAgent({ assistantText: "REVIEW_CLEAN" });
      uc.reviewAgent = reviewAgent;
      uc.tddAgent = makeAgent();
      git.hasChanges.mockResolvedValue(true);

      await uc.reviewFix("content", "sha0");

      expect(reviewAgent.send).toHaveBeenCalledOnce();
      expect((uc.tddAgent!.send as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    });

    it("sends review findings to TDD and loops up to maxReviewCycles", async () => {
      const ports = makePorts();
      const config = makeConfig({ maxReviewCycles: 2 });
      const { uc, git } = makeUc(ports, config);
      const reviewAgent = makeAgent({ assistantText: "found issues: fix X" });
      uc.reviewAgent = reviewAgent;
      uc.tddAgent = makeAgent();
      uc.phase = { kind: "Reviewing", sliceNumber: 1, cycle: 1 };
      git.hasChanges.mockResolvedValue(true);
      git.captureRef.mockResolvedValue("sha1");

      await uc.reviewFix("content", "sha0");

      expect(reviewAgent.send).toHaveBeenCalledTimes(2);
      expect((uc.tddAgent!.send as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(2);
    });
  });

  describe("Cycles 15-16: completenessCheck", () => {
    it("skips when no changes since base", async () => {
      const ports = makePorts();
      const { uc, git, spawner } = makeUc(ports);
      git.hasChanges.mockResolvedValue(false);
      uc.tddAgent = makeAgent();

      await uc.completenessCheck(makeSlice(), "sha0");

      // Should not spawn a completeness agent
      expect(spawner.spawn).not.toHaveBeenCalledWith("completeness", expect.anything());
    });

    it("sends completeness issues to TDD agent for fixing", async () => {
      const ports = makePorts();
      const { uc, git, spawner, prompts } = makeUc(ports);
      git.hasChanges.mockResolvedValue(true);
      uc.phase = { kind: "Verifying", sliceNumber: 1 };
      const completenessAgent = makeAgent({
        assistantText: "Missing: feature X not implemented",
      });
      spawner.spawn.mockReturnValue(completenessAgent);
      uc.tddAgent = makeAgent();
      prompts.tdd.mockReturnValue("fix prompt");

      await uc.completenessCheck(makeSlice(), "sha0");

      expect(spawner.spawn).toHaveBeenCalledWith("completeness", expect.anything());
      expect(completenessAgent.kill).toHaveBeenCalled();
      expect((uc.tddAgent!.send as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
    });
  });

  describe("Cycles 12-14: verify", () => {
    it("returns true when verification passes", async () => {
      const ports = makePorts();
      const { uc, spawner } = makeUc(ports);
      const verifyAgent = makeAgent({
        assistantText: "### VERIFY_RESULT\n**Status:** PASS\n",
      });
      spawner.spawn.mockReturnValue(verifyAgent);
      uc.tddAgent = makeAgent();

      const result = await uc.verify(makeSlice(), "sha0");

      expect(result).toBe(true);
      expect(spawner.spawn).toHaveBeenCalledWith("verify", expect.anything());
    });

    it("gates operator on double verify failure, skip returns false", async () => {
      const ports = makePorts();
      const { uc, spawner, gate } = makeUc(ports);
      const verifyAgent = makeAgent({
        assistantText: "### VERIFY_RESULT\n**Status:** FAIL\n**New failures:**\n- test broke\n",
      });
      spawner.spawn.mockReturnValue(verifyAgent);
      uc.tddAgent = makeAgent();
      uc.phase = { kind: "Verifying", sliceNumber: 1 };
      gate.verifyFailed.mockResolvedValue({ kind: "skip" as const });

      const result = await uc.verify(makeSlice(), "sha0");

      expect(result).toBe(false);
      expect((uc.tddAgent!.send as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
      expect(gate.verifyFailed).toHaveBeenCalled();
    });

    it("wraps verify and fix sends in withRetry", async () => {
      const ports = makePorts();
      const { uc, spawner } = makeUc(ports);
      // Verify agent fails once with overloaded then passes
      const verifyAgent = {
        ...makeAgent(undefined, ""),
        send: vi.fn()
          .mockResolvedValueOnce(makeResult({
            exitCode: 1,
            resultText: "529 overloaded",
            assistantText: "",
          }))
          .mockResolvedValueOnce(makeResult({
            assistantText: "### VERIFY_RESULT\n**Status:** PASS\n",
          })),
        stderr: "529 overloaded",
      } as unknown as AgentHandle;
      spawner.spawn.mockReturnValue(verifyAgent);
      uc.tddAgent = makeAgent();

      const result = await uc.verify(makeSlice(), "sha0");

      expect(result).toBe(true);
      // verify agent send called twice (retry after overloaded)
      expect(verifyAgent.send).toHaveBeenCalledTimes(2);
    });

    it("stops execution when operator chooses stop on verify failure", async () => {
      const ports = makePorts();
      const { uc, spawner, gate, progressSink } = makeUc(ports);
      const verifyAgent = makeAgent({
        assistantText: "### VERIFY_RESULT\n**Status:** FAIL\n",
      });
      spawner.spawn.mockReturnValue(verifyAgent);
      uc.tddAgent = makeAgent();
      uc.phase = { kind: "Verifying", sliceNumber: 1 };
      gate.verifyFailed.mockResolvedValue({ kind: "stop" as const });

      await expect(uc.verify(makeSlice(), "sha0")).rejects.toThrow("Operator stopped");
      expect(progressSink.teardown).toHaveBeenCalled();
    });
  });

  describe("Slice 14: inter-group transitions", () => {
    it("calls gate.confirmNextGroup between groups, respawns agents", async () => {
      const ports = makePorts();
      const config = makeConfig({
        planDisabled: true,
        gapDisabled: true,
        verifySkill: null,
        reviewSkill: null,
        auto: false,
        noInteraction: false,
      });
      const { uc, spawner, gate } = makeUc(ports, config);
      gate.confirmNextGroup.mockResolvedValue(true);
      const tddAgent = makeAgent();
      const reviewAgent = makeAgent();
      spawner.spawn.mockReturnValue(tddAgent);

      const groups: Group[] = [
        { name: "G1", slices: [makeSlice({ number: 1 })] },
        { name: "G2", slices: [makeSlice({ number: 2 })] },
      ];
      await uc.execute(groups);

      expect(gate.confirmNextGroup).toHaveBeenCalledOnce();
      const label = gate.confirmNextGroup.mock.calls[0][0] as string;
      expect(label).toContain("G2");
      // Agents should have been respawned between groups
      const tddSpawns = spawner.spawn.mock.calls.filter((c: any[]) => c[0] === "tdd");
      expect(tddSpawns.length).toBeGreaterThanOrEqual(2);
    });

    it("stops when gate.confirmNextGroup returns false", async () => {
      const ports = makePorts();
      const config = makeConfig({
        planDisabled: true,
        gapDisabled: true,
        verifySkill: null,
        reviewSkill: null,
        auto: false,
        noInteraction: false,
      });
      const { uc, spawner, gate } = makeUc(ports, config);
      gate.confirmNextGroup.mockResolvedValue(false);
      spawner.spawn.mockReturnValue(makeAgent());

      const groups: Group[] = [
        { name: "G1", slices: [makeSlice({ number: 1 })] },
        { name: "G2", slices: [makeSlice({ number: 2 })] },
      ];
      await uc.execute(groups);

      // Only first group's TDD send happened
      // Second group slice should not have been processed
      expect(gate.confirmNextGroup).toHaveBeenCalledOnce();
      // finalPasses should not run since we returned early
      expect(ports.prompts.finalPasses).not.toHaveBeenCalled();
    });
  });

  describe("Slice 14: onToolUse wiring", () => {
    it("progressSink.setActivity called via onToolUse callback in gap sends", async () => {
      const ports = makePorts();
      const config = makeConfig({ gapDisabled: false });
      const { uc, git, spawner, progressSink } = makeUc(ports, config);
      git.hasChanges.mockResolvedValue(true);

      // Capture the onToolUse callback and invoke it
      const gapAgent = makeAgent({ assistantText: "NO_GAPS_FOUND" });
      (gapAgent.send as ReturnType<typeof vi.fn>).mockImplementation(
        async (_prompt: string, _onText?: unknown, onToolUse?: (s: string) => void) => {
          if (onToolUse) onToolUse("running tests");
          return makeResult({ assistantText: "NO_GAPS_FOUND" });
        },
      );
      spawner.spawn.mockReturnValue(gapAgent);
      uc.tddAgent = makeAgent();

      await uc.gapAnalysis(
        { name: "G1", slices: [makeSlice()] },
        "sha0",
      );

      expect(progressSink.setActivity).toHaveBeenCalledWith("running tests");
    });
  });

  describe("Slice 14: execute wiring", () => {
    it("calls gapAnalysis after slices, before commit sweep", async () => {
      const ports = makePorts();
      const config = makeConfig({
        planDisabled: true,
        gapDisabled: false,
        verifySkill: null,
        reviewSkill: null,
      });
      const { uc, spawner, git, prompts } = makeUc(ports, config);
      git.hasChanges.mockResolvedValue(true);

      const tddAgent = makeAgent();
      const reviewAgent = makeAgent();
      const gapAgent = makeAgent({ assistantText: "NO_GAPS_FOUND" });
      spawner.spawn
        .mockReturnValueOnce(tddAgent)     // tdd
        .mockReturnValueOnce(reviewAgent)   // review
        .mockReturnValue(gapAgent);         // gap (and others)

      const groups: Group[] = [
        { name: "G1", slices: [makeSlice({ number: 1 })] },
      ];
      await uc.execute(groups);

      expect(spawner.spawn).toHaveBeenCalledWith("gap", expect.anything());
      expect(prompts.gap).toHaveBeenCalled();
      expect(gapAgent.kill).toHaveBeenCalled();
    });

    it("calls finalPasses after all groups complete", async () => {
      const ports = makePorts();
      const config = makeConfig({
        planDisabled: true,
        gapDisabled: true,
        verifySkill: null,
        reviewSkill: null,
      });
      const { uc, spawner, git, prompts } = makeUc(ports, config);
      git.hasChanges.mockResolvedValue(true);
      prompts.finalPasses.mockReturnValue([
        { name: "Pass1", prompt: "p1" },
      ]);
      const tddAgent = makeAgent();
      const reviewAgent = makeAgent();
      const finalAgent = makeAgent({ assistantText: "NO_ISSUES_FOUND" });
      spawner.spawn
        .mockReturnValueOnce(tddAgent)
        .mockReturnValueOnce(reviewAgent)
        .mockReturnValue(finalAgent);

      const groups: Group[] = [
        { name: "G1", slices: [makeSlice({ number: 1 })] },
      ];
      await uc.execute(groups);

      expect(prompts.finalPasses).toHaveBeenCalled();
      expect(spawner.spawn).toHaveBeenCalledWith("final", expect.anything());
    });
  });

  describe("Slice 14: finalPasses", () => {
    it("skips when no changes since runBaseSha", async () => {
      const ports = makePorts();
      const { uc, git, prompts } = makeUc(ports);
      git.hasChanges.mockResolvedValue(false);
      uc.tddAgent = makeAgent();

      await uc.finalPasses("sha0");

      expect(prompts.finalPasses).not.toHaveBeenCalled();
    });

    it("spawns fresh agent per pass, skips fix when clean", async () => {
      const ports = makePorts();
      const { uc, git, spawner, prompts } = makeUc(ports);
      git.hasChanges.mockResolvedValue(true);
      prompts.finalPasses.mockReturnValue([
        { name: "Type fidelity", prompt: "check types" },
      ]);
      const finalAgent = makeAgent({ assistantText: "NO_ISSUES_FOUND" });
      spawner.spawn.mockReturnValue(finalAgent);
      uc.tddAgent = makeAgent();

      await uc.finalPasses("sha0");

      expect(spawner.spawn).toHaveBeenCalledWith("final", expect.anything());
      expect(finalAgent.send).toHaveBeenCalled();
      expect(finalAgent.kill).toHaveBeenCalled();
      expect((uc.tddAgent!.send as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    });

    it("sends findings to TDD, runs review-fix", async () => {
      const ports = makePorts();
      const config = makeConfig({ reviewSkill: "test" });
      const { uc, git, spawner, prompts } = makeUc(ports, config);
      git.hasChanges.mockResolvedValue(true);
      git.captureRef.mockResolvedValue("sha1");
      prompts.finalPasses.mockReturnValue([
        { name: "Type check", prompt: "check" },
      ]);
      const finalAgent = makeAgent({ assistantText: "Found: any cast in foo.ts" });
      spawner.spawn.mockReturnValue(finalAgent);
      const tddAgent = makeAgent();
      uc.tddAgent = tddAgent;
      const reviewAgent = makeAgent({ assistantText: "REVIEW_CLEAN" });
      uc.reviewAgent = reviewAgent;

      await uc.finalPasses("sha0");

      expect(prompts.tdd).toHaveBeenCalled();
      const tddCallArg = prompts.tdd.mock.calls[0][1] as string;
      expect(tddCallArg).toContain("Found: any cast in foo.ts");
      expect(tddAgent.send).toHaveBeenCalled();
      expect(reviewAgent.send).toHaveBeenCalled();
    });
  });

  describe("Slice 14: gapAnalysis", () => {
    const makeGroup = (): Group => ({
      name: "TestGroup",
      slices: [makeSlice({ number: 1 }), makeSlice({ number: 2 })],
    });

    it("skips when gapDisabled is true", async () => {
      const ports = makePorts();
      const config = makeConfig({ gapDisabled: true });
      const { uc, spawner } = makeUc(ports, config);
      uc.tddAgent = makeAgent();

      await uc.gapAnalysis(makeGroup(), "sha0");

      expect(spawner.spawn).not.toHaveBeenCalledWith("gap", expect.anything());
    });

    it("skips when no changes since groupBaseSha", async () => {
      const ports = makePorts();
      const config = makeConfig({ gapDisabled: false });
      const { uc, git, spawner } = makeUc(ports, config);
      git.hasChanges.mockResolvedValue(false);
      uc.tddAgent = makeAgent();

      await uc.gapAnalysis(makeGroup(), "sha0");

      expect(spawner.spawn).not.toHaveBeenCalledWith("gap", expect.anything());
    });

    it("spawns gap agent, detects NO_GAPS_FOUND, no fix cycle", async () => {
      const ports = makePorts();
      const config = makeConfig({ gapDisabled: false });
      const { uc, git, spawner, prompts } = makeUc(ports, config);
      git.hasChanges.mockResolvedValue(true);
      const gapAgent = makeAgent({ assistantText: "Analysis complete. NO_GAPS_FOUND" });
      spawner.spawn.mockReturnValue(gapAgent);
      uc.tddAgent = makeAgent();

      await uc.gapAnalysis(makeGroup(), "sha0");

      expect(spawner.spawn).toHaveBeenCalledWith("gap", expect.anything());
      expect(prompts.gap).toHaveBeenCalled();
      expect(gapAgent.kill).toHaveBeenCalled();
      expect((uc.tddAgent!.send as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    });

    it("sends findings to TDD, runs review-fix cycle", async () => {
      const ports = makePorts();
      const config = makeConfig({ gapDisabled: false, reviewSkill: "test" });
      const { uc, git, spawner, prompts } = makeUc(ports, config);
      git.hasChanges.mockResolvedValue(true);
      git.captureRef.mockResolvedValue("sha1");
      const gapAgent = makeAgent({ assistantText: "Missing tests for X" });
      spawner.spawn.mockReturnValue(gapAgent);
      const tddAgent = makeAgent();
      uc.tddAgent = tddAgent;
      const reviewAgent = makeAgent({ assistantText: "REVIEW_CLEAN" });
      uc.reviewAgent = reviewAgent;

      await uc.gapAnalysis(makeGroup(), "sha0");

      expect(prompts.tdd).toHaveBeenCalled();
      const tddCallArg = prompts.tdd.mock.calls[0][1] as string;
      expect(tddCallArg).toContain("Missing tests for X");
      expect(tddAgent.send).toHaveBeenCalled();
      expect(reviewAgent.send).toHaveBeenCalled();
      expect(gapAgent.kill).toHaveBeenCalled();
    });
  });

  describe("Slice 14: onToolUse", () => {
    it("calls progressSink.setActivity", () => {
      const { uc, progressSink } = makeUc();
      uc.onToolUse("running tests");
      expect(progressSink.setActivity).toHaveBeenCalledWith("running tests");
    });
  });

  describe("Cycles 7-8: commitSweep", () => {
    it("does nothing when working tree is clean", async () => {
      const { uc, git } = makeUc();
      uc.tddAgent = makeAgent();
      git.hasDirtyTree.mockResolvedValue(false);

      await uc.commitSweep("Slice 1");

      expect((uc.tddAgent!.send as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    });

    it("sends commitSweep prompt to TDD agent when tree is dirty", async () => {
      const ports = makePorts();
      const { uc, git, prompts } = makeUc(ports);
      uc.tddAgent = makeAgent();
      git.hasDirtyTree.mockResolvedValue(true);
      prompts.commitSweep.mockReturnValue("sweep prompt");

      await uc.commitSweep("Slice 1");

      expect(prompts.commitSweep).toHaveBeenCalledWith("Slice 1");
      expect((uc.tddAgent!.send as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
    });

    it("bails out when TDD agent is not alive", async () => {
      const { uc, git } = makeUc();
      const deadAgent = { ...makeAgent(), alive: false } as unknown as AgentHandle;
      uc.tddAgent = deadAgent;
      git.hasDirtyTree.mockResolvedValue(true);

      await uc.commitSweep("Slice 1");

      expect((deadAgent.send as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    });
  });

  describe("Gap: planThenExecute edit guidance", () => {
    it("passes operator edit guidance to tddExecute prompt", async () => {
      const ports = makePorts();
      const config = makeConfig({ planDisabled: false });
      const { uc, spawner, gate, prompts } = makeUc(ports, config);
      const planAgent = makeAgent({ planText: "the plan" });
      spawner.spawn.mockReturnValue(planAgent);
      uc.tddAgent = makeAgent();
      uc.phase = { kind: "Planning", sliceNumber: 1, attempt: 1 };
      gate.confirmPlan.mockResolvedValue({
        kind: "edit" as const,
        guidance: "fix the types",
      });

      await uc.planThenExecute("slice content", 1);

      expect(prompts.tddExecute).toHaveBeenCalledWith(
        "the plan",
        1,
        expect.any(Boolean),
        "fix the types",
      );
    });
  });

  describe("Gap: plan prompt brief wrapping", () => {
    it("plan prompt is not double-wrapped with brief", async () => {
      const ports = makePorts();
      const config = makeConfig({ planDisabled: false, auto: true });
      const { uc, spawner, prompts } = makeUc(ports, config);
      const planAgent = makeAgent({ planText: "the plan" });
      spawner.spawn.mockReturnValue(planAgent);
      uc.tddAgent = makeAgent();
      uc.phase = { kind: "Planning", sliceNumber: 1, attempt: 1 };

      await uc.planThenExecute("slice content", 1);

      // plan() already includes brief — withBrief should NOT be called on the plan prompt
      const planSendArg = (planAgent.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
      // If withBrief were called on plan()'s output, we'd see "brief: plan prompt"
      // instead of just "plan prompt"
      expect(planSendArg).toBe("plan prompt");
      expect(prompts.withBrief).not.toHaveBeenCalledWith("plan prompt");
    });

    it("tddExecute first-slice prompt is not double-wrapped with brief", async () => {
      const ports = makePorts();
      const config = makeConfig({ planDisabled: false, auto: true });
      const { uc, spawner, prompts } = makeUc(ports, config);
      const planAgent = makeAgent({ planText: "the plan" });
      spawner.spawn.mockReturnValue(planAgent);
      const tddAgent = makeAgent();
      uc.tddAgent = tddAgent;
      uc.phase = { kind: "Planning", sliceNumber: 1, attempt: 1 };
      uc.tddIsFirst = true;
      prompts.tddExecute.mockReturnValue("exec prompt");

      await uc.planThenExecute("slice content", 1);

      // tddExecute already includes brief when firstSlice=true —
      // withBrief should NOT be called on tddExecute's output
      const tddSendArg = (tddAgent.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(tddSendArg).toBe("exec prompt");
      expect(prompts.withBrief).not.toHaveBeenCalledWith("exec prompt");
    });
  });

  describe("Gap: planThenExecute dead session fallback", () => {
    it("respawns TDD when agent dies during execute phase", async () => {
      const ports = makePorts();
      const config = makeConfig({ planDisabled: false, auto: true });
      const { uc, spawner } = makeUc(ports, config);
      const planAgent = makeAgent({ planText: "the plan" });
      uc.phase = { kind: "Planning", sliceNumber: 1, attempt: 1 };

      // First TDD agent dies after send
      const deadTddAgent = {
        ...makeAgent(),
        alive: false,
        send: vi.fn().mockResolvedValue(makeResult()),
      } as unknown as AgentHandle;
      uc.tddAgent = deadTddAgent;

      // Spawner returns plan agent first, then new TDD on respawn
      const freshTddAgent = makeAgent();
      spawner.spawn
        .mockReturnValueOnce(planAgent) // plan
        .mockReturnValue(freshTddAgent); // respawn tdd

      const result = await uc.planThenExecute("slice content", 1);

      // Old agent was killed, new one was spawned
      expect(deadTddAgent.kill).toHaveBeenCalled();
      expect(spawner.spawn).toHaveBeenCalledWith("tdd", expect.anything());
      expect(result.skipped).toBe(false);
    });
  });

  describe("Gap: inter-group auto mode", () => {
    it("skips gate.confirmNextGroup when config.auto is true", async () => {
      const ports = makePorts();
      const config = makeConfig({
        planDisabled: true,
        gapDisabled: true,
        verifySkill: null,
        reviewSkill: null,
        auto: true,
      });
      const { uc, spawner, gate } = makeUc(ports, config);
      spawner.spawn.mockReturnValue(makeAgent());

      const groups: Group[] = [
        { name: "G1", slices: [makeSlice({ number: 1 })] },
        { name: "G2", slices: [makeSlice({ number: 2 })] },
      ];
      await uc.execute(groups);

      expect(gate.confirmNextGroup).not.toHaveBeenCalled();
    });
  });

  describe("Gap: execute followUp wiring", () => {
    it("calls followUp when TDD result has needsInput after planThenExecute", async () => {
      const ports = makePorts();
      const config = makeConfig({
        planDisabled: true,
        gapDisabled: true,
        verifySkill: null,
        reviewSkill: null,
      });
      const { uc, spawner, gate } = makeUc(ports, config);
      const tddAgent = makeAgent({ needsInput: true });
      // After followUp, agent returns non-needsInput result
      (tddAgent.send as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(makeResult({ needsInput: true }))
        .mockResolvedValue(makeResult({ needsInput: false }));
      const reviewAgent = makeAgent();
      spawner.spawn
        .mockReturnValueOnce(tddAgent)
        .mockReturnValueOnce(reviewAgent)
        .mockReturnValue(makeAgent());
      gate.askUser.mockResolvedValue("user input");

      const groups: Group[] = [
        { name: "G1", slices: [makeSlice({ number: 1 })] },
      ];
      await uc.execute(groups);

      expect(gate.askUser).toHaveBeenCalled();
    });
  });

  describe("Gap: runSlice sliceSkipFlag", () => {
    it("short-circuits when sliceSkipFlag is set", async () => {
      const ports = makePorts();
      const config = makeConfig({ verifySkill: "test" });
      const { uc, git, spawner } = makeUc(ports, config);
      git.captureRef.mockResolvedValue("sha1"); // different from reviewBase
      // Verify passes
      const verifyAgent = makeAgent({
        assistantText: "### VERIFY_RESULT\n**Status:** PASS\n",
      });
      spawner.spawn.mockReturnValue(verifyAgent);
      uc.tddAgent = makeAgent();
      uc.reviewAgent = makeAgent();
      uc.sliceSkipFlag = true;

      const result = await uc.runSlice(makeSlice(), "sha0", makeResult(), "sha0");

      expect(result.skipped).toBe(true);
    });
  });

  describe("Gap: verify retry decision", () => {
    it("returns true when operator chooses retry after double failure", async () => {
      const ports = makePorts();
      const { uc, spawner, gate } = makeUc(ports);
      const verifyAgent = makeAgent({
        assistantText: "### VERIFY_RESULT\n**Status:** FAIL\n",
      });
      spawner.spawn.mockReturnValue(verifyAgent);
      uc.tddAgent = makeAgent();
      uc.phase = { kind: "Verifying", sliceNumber: 1 };
      gate.verifyFailed.mockResolvedValue({ kind: "retry" as const });

      const result = await uc.verify(makeSlice(), "sha0");

      expect(result).toBe(true);
      expect(gate.verifyFailed).toHaveBeenCalled();
    });
  });

  describe("Gap: finalPasses agent failure", () => {
    it("skips fix when final agent exits with non-zero code", async () => {
      const ports = makePorts();
      const { uc, git, spawner, prompts } = makeUc(ports);
      git.hasChanges.mockResolvedValue(true);
      prompts.finalPasses.mockReturnValue([
        { name: "Type check", prompt: "check" },
      ]);
      const finalAgent = makeAgent({ exitCode: 1, assistantText: "crash" });
      spawner.spawn.mockReturnValue(finalAgent);
      const tddAgent = makeAgent();
      uc.tddAgent = tddAgent;

      await uc.finalPasses("sha0");

      expect(tddAgent.send).not.toHaveBeenCalled();
    });
  });

  describe("Gap: completenessCheck SLICE_COMPLETE", () => {
    it("exits early when agent returns SLICE_COMPLETE", async () => {
      const ports = makePorts();
      const { uc, git, spawner } = makeUc(ports);
      git.hasChanges.mockResolvedValue(true);
      const checkAgent = makeAgent({ assistantText: "All good. SLICE_COMPLETE" });
      spawner.spawn.mockReturnValue(checkAgent);
      const tddAgent = makeAgent();
      uc.tddAgent = tddAgent;

      await uc.completenessCheck(makeSlice(), "sha0");

      expect(checkAgent.kill).toHaveBeenCalled();
      expect(tddAgent.send).not.toHaveBeenCalled();
    });
  });

  describe("Gap: resume with session IDs", () => {
    it("skips rules reminder and sets isFirst=false when resuming", async () => {
      const ports = makePorts();
      const config = makeConfig({
        planDisabled: true,
        gapDisabled: true,
        verifySkill: null,
        reviewSkill: null,
      });
      ports.persistence.load.mockResolvedValue({
        tddSessionId: "existing-tdd",
        reviewSessionId: "existing-review",
      });
      const { uc, spawner } = makeUc(ports, config);
      const tddAgent = makeAgent();
      const reviewAgent = makeAgent();
      spawner.spawn
        .mockReturnValueOnce(tddAgent)
        .mockReturnValueOnce(reviewAgent)
        .mockReturnValue(makeAgent());

      const groups: Group[] = [
        { name: "G1", slices: [makeSlice({ number: 1 })] },
      ];
      await uc.execute(groups);

      // Rules reminders should NOT have been sent (resuming)
      // sendQuiet may be called for slice summary, but not for rules
      const tddQuietCalls = (tddAgent.sendQuiet as ReturnType<typeof vi.fn>).mock.calls;
      const hasRulesCall = tddQuietCalls.some(
        (c: string[]) => c[0]?.includes("rules reminder"),
      );
      expect(hasRulesCall).toBe(false);
      expect(reviewAgent.sendQuiet).not.toHaveBeenCalled();
      // tddIsFirst should be false (resuming session)
      expect(uc.tddIsFirst).toBe(false);
    });
  });

  describe("Gap: entire group skip", () => {
    it("skips entire group when all its slices are already completed", async () => {
      const ports = makePorts();
      const config = makeConfig({
        planDisabled: true,
        gapDisabled: true,
        verifySkill: null,
        reviewSkill: null,
      });
      ports.persistence.load.mockResolvedValue({ lastCompletedSlice: 2 });
      const { uc, spawner, progressSink } = makeUc(ports, config);
      const tddAgent = makeAgent();
      const reviewAgent = makeAgent();
      spawner.spawn
        .mockReturnValueOnce(tddAgent)
        .mockReturnValueOnce(reviewAgent)
        .mockReturnValue(makeAgent());

      const groups: Group[] = [
        { name: "G1", slices: [makeSlice({ number: 1 }), makeSlice({ number: 2 })] },
        { name: "G2", slices: [makeSlice({ number: 3 })] },
      ];
      await uc.execute(groups);

      // G1 slices should be skipped entirely — TDD send only for G2 slice 3
      // The tddAgent.send calls: 1 for slice 3 only
      expect(tddAgent.send).toHaveBeenCalledTimes(1);
      // Progress updated with completedSlices for G1
      expect(progressSink.updateProgress).toHaveBeenCalledWith(
        expect.objectContaining({ completedSlices: 2 }),
      );
    });
  });

  describe("Gap: gapAnalysis review skipped when no changes after fix", () => {
    it("skips review when TDD fix produces no changes", async () => {
      const ports = makePorts();
      const config = makeConfig({ gapDisabled: false, reviewSkill: "test" });
      const { uc, git, spawner } = makeUc(ports, config);
      const gapAgent = makeAgent({ assistantText: "Missing tests for X" });
      spawner.spawn.mockReturnValue(gapAgent);
      const tddAgent = makeAgent();
      uc.tddAgent = tddAgent;
      const reviewAgent = makeAgent({ assistantText: "REVIEW_CLEAN" });
      uc.reviewAgent = reviewAgent;

      // hasChanges: true for initial gap check, false for post-fix check
      git.hasChanges
        .mockResolvedValueOnce(true)  // gap entry check
        .mockResolvedValueOnce(false); // post-fix check — no changes
      git.captureRef.mockResolvedValue("sha1");

      await uc.gapAnalysis(
        { name: "G1", slices: [makeSlice()] },
        "sha0",
      );

      expect(tddAgent.send).toHaveBeenCalled();
      expect(reviewAgent.send).not.toHaveBeenCalled();
    });
  });

  describe("Gap: finalPasses review skipped when no changes after fix", () => {
    it("skips review when fix produces no changes", async () => {
      const ports = makePorts();
      const config = makeConfig({ reviewSkill: "test" });
      const { uc, git, spawner, prompts } = makeUc(ports, config);
      prompts.finalPasses.mockReturnValue([
        { name: "Type check", prompt: "check" },
      ]);
      const finalAgent = makeAgent({ assistantText: "Found: any cast" });
      spawner.spawn.mockReturnValue(finalAgent);
      const tddAgent = makeAgent();
      uc.tddAgent = tddAgent;
      const reviewAgent = makeAgent({ assistantText: "REVIEW_CLEAN" });
      uc.reviewAgent = reviewAgent;

      // hasChanges: true for entry, false for post-fix
      git.hasChanges
        .mockResolvedValueOnce(true)  // finalPasses entry check
        .mockResolvedValueOnce(false); // post-fix check — no changes
      git.captureRef.mockResolvedValue("sha1");

      await uc.finalPasses("sha0");

      expect(tddAgent.send).toHaveBeenCalled();
      expect(reviewAgent.send).not.toHaveBeenCalled();
    });
  });

  describe("onReady callback", () => {
    it("calls onReady with session IDs after agent spawn", async () => {
      const { uc, spawner } = makeUc();
      const tddAgent = makeAgent();
      const reviewAgent = makeAgent();
      (tddAgent as any).sessionId = "tdd-sess-123";
      (reviewAgent as any).sessionId = "rev-sess-456";
      spawner.spawn
        .mockReturnValueOnce(tddAgent)
        .mockReturnValueOnce(reviewAgent);

      const onReady = vi.fn();
      const group: Group = {
        name: "G",
        slices: [makeSlice()],
      };

      await uc.execute([group], { onReady });

      expect(onReady).toHaveBeenCalledOnce();
      expect(onReady).toHaveBeenCalledWith({
        tddSessionId: "tdd-sess-123",
        reviewSessionId: "rev-sess-456",
      });
    });

    it("works without onReady (optional)", async () => {
      const { uc } = makeUc();
      const group: Group = {
        name: "G",
        slices: [makeSlice()],
      };

      // Should not throw when no onReady provided
      await expect(uc.execute([group])).resolves.toBeUndefined();
    });
  });

  describe("dispose", () => {
    it("kills all agents and tears down progressSink", async () => {
      const { uc, spawner, progressSink } = makeUc();
      const tddAgent = makeAgent();
      const reviewAgent = makeAgent();
      const verifyAgent = makeAgent();
      spawner.spawn
        .mockReturnValueOnce(tddAgent)
        .mockReturnValueOnce(reviewAgent)
        .mockReturnValueOnce(verifyAgent);

      // Execute to spawn agents
      const group: Group = {
        name: "G",
        slices: [makeSlice()],
      };
      await uc.execute([group]);

      // Manually set verifyAgent (it's only spawned on-demand during verify)
      uc.verifyAgent = verifyAgent;

      uc.dispose();

      expect(tddAgent.kill).toHaveBeenCalled();
      expect(reviewAgent.kill).toHaveBeenCalled();
      expect(verifyAgent.kill).toHaveBeenCalled();
      expect(progressSink.teardown).toHaveBeenCalled();
    });

    it("is safe to call before execute (no agents spawned)", () => {
      const { uc, progressSink } = makeUc();
      expect(() => uc.dispose()).not.toThrow();
      expect(progressSink.teardown).toHaveBeenCalled();
    });
  });

  describe("Phase transitions", () => {
    it("initial phase is Idle", () => {
      const { uc } = makeUc();
      expect(uc.phase).toEqual({ kind: "Idle" });
    });

    it("plan disabled: phase reaches Reviewing after verify+completeness fast-forward", async () => {
      const ports = makePorts();
      const config = makeConfig({
        planDisabled: true,
        gapDisabled: true,
        verifySkill: null,
        reviewSkill: null,
      });
      const { uc, spawner } = makeUc(ports, config);
      const tddAgent = makeAgent();
      const reviewAgent = makeAgent();
      spawner.spawn
        .mockReturnValueOnce(tddAgent)
        .mockReturnValueOnce(reviewAgent);

      let phaseAtDiffCheck: unknown;
      ports.git.measureDiff.mockImplementation(async () => {
        phaseAtDiffCheck = { ...uc.phase };
        return { added: 0, removed: 0, total: 0 };
      });

      const groups: Group[] = [
        { name: "G1", slices: [makeSlice({ number: 1 })] },
      ];
      await uc.execute(groups);

      expect(phaseAtDiffCheck).toEqual({ kind: "Reviewing", sliceNumber: 1, cycle: 1 });
    });

    it("runSlice: phase is Reviewing when review starts", async () => {
      const ports = makePorts();
      const config = makeConfig({
        planDisabled: true,
        gapDisabled: true,
        verifySkill: "test",
        reviewSkill: "test",
        reviewThreshold: 0,
      });
      const { uc, spawner, git } = makeUc(ports, config);
      git.captureRef.mockResolvedValue("sha1");
      git.hasChanges.mockResolvedValue(true);
      git.measureDiff.mockResolvedValue({ added: 10, removed: 0, total: 10 });

      const verifyAgent = makeAgent({
        assistantText: "### VERIFY_RESULT\n**Status:** PASS\n",
      });
      const reviewAgent = makeAgent({ assistantText: "REVIEW_CLEAN" });
      const tddAgent = makeAgent();

      let phaseAtReview: unknown;
      (reviewAgent.send as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        phaseAtReview = { ...uc.phase };
        return makeResult({ assistantText: "REVIEW_CLEAN" });
      });

      spawner.spawn.mockImplementation((role: string) => {
        if (role === "tdd") return tddAgent;
        if (role === "review") return reviewAgent;
        if (role === "verify") return verifyAgent;
        return makeAgent();
      });

      const groups: Group[] = [
        { name: "G1", slices: [makeSlice({ number: 1 })] },
      ];
      await uc.execute(groups);

      expect(phaseAtReview).toEqual({
        kind: "Reviewing",
        sliceNumber: 1,
        cycle: 1,
      });
    });

    it("runSlice with review: phase is Idle after ReviewClean", async () => {
      const ports = makePorts();
      const config = makeConfig({
        planDisabled: true,
        gapDisabled: true,
        verifySkill: "test",
        reviewSkill: "test",
        reviewThreshold: 0,
      });
      const { uc, spawner, git } = makeUc(ports, config);
      git.captureRef.mockResolvedValue("sha1");
      // true for review hasChanges, false for finalPasses hasChanges
      git.hasChanges
        .mockResolvedValueOnce(true)  // completenessCheck
        .mockResolvedValueOnce(true)  // reviewFix
        .mockResolvedValueOnce(false); // finalPasses
      git.measureDiff.mockResolvedValue({ added: 10, removed: 0, total: 10 });

      const verifyAgent = makeAgent({
        assistantText: "### VERIFY_RESULT\n**Status:** PASS\n",
      });
      const reviewAgent = makeAgent({ assistantText: "REVIEW_CLEAN" });
      const tddAgent = makeAgent();

      spawner.spawn.mockImplementation((role: string) => {
        if (role === "tdd") return tddAgent;
        if (role === "review") return reviewAgent;
        if (role === "verify") return verifyAgent;
        return makeAgent();
      });

      const groups: Group[] = [
        { name: "G1", slices: [makeSlice({ number: 1 })] },
      ];
      await uc.execute(groups);

      expect(uc.phase).toEqual({ kind: "Idle" });
    });

    it("runSlice without review: phase is Idle via SliceComplete", async () => {
      const ports = makePorts();
      const config = makeConfig({
        planDisabled: true,
        gapDisabled: true,
        verifySkill: null,
        reviewSkill: null,
        reviewThreshold: 100,
      });
      const { uc, spawner } = makeUc(ports, config);
      spawner.spawn.mockReturnValue(makeAgent());

      const groups: Group[] = [
        { name: "G1", slices: [makeSlice({ number: 1 })] },
      ];
      await uc.execute(groups);

      expect(uc.phase).toEqual({ kind: "Idle" });
    });

    it("verify failure transitions through VerifyFailed → Executing → Verifying", async () => {
      const ports = makePorts();
      const config = makeConfig({
        planDisabled: true,
        gapDisabled: true,
        verifySkill: "test",
        reviewSkill: null,
      });
      const { uc, spawner, git } = makeUc(ports, config);
      git.captureRef.mockResolvedValue("sha1");
      git.hasChanges.mockResolvedValue(false);
      git.measureDiff.mockResolvedValue({ added: 0, removed: 0, total: 0 });

      // Verify fails first, passes on re-verify
      const verifyAgent = makeAgent();
      let verifyCallCount = 0;
      (verifyAgent.send as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        verifyCallCount++;
        if (verifyCallCount === 1) {
          return makeResult({
            assistantText: "### VERIFY_RESULT\n**Status:** FAIL\n**New failures:**\n- test broke\n",
          });
        }
        return makeResult({
          assistantText: "### VERIFY_RESULT\n**Status:** PASS\n",
        });
      });

      const tddAgent = makeAgent();
      let phaseAtTddFix: unknown;
      (tddAgent.send as ReturnType<typeof vi.fn>).mockImplementation(async (prompt: string) => {
        if (prompt.includes("Verification found")) {
          phaseAtTddFix = { ...uc.phase };
        }
        return makeResult();
      });

      spawner.spawn.mockImplementation((role: string) => {
        if (role === "tdd") return tddAgent;
        if (role === "review") return makeAgent();
        if (role === "verify") return verifyAgent;
        return makeAgent();
      });

      const groups: Group[] = [
        { name: "G1", slices: [makeSlice({ number: 1 })] },
      ];
      await uc.execute(groups);

      expect(phaseAtTddFix).toEqual({ kind: "Executing", sliceNumber: 1, planText: null });
      expect(uc.phase).toEqual({ kind: "Idle" });
    });

    it("gapAnalysis: phase transitions through GapAnalysis when gaps run", async () => {
      const ports = makePorts();
      const config = makeConfig({
        planDisabled: true,
        gapDisabled: false,
        verifySkill: null,
        reviewSkill: null,
      });
      const { uc, spawner, git } = makeUc(ports, config);
      git.hasChanges
        .mockResolvedValueOnce(false)  // completenessCheck
        .mockResolvedValueOnce(true)   // gapAnalysis
        .mockResolvedValueOnce(false); // finalPasses

      let phaseAtGapSend: unknown;
      const gapAgent = makeAgent();
      (gapAgent.send as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        phaseAtGapSend = { ...uc.phase };
        return makeResult({ assistantText: "NO_GAPS_FOUND" });
      });

      spawner.spawn.mockImplementation((role: string) => {
        if (role === "gap") return gapAgent;
        return makeAgent();
      });

      const groups: Group[] = [
        { name: "G1", slices: [makeSlice({ number: 1 })] },
      ];
      await uc.execute(groups);

      expect(phaseAtGapSend).toEqual({ kind: "GapAnalysis", groupName: "G1" });
      expect(uc.phase).toEqual({ kind: "Idle" });
    });

    it("finalPasses: phase transitions to Complete", async () => {
      const ports = makePorts();
      const config = makeConfig({
        planDisabled: true,
        gapDisabled: true,
        verifySkill: null,
        reviewSkill: null,
      });
      const { uc, spawner, git, prompts } = makeUc(ports, config);
      git.hasChanges.mockResolvedValue(true);
      prompts.finalPasses.mockReturnValue([
        { name: "Type check", prompt: "check types" },
      ]);
      const finalAgent = makeAgent({ assistantText: "NO_ISSUES_FOUND" });
      spawner.spawn.mockImplementation((role: string) => {
        if (role === "final") return finalAgent;
        return makeAgent();
      });

      const groups: Group[] = [
        { name: "G1", slices: [makeSlice({ number: 1 })] },
      ];
      await uc.execute(groups);

      expect(uc.phase).toEqual({ kind: "Complete" });
    });

    it("finalPasses skipped: phase stays Idle", async () => {
      const ports = makePorts();
      const config = makeConfig({
        planDisabled: true,
        gapDisabled: true,
        verifySkill: null,
        reviewSkill: null,
      });
      const { uc, spawner, git } = makeUc(ports, config);
      git.hasChanges.mockResolvedValue(false);
      spawner.spawn.mockReturnValue(makeAgent());

      const groups: Group[] = [
        { name: "G1", slices: [makeSlice({ number: 1 })] },
      ];
      await uc.execute(groups);

      expect(uc.phase).toEqual({ kind: "Idle" });
    });

    it("skipped slice resets phase to Idle for next slice", async () => {
      const ports = makePorts();
      const config = makeConfig({
        planDisabled: true,
        gapDisabled: true,
        verifySkill: null,
        reviewSkill: null,
      });
      const { uc, spawner } = makeUc(ports, config);

      let sendCount = 0;
      const tddAgent = makeAgent();
      (tddAgent.send as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        sendCount++;
        if (sendCount === 1) {
          // During first slice TDD, trigger skip
          uc.sliceSkipFlag = true;
        }
        return makeResult();
      });
      spawner.spawn.mockImplementation((role: string) => {
        if (role === "tdd") return tddAgent;
        return makeAgent();
      });

      const groups: Group[] = [
        {
          name: "G1",
          slices: [makeSlice({ number: 1 }), makeSlice({ number: 2 })],
        },
      ];

      // Should not throw — phase resets to Idle between slices
      await expect(uc.execute(groups)).resolves.toBeUndefined();
      // Second slice should have been processed
      expect(sendCount).toBeGreaterThanOrEqual(2);
    });

    it("hard interrupt during execute phase does not crash the pipeline", async () => {
      const ports = makePorts();
      const config = makeConfig({
        planDisabled: false,
        gapDisabled: true,
        verifySkill: null,
        reviewSkill: null,
        auto: true,
      });
      const { uc, spawner, git } = makeUc(ports, config);
      git.hasChanges.mockResolvedValue(false);
      git.measureDiff.mockResolvedValue({ added: 0, removed: 0, total: 0 });

      const tddAgent = makeAgent();
      const reviewAgent = makeAgent();
      const planAgent = makeAgent({ planText: "the plan" });

      // After TDD execute send, trigger hard interrupt
      let tddSendCount = 0;
      (tddAgent.send as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        tddSendCount++;
        if (tddSendCount === 1) {
          // First TDD send is the execute — simulate interrupt
          uc.hardInterruptPending = "operator guidance";
        }
        return makeResult();
      });

      // After respawnTdd, the spawner returns a fresh agent
      const freshTddAgent = makeAgent();
      spawner.spawn.mockImplementation((role: string) => {
        if (role === "tdd" && tddSendCount === 0) return tddAgent;
        if (role === "tdd") return freshTddAgent;
        if (role === "review") return reviewAgent;
        return planAgent;
      });

      const groups: Group[] = [
        { name: "G1", slices: [makeSlice({ number: 1 })] },
      ];

      // Before fix: threw "Illegal transition: Executing + VerifyPassed"
      await expect(uc.execute(groups)).resolves.toBeUndefined();
      expect(uc.phase).toEqual({ kind: "Idle" });
    });

    it("hard interrupt during plan phase does not crash the pipeline", async () => {
      const ports = makePorts();
      const config = makeConfig({
        planDisabled: false,
        gapDisabled: true,
        verifySkill: null,
        reviewSkill: null,
        auto: true,
      });
      const { uc, spawner, git } = makeUc(ports, config);
      git.hasChanges.mockResolvedValue(false);
      git.measureDiff.mockResolvedValue({ added: 0, removed: 0, total: 0 });

      const tddAgent = makeAgent();
      const reviewAgent = makeAgent();
      const planAgent = makeAgent();

      // Plan agent send triggers hard interrupt (plan phase)
      (planAgent.send as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        uc.hardInterruptPending = "operator guidance";
        return makeResult({ planText: "the plan" });
      });

      spawner.spawn.mockImplementation((role: string) => {
        if (role === "tdd") return tddAgent;
        if (role === "review") return reviewAgent;
        return planAgent;
      });

      const groups: Group[] = [
        { name: "G1", slices: [makeSlice({ number: 1 })] },
      ];

      // Before fix: plan-phase interrupt left phase at Idle, then VerifyPassed threw
      await expect(uc.execute(groups)).resolves.toBeUndefined();
      expect(uc.phase).toEqual({ kind: "Idle" });
    });

    it("gapAnalysis skipped: no phase error", async () => {
      const ports = makePorts();
      const config = makeConfig({
        planDisabled: true,
        gapDisabled: true,
        verifySkill: null,
        reviewSkill: null,
      });
      const { uc, spawner } = makeUc(ports, config);
      spawner.spawn.mockReturnValue(makeAgent());

      const groups: Group[] = [
        { name: "G1", slices: [makeSlice({ number: 1 })] },
      ];

      await expect(uc.execute(groups)).resolves.toBeUndefined();
    });

    it("gate rejection transitions through PlanRejected back to Planning", async () => {
      const ports = makePorts();
      const config = makeConfig({
        planDisabled: false,
        gapDisabled: true,
        maxReplans: 2,
        verifySkill: null,
        reviewSkill: null,
      });
      const { uc, spawner, gate } = makeUc(ports, config);
      const tddAgent = makeAgent();
      const reviewAgent = makeAgent();
      const planAgent = makeAgent({ planText: "the plan" });

      spawner.spawn.mockImplementation((role: string) => {
        if (role === "tdd") return tddAgent;
        if (role === "review") return reviewAgent;
        return planAgent;
      });

      let phaseAtSecondPlan: unknown;
      let planSendCount = 0;
      (planAgent.send as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        planSendCount++;
        if (planSendCount === 2) {
          phaseAtSecondPlan = { ...uc.phase };
        }
        return makeResult({ planText: "the plan" });
      });

      gate.confirmPlan
        .mockResolvedValueOnce({ kind: "reject" as const })
        .mockResolvedValueOnce({ kind: "accept" as const });

      const groups: Group[] = [
        { name: "G1", slices: [makeSlice({ number: 1 })] },
      ];
      await uc.execute(groups);

      expect(phaseAtSecondPlan).toEqual({
        kind: "Planning",
        sliceNumber: 1,
        attempt: 2,
      });
    });

    it("plan enabled: phase is Gated when gate.confirmPlan is called", async () => {
      const ports = makePorts();
      const config = makeConfig({
        planDisabled: false,
        gapDisabled: true,
        verifySkill: null,
        reviewSkill: null,
      });
      const { uc, spawner, gate } = makeUc(ports, config);
      const tddAgent = makeAgent();
      const reviewAgent = makeAgent();
      const planAgent = makeAgent({ planText: "the plan" });

      spawner.spawn.mockImplementation((role: string) => {
        if (role === "tdd") return tddAgent;
        if (role === "review") return reviewAgent;
        return planAgent;
      });

      let phaseAtGate: unknown;
      gate.confirmPlan.mockImplementation(async () => {
        phaseAtGate = { ...uc.phase };
        return { kind: "accept" as const };
      });

      const groups: Group[] = [
        { name: "G1", slices: [makeSlice({ number: 1 })] },
      ];
      await uc.execute(groups);

      expect(phaseAtGate).toEqual({
        kind: "Gated",
        sliceNumber: 1,
        planText: "the plan",
        attempt: 1,
      });
    });
    it("review issues fires ReviewIssues when review finds problems", async () => {
      const ports = makePorts();
      const config = makeConfig({
        planDisabled: true,
        gapDisabled: true,
        verifySkill: null,
        reviewSkill: "test",
        reviewThreshold: 0,
        maxReviewCycles: 2,
      });
      const { uc, spawner, git } = makeUc(ports, config);
      git.captureRef.mockResolvedValue("sha1");
      git.hasChanges.mockResolvedValue(true);
      git.measureDiff.mockResolvedValue({ added: 10, removed: 0, total: 10 });

      const tddAgent = makeAgent();
      const reviewAgent = makeAgent();
      let reviewSendCount = 0;
      let phaseAtSecondReview: unknown;
      (reviewAgent.send as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        reviewSendCount++;
        if (reviewSendCount === 1) {
          return makeResult({ assistantText: "found issues: fix X" });
        }
        if (reviewSendCount === 2) {
          phaseAtSecondReview = { ...uc.phase };
        }
        return makeResult({ assistantText: "REVIEW_CLEAN" });
      });

      spawner.spawn.mockImplementation((role: string) => {
        if (role === "tdd") return tddAgent;
        if (role === "review") return reviewAgent;
        return makeAgent();
      });

      const groups: Group[] = [
        { name: "G1", slices: [makeSlice({ number: 1 })] },
      ];
      await uc.execute(groups);

      // After first review found issues, ReviewIssues should have fired,
      // incrementing the cycle counter
      expect(phaseAtSecondReview).toEqual({
        kind: "Reviewing",
        sliceNumber: 1,
        cycle: 2,
      });
    });

    it("completeness issues fires CompletenessIssues then loops back through Executing", async () => {
      const ports = makePorts();
      const config = makeConfig({
        planDisabled: true,
        gapDisabled: true,
        verifySkill: null,
        reviewSkill: null,
      });
      const { uc, spawner, git } = makeUc(ports, config);
      // hasChanges: true for completenessCheck entry, false for finalPasses
      git.hasChanges
        .mockResolvedValueOnce(true)   // completenessCheck entry
        .mockResolvedValueOnce(false); // finalPasses
      git.measureDiff.mockResolvedValue({ added: 0, removed: 0, total: 0 });

      const tddAgent = makeAgent();
      let tddSendCount = 0;
      let phaseAtCompletnessFix: unknown;
      (tddAgent.send as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        tddSendCount++;
        // First send is planThenExecute (plan disabled), second is completeness fix
        if (tddSendCount === 2) {
          phaseAtCompletnessFix = { ...uc.phase };
        }
        return makeResult();
      });

      const completenessAgent = makeAgent({
        assistantText: "Missing: feature X not implemented",
      });
      spawner.spawn.mockImplementation((role: string) => {
        if (role === "tdd") return tddAgent;
        if (role === "review") return makeAgent();
        if (role === "completeness") return completenessAgent;
        return makeAgent();
      });

      const groups: Group[] = [
        { name: "G1", slices: [makeSlice({ number: 1 })] },
      ];
      await uc.execute(groups);

      expect(phaseAtCompletnessFix).toEqual({
        kind: "Executing",
        sliceNumber: 1,
        planText: null,
      });
    });
  });

  describe("advanceState wiring", () => {
    it("persistence.save reflects agentSpawned session IDs", async () => {
      const ports = makePorts();
      const config = makeConfig({
        planDisabled: true,
        gapDisabled: true,
        verifySkill: null,
        reviewSkill: null,
      });
      const { uc, spawner, persistence } = makeUc(ports, config);
      const tddAgent = { ...makeAgent(), sessionId: "tdd-111" } as unknown as AgentHandle;
      const reviewAgent = { ...makeAgent(), sessionId: "rev-222" } as unknown as AgentHandle;
      spawner.spawn
        .mockReturnValueOnce(tddAgent)
        .mockReturnValueOnce(reviewAgent)
        .mockReturnValue(makeAgent());

      const groups: Group[] = [
        { name: "G1", slices: [makeSlice({ number: 1 })] },
      ];
      await uc.execute(groups);

      expect(persistence.save).toHaveBeenCalledWith(
        expect.objectContaining({ tddSessionId: "tdd-111", reviewSessionId: "rev-222" }),
      );
    });

    it("persistence.save reflects sliceDone with lastCompletedSlice and lastSliceImplemented", async () => {
      const ports = makePorts();
      const config = makeConfig({
        planDisabled: true,
        gapDisabled: true,
        verifySkill: null,
        reviewSkill: null,
      });
      const { uc, spawner, persistence } = makeUc(ports, config);
      spawner.spawn.mockReturnValue(makeAgent());

      const groups: Group[] = [
        { name: "G1", slices: [makeSlice({ number: 5 })] },
      ];
      await uc.execute(groups);

      // sliceDone sets both lastCompletedSlice and lastSliceImplemented
      expect(persistence.save).toHaveBeenCalledWith(
        expect.objectContaining({ lastCompletedSlice: 5, lastSliceImplemented: 5 }),
      );
    });

    it("persistence.save reflects sliceImplemented with reviewBaseSha", async () => {
      const ports = makePorts();
      const config = makeConfig({
        planDisabled: true,
        gapDisabled: true,
        verifySkill: "test",
        reviewSkill: null,
      });
      const { uc, spawner, persistence, git } = makeUc(ports, config);
      // Different SHAs so isAlreadyImplemented returns false
      git.captureRef
        .mockResolvedValueOnce("run-base")   // runBaseSha
        .mockResolvedValueOnce("group-base") // groupBaseSha
        .mockResolvedValueOnce("verify-base") // verifyBaseSha
        .mockResolvedValueOnce("head-after"); // headAfterTdd (different from reviewBase)
      git.hasChanges.mockResolvedValue(false);
      git.measureDiff.mockResolvedValue({ added: 0, removed: 0, total: 0 });

      // Verify passes
      const verifyAgent = makeAgent({
        assistantText: "### VERIFY_RESULT\n**Status:** PASS\n",
      });
      spawner.spawn.mockImplementation((role: string) => {
        if (role === "verify") return verifyAgent;
        return makeAgent();
      });

      const groups: Group[] = [
        { name: "G1", slices: [makeSlice({ number: 3 })] },
      ];
      await uc.execute(groups);

      // sliceImplemented sets lastSliceImplemented + reviewBaseSha
      expect(persistence.save).toHaveBeenCalledWith(
        expect.objectContaining({ lastSliceImplemented: 3, reviewBaseSha: "verify-base" }),
      );
    });
  });

  describe("ProgressSink gap coverage", () => {
    it("registerInterrupts onGuide callback injects text into tddAgent", async () => {
      const ports = makePorts();
      const config = makeConfig({ planDisabled: true, verifySkill: null, reviewSkill: null, gapDisabled: true });

      // Capture the onGuide callback when registerInterrupts is called
      let capturedGuide: ((text: string) => void) | null = null;
      ports.progressSink.registerInterrupts.mockReturnValue({
        onGuide: vi.fn((cb: (text: string) => void) => { capturedGuide = cb; }),
        onInterrupt: vi.fn(),
      });

      const { uc, spawner } = makeUc(ports, config);
      const tddAgent = makeAgent();
      const reviewAgent = makeAgent();
      spawner.spawn.mockReturnValueOnce(tddAgent).mockReturnValueOnce(reviewAgent);

      const group: Group = { name: "G", slices: [makeSlice()] };
      const execPromise = uc.execute([group]);

      // Wait for execute to wire up the callbacks
      await execPromise;

      // Simulate guide text — callback should inject into tddAgent
      expect(capturedGuide).not.toBeNull();
      capturedGuide!("focus on edge cases");
      expect(tddAgent.inject).toHaveBeenCalledWith("focus on edge cases");
    });

    it("registerInterrupts onInterrupt callback kills tddAgent and sets hardInterruptPending", async () => {
      const ports = makePorts();
      const config = makeConfig({ planDisabled: true, verifySkill: null, reviewSkill: null, gapDisabled: true });

      let capturedInterrupt: ((text: string) => void) | null = null;
      ports.progressSink.registerInterrupts.mockReturnValue({
        onGuide: vi.fn(),
        onInterrupt: vi.fn((cb: (text: string) => void) => { capturedInterrupt = cb; }),
      });

      const { uc, spawner } = makeUc(ports, config);
      const tddAgent = makeAgent();
      const reviewAgent = makeAgent();
      spawner.spawn.mockReturnValueOnce(tddAgent).mockReturnValueOnce(reviewAgent);

      const group: Group = { name: "G", slices: [makeSlice()] };
      await uc.execute([group]);

      expect(capturedInterrupt).not.toBeNull();
      capturedInterrupt!("stop and rethink");
      expect(uc.hardInterruptPending).toBe("stop and rethink");
      expect(tddAgent.kill).toHaveBeenCalled();
    });

    it("updateProgress is called with group metadata at group start", async () => {
      const ports = makePorts();
      const config = makeConfig({ planDisabled: true, verifySkill: null, reviewSkill: null, gapDisabled: true });
      const { uc, spawner, progressSink } = makeUc(ports, config);
      const tddAgent = makeAgent();
      const reviewAgent = makeAgent();
      spawner.spawn.mockReturnValueOnce(tddAgent).mockReturnValueOnce(reviewAgent);

      const group: Group = {
        name: "Domain",
        slices: [makeSlice({ number: 1 }), makeSlice({ number: 2 })],
      };
      await uc.execute([group]);

      expect(progressSink.updateProgress).toHaveBeenCalledWith(
        expect.objectContaining({ groupName: "Domain", groupSliceCount: 2, groupCompleted: 0 }),
      );
    });

    it("updateProgress is called with currentSlice at slice start", async () => {
      const ports = makePorts();
      const config = makeConfig({ planDisabled: true, verifySkill: null, reviewSkill: null, gapDisabled: true });
      const { uc, spawner, progressSink } = makeUc(ports, config);
      const tddAgent = makeAgent();
      const reviewAgent = makeAgent();
      spawner.spawn.mockReturnValueOnce(tddAgent).mockReturnValueOnce(reviewAgent);

      const group: Group = { name: "G", slices: [makeSlice({ number: 7 })] };
      await uc.execute([group]);

      expect(progressSink.updateProgress).toHaveBeenCalledWith(
        expect.objectContaining({ currentSlice: { number: 7 } }),
      );
    });

    it("updateProgress is called with VFY agent activity during verify", async () => {
      const ports = makePorts();
      const config = makeConfig({ verifySkill: "test" });
      const { uc, spawner, progressSink } = makeUc(ports, config);

      const verifyAgent = makeAgent({
        assistantText: "### VERIFY_RESULT\n**Status:** PASS\n",
      });
      spawner.spawn.mockReturnValue(verifyAgent);
      uc.tddAgent = makeAgent();
      uc.phase = { kind: "Verifying", sliceNumber: 1 };

      await uc.verify(makeSlice(), "sha0");

      expect(progressSink.updateProgress).toHaveBeenCalledWith(
        expect.objectContaining({ activeAgent: "VFY", activeAgentActivity: "verifying..." }),
      );
    });

    it("updateProgress is called with REV agent activity during reviewFix", async () => {
      const ports = makePorts();
      const config = makeConfig({ reviewSkill: "test", maxReviewCycles: 1 });
      const { uc, git, progressSink } = makeUc(ports, config);
      git.hasChanges.mockResolvedValue(true);

      const reviewAgent = makeAgent({ assistantText: "REVIEW_CLEAN" });
      uc.reviewAgent = reviewAgent;
      uc.tddAgent = makeAgent();

      await uc.reviewFix("content", "sha0");

      expect(progressSink.updateProgress).toHaveBeenCalledWith(
        expect.objectContaining({ activeAgent: "REV" }),
      );
    });

    it("updateProgress resets activeAgent after runSlice completes", async () => {
      const ports = makePorts();
      const config = makeConfig({ verifySkill: "test", reviewSkill: "test", reviewThreshold: 0 });
      const { uc, git, spawner, progressSink } = makeUc(ports, config);
      uc.phase = { kind: "Verifying", sliceNumber: 1 };
      git.captureRef.mockResolvedValue("sha1");
      git.hasChanges.mockResolvedValue(true);
      git.measureDiff.mockResolvedValue({ added: 30, removed: 20, total: 50 });

      const verifyAgent = makeAgent({
        assistantText: "### VERIFY_RESULT\n**Status:** PASS\n",
      });
      spawner.spawn.mockReturnValue(verifyAgent);

      const reviewAgent = makeAgent({ assistantText: "REVIEW_CLEAN" });
      uc.reviewAgent = reviewAgent;

      const tddAgent = makeAgent();
      uc.tddAgent = tddAgent;

      await uc.runSlice(makeSlice(), "sha0", makeResult({ assistantText: "implemented" }), "sha0");

      expect(progressSink.updateProgress).toHaveBeenCalledWith(
        expect.objectContaining({ activeAgent: undefined, activeAgentActivity: undefined }),
      );
    });
  });
});
