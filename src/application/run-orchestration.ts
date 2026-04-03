import type { AgentResult, AgentRole } from "#domain/agent-types.js";
import { detectApiError } from "#domain/api-errors.js";
import type { ApiError } from "#domain/api-errors.js";
import type { OrchestratorConfig, Provider } from "#domain/config.js";
import { CreditExhaustedError, IncompleteRunError } from "#domain/errors.js";
import type { Phase } from "#domain/phase.js";
import type { Group } from "#domain/plan.js";
import type { Slice } from "#domain/plan.js";
import { isCleanReview } from "#domain/review-check.js";
import { shouldReview } from "#domain/review.js";
import type {
  OrchestratorState,
  PersistedAgentSession,
  PersistedPhase,
  StateEvent,
} from "#domain/state.js";
import { advanceState } from "#domain/state.js";
import { isAlreadyImplemented } from "#domain/transition.js";
import { transition } from "#domain/transition.js";
import type { TriageResult } from "#domain/triage.js";
import { FULL_TRIAGE } from "#domain/triage.js";
import { isVerifyPassing, parseVerifyResult, type VerifyResult } from "#domain/verify.js";
import { buildTriagePrompt, parseTriageResult } from "#infrastructure/diff-triage.js";
import type { AgentSpawner, AgentHandle } from "./ports/agent-spawner.port.js";
import type { GitOps } from "./ports/git-ops.port.js";
import type { LogWriter } from "./ports/log-writer.port.js";
import type { OperatorGate } from "./ports/operator-gate.port.js";
import type { ProgressSink } from "./ports/progress-sink.port.js";
import type { FinalPass, PromptBuilder } from "./ports/prompt-builder.port.js";
import type { StatePersistence } from "./ports/state-persistence.port.js";

export type PlanThenExecuteResult = {
  readonly tddResult: AgentResult;
  readonly skipped: boolean;
  readonly hardInterrupt?: string;
  readonly replan?: boolean;
  readonly planText?: string;
};

type ExecutionUnit = {
  readonly kind: "slice" | "group" | "direct";
  readonly label: string;
  readonly content: string;
  readonly sliceNumber: number;
  readonly slices: readonly Slice[];
  readonly groupName: string;
};

export class RunOrchestration {
  static inject = [
    "agentSpawner",
    "statePersistence",
    "operatorGate",
    "gitOps",
    "promptBuilder",
    "config",
    "progressSink",
    "logWriter",
  ] as const;

  state: OrchestratorState = {};
  phase: Phase = { kind: "Idle" };
  tddAgent: AgentHandle | null = null;
  reviewAgent: AgentHandle | null = null;
  verifyAgent: AgentHandle | null = null;
  retryDelayMs = 5_000;
  usageProbeDelayMs = 60_000;
  usageProbeMaxDelayMs = 300_000;
  tddIsFirst = true;
  reviewIsFirst = true;
  sliceSkipFlag = false;
  quitRequested = false;
  hardInterruptPending: string | null = null;
  slicesCompleted = 0;
  currentDirectRequestContent: string | null = null;

  constructor(
    private readonly agents: AgentSpawner,
    private readonly persistence: StatePersistence,
    private readonly gate: OperatorGate,
    private readonly git: GitOps,
    private readonly prompts: PromptBuilder,
    private readonly config: OrchestratorConfig,
    private readonly progressSink: ProgressSink,
    private readonly logWriter: LogWriter,
  ) {}

  private sliceUnit(slice: Slice, groupName: string): ExecutionUnit {
    return {
      kind: "slice",
      label: `Slice ${slice.number}`,
      content: slice.content,
      sliceNumber: slice.number,
      slices: [slice],
      groupName,
    };
  }

  private groupedUnit(group: Group): ExecutionUnit {
    const representativeSliceNumber = group.slices[group.slices.length - 1]?.number ?? 0;
    const groupContent = group.slices
      .map(
        (slice) =>
          `### Slice ${slice.number}: ${slice.title}\n\n${slice.content}`,
      )
      .join("\n\n---\n\n");

    return {
      kind: "group",
      label: `Group ${group.name}`,
      content: groupContent,
      sliceNumber: representativeSliceNumber,
      slices: group.slices,
      groupName: group.name,
    };
  }

  private directUnit(requestContent: string, representativeSliceNumber: number): ExecutionUnit {
    return {
      kind: "direct",
      label: "Direct request",
      content: requestContent,
      sliceNumber: representativeSliceNumber,
      slices: [],
      groupName: "Direct",
    };
  }

  private failIncompleteExecutionUnit(unit: ExecutionUnit, reason: string): never {
    this.phase = { kind: "Idle" };
    this.sliceSkipFlag = false;
    throw new IncompleteRunError(`${unit.label} did not complete: ${reason}`);
  }

  private summaryPromptForUnit(unit: ExecutionUnit): string {
    if (unit.kind === "group") {
      return `Summarise what you just built for ${unit.label} in this format exactly:\n\n## What was built\n<1-2 sentences>\n\n## Key decisions\n<2-4 bullet points>\n\n## Files touched\n<bulleted list>\n\n## Test coverage\n<1-2 sentences>\n\nBe concrete and specific. No filler.`;
    }

    if (unit.kind === "direct") {
      return "Summarise what you just built for the direct request in this format exactly:\n\n## What was built\n<1-2 sentences>\n\n## Key decisions\n<2-4 bullet points>\n\n## Files touched\n<bulleted list>\n\n## Test coverage\n<1-2 sentences>\n\nBe concrete and specific. No filler.";
    }

    return `Summarise what you just built for Slice ${unit.sliceNumber} in this format exactly:\n\n## What was built\n<1-2 sentences>\n\n## Key decisions\n<2-4 bullet points>\n\n## Files touched\n<bulleted list>\n\n## Test coverage\n<1-2 sentences>\n\nBe concrete and specific. No filler.`;
  }

  private verifyPromptForUnit(
    unit: ExecutionUnit,
    verifyBaseSha: string,
    fixSummary?: string,
  ): string {
    if (unit.kind === "direct") {
      return this.prompts.withBrief(
        `Verify the changes since commit ${verifyBaseSha}. Context: TDD implementation of the direct request.\n\n${
          fixSummary ? `## Fix summary from the builder\n${fixSummary}\n\n` : ""
        }## Direct request\n${unit.content}\n\n## Instructions
1. Review the changed code and run the verification commands you judge necessary.
2. You MUST end with a short human summary followed by a machine-readable \`### VERIFY_JSON\` block in the exact format below.
3. Do not replace the structured block with prose. You may include prose before it, but the block is mandatory.

## Required output format

### VERIFY_JSON
\`\`\`json
{
  "status": "PASS|FAIL|PASS_WITH_WARNINGS",
  "checks": [
    { "check": "<command or check name>", "status": "PASS|FAIL|WARN|SKIPPED" }
  ],
  "sliceLocalFailures": ["<failure caused by the current execution unit>"],
  "outOfScopeFailures": ["<failure not owned by the current execution unit>"],
  "preExistingFailures": ["<failure that already existed before these changes>"],
  "runnerIssue": "<runner instability or hung process summary>" | null,
  "retryable": true,
  "summary": "<one concise summary sentence>"
}
\`\`\`

Rules:
- \`sliceLocalFailures\` are the ONLY failures the builder should be asked to fix.
- Put unrelated failures in \`outOfScopeFailures\`, not \`sliceLocalFailures\`.
- Put already-failing checks in \`preExistingFailures\`.
- Use \`runnerIssue\` for hung runners, crashed tooling, or unstable infrastructure rather than blaming the builder.
- If the direct request is clean, use PASS or PASS_WITH_WARNINGS and leave \`sliceLocalFailures\` empty.
- "No findings" prose alone is NOT sufficient; you must include the JSON block above.`,
      );
    }

    if (unit.kind === "group") {
      return this.prompts.groupedVerify(verifyBaseSha, unit.groupName, fixSummary);
    }

    return this.prompts.verify(verifyBaseSha, unit.sliceNumber, fixSummary);
  }

  private reviewPromptForUnit(
    unit: ExecutionUnit,
    reviewBaseSha: string,
    priorFindings?: string,
  ): string {
    if (unit.kind !== "direct") {
      return this.prompts.review(unit.content, reviewBaseSha, priorFindings);
    }

    return `Review the code changed since commit ${reviewBaseSha}. Judge the code on its own merits — correctness, types, structure — not just whether it matches a plan.

${priorFindings ? `## Prior review findings
Your previous review flagged these issues — verify each one was addressed. If any were ignored or only partially fixed, re-flag them:

${priorFindings}

## Review pass discipline
This is likely your final useful review pass for this direct request.
Re-check the prior findings carefully and only add a new issue if it is clearly material and was genuinely missed before.
Batch related issues into one finding when they share a root cause or would be fixed by the same change.
Do not pad the review with speculative, cosmetic, or low-value nits just to say something new.
Do not hold back a material issue for a later pass.

` : `## Review pass discipline
Assume you may only get one useful review pass for this direct request.
Surface the highest-signal issues now.
Batch related issues into one finding when they share a root cause or would be fixed by the same change.
Do not pad the review with speculative, cosmetic, or low-value nits.
Do not hold back a material issue for a later pass.

`}## What to look for
- Bugs: incorrect runtime behavior, off-by-one, swallowed errors, race conditions
- Type fidelity: runtime values disagreeing with declared types, \`any\`/\`unknown\` as value carriers
- Dead code: new exports with zero consumers introduced by the change
- Structural: duplicated logic, parallel state, mixed concerns introduced by the change
- Names: identifiers that no longer match their scope or purpose after the change
- Enum/value completeness: new variants not handled in all consumers
- Over-engineering: deps bags, wrapper types, or indirection layers that exist "for testability" but add complexity with no real benefit
- Test resilience: new tests that mock the system under test, tests that would pass even if the feature were removed, tests that assert mock call arguments instead of observable outcomes

## What NOT to flag
- Style, formatting, cosmetic preferences
- Test coverage gaps (separate pass handles this)
- Harmless redundancy that aids readability
- Threshold values tuned empirically
- Test style preferences

## Direct request
${unit.content}

If all changes are correct and well-structured, respond with exactly: REVIEW_CLEAN`;
  }

  private completenessPromptForUnit(unit: ExecutionUnit, baseSha: string): string {
    if (unit.kind === "direct") {
      return this.prompts.withBrief(
        `You are a completeness checker. A builder just implemented the direct request below as one bounded increment. Your job is to verify that EVERY stated requirement in the request was actually implemented — not whether the code is clean, but whether it does what was asked.

## Direct request
${unit.content}

## How to check

1. Run \`git diff --name-only ${baseSha}..HEAD\` to see what changed.
2. Read the changed files — the FULL files, not just diffs.
3. For EACH concrete requirement in the direct request above, check:
   - **Is it implemented?** Find the code that does it. Cite the file and line.
   - **Does it match the request's intent?** If the request says "filter by X" but the code "includes everything and also X", that is WRONG — the direct request is the authority.
   - **Is there a test?** Find a test that would fail if this requirement were removed.
4. Check ARCHITECTURAL requirements separately from functional ones:
   - If the request says "use function X" or "call Y from domain layer", verify the import exists and the function is actually called. Grep for it.
   - If the request says "phase transitions use transition()" or "state advances use advanceState()", those are HARD REQUIREMENTS — not suggestions. Code that manages state a different way is MISSING the requirement even if tests pass.
   - The request's specified approach IS the requirement. An equivalent alternative that the builder chose instead is a DIVERGENT finding.

## Output format

For each requirement, output one line:
- ✅ **<requirement>** — implemented at \`file:line\`, tested in \`test-file\`
- ❌ **<requirement>** — MISSING: <what's wrong or missing>
- ⚠️ **<requirement>** — DIVERGENT: <how it differs from the request's intent>

If everything is complete and matches the request, respond with exactly: DIRECT_COMPLETE

If anything is missing or divergent, list ALL issues. Do not stop at the first one.`,
      );
    }

    if (unit.kind === "group") {
      return this.prompts.groupedCompleteness(unit.content, baseSha, unit.groupName);
    }

    return this.prompts.completeness(unit.content, baseSha, unit.sliceNumber);
  }

  private gapPromptForRun(groupContent: string, groupBaseSha: string): string {
    if (this.currentDirectRequestContent === null) {
      return this.prompts.withBrief(this.prompts.gap(groupContent, groupBaseSha));
    }

    return this.prompts.withBrief(
      `You are a gap-finder for a direct-mode builder run. A bounded direct request has just been implemented and reviewed.

Your job is to find missing test coverage and unhandled edge cases — NOT code style, naming, or architecture.

Assume this may be the only useful gap pass for this direct request.
Report only the highest-signal gaps that are likely to allow a real regression, request mismatch, or unguarded reachable behavior to ship.
Batch related variants into one gap when a single representative test or small cluster of tests would cover them.
Do not drip-feed narrower versions of the same underlying issue across multiple passes.
Do not hold back a material finding for later, and do not invent marginal findings just to avoid saying NO_GAPS_FOUND.

## What to look for
- Untested edge cases and boundary conditions
- Reachable behaviors in the direct request with no regression coverage
- Empty inputs, null inputs, and off-by-one scenarios
- Integration paths inside the direct request that have no test coverage

## Direct request
${this.currentDirectRequestContent}

If you find gaps, list each one as:
- **Gap:** <what's missing>
- **Suggested test:** <one-line description of the test to add>

If everything is well covered, respond with exactly: NO_GAPS_FOUND`,
    );
  }

  private gapFixPrompt(groupContent: string, gapText: string): string {
    if (this.currentDirectRequestContent === null) {
      return this.prompts.tdd(
        groupContent,
        `A gap analysis found missing test coverage. Add the missing tests.\n\n## Gaps Found\n${gapText}\n\nAdd tests for each gap. Do NOT refactor or change existing code — only add tests.`,
      );
    }

    return `A gap analysis found missing test coverage for the direct request. Add the missing tests.

## Current direct request
${this.currentDirectRequestContent}

## Gaps Found
${gapText}

Add tests for each gap. Do NOT refactor or change existing code unless a test exposes a real defect in the direct request implementation.`;
  }

  private finalPassesForRun(runBaseSha: string): readonly FinalPass[] {
    const passes = this.prompts.finalPasses(runBaseSha);
    if (this.currentDirectRequestContent === null) {
      return passes;
    }

    return passes.map((pass) => {
      if (pass.name === "Plan completeness") {
        return {
          name: "Request completeness",
          prompt: `You are verifying that the implementation matches the direct request.

Verify the changes since commit ${runBaseSha} against the direct request below.

## Direct request
${this.currentDirectRequestContent}

For each requested behavior, verify:
1. Was it implemented?
2. Were the specified edge cases handled?
3. Is there a test for each specified behavior?

Report:
- **Missing:** requested behaviors with no implementation
- **Untested:** behaviors that exist but have no test coverage
- **Divergent:** implementations that differ from the request

If everything matches, respond with exactly: NO_ISSUES_FOUND`,
        };
      }

      return {
        name: pass.name,
        prompt: `${pass.prompt}\n\n## Direct request\n${this.currentDirectRequestContent}\n\nJudge findings against the direct request, not a plan slice, group, or generated plan artifact.`,
      };
    });
  }

  private finalFixPrompt(pass: FinalPass, findings: string): string {
    if (this.currentDirectRequestContent === null) {
      return this.prompts.tdd(
        this.config.planContent,
        `A final "${pass.name}" review found issues. Address them.\n\n## Findings\n${findings}`,
      );
    }

    return `A final "${pass.name}" review found issues in the direct request implementation. Address them.

## Current direct request
${this.currentDirectRequestContent}

## Findings
${findings}

Rules:
- Keep fixes scoped to this direct request.
- Do not reframe the work as a plan slice, group, or generated plan.
- Treat each concrete finding as an implementation obligation unless you can prove it is incorrect with code and passing tests.`;
  }

  private formatVerifyFailureSummary(result: VerifyResult): string {
    const parts = [result.summary];

    if (result.sliceLocalFailures.length > 0) {
      parts.push(`Slice-local failures:\n${result.sliceLocalFailures.join("\n")}`);
    }
    if (result.outOfScopeFailures.length > 0) {
      parts.push(`Out-of-scope failures:\n${result.outOfScopeFailures.join("\n")}`);
    }
    if (result.preExistingFailures.length > 0) {
      parts.push(`Pre-existing failures:\n${result.preExistingFailures.join("\n")}`);
    }
    if (result.runnerIssue) {
      parts.push(`Runner issue:\n${result.runnerIssue}`);
    }

    return parts.join("\n\n");
  }

  private async markExecutionUnitComplete(unit: ExecutionUnit): Promise<void> {
    if (unit.kind === "direct") {
      this.progressSink.updateProgress({ activeAgent: undefined, activeAgentActivity: undefined });
      return;
    }

    for (const slice of unit.slices) {
      this.state = advanceState(this.state, { kind: "sliceDone", sliceNumber: slice.number });
      await this.persistence.save(this.state);
      this.logOrch(`Completed slice ${slice.number}`);
      this.slicesCompleted++;
    }
    this.progressSink.updateProgress({ activeAgent: undefined, activeAgentActivity: undefined });
  }

  private async persistRunState(): Promise<void> {
    const modeAwareState =
      this.config.executionMode === "direct"
        ? {
            ...this.state,
            currentSlice: undefined,
            currentGroup: undefined,
            sliceTimings: undefined,
            lastCompletedSlice: undefined,
            lastCompletedGroup: undefined,
            lastSliceImplemented: undefined,
            reviewBaseSha: undefined,
          }
        : this.state;

    this.state = {
      ...modeAwareState,
      completedAt: undefined,
      executionMode: this.config.executionMode,
    };
    this.state = advanceState(this.state, {
      kind: "agentSpawned",
      role: "tdd",
      session: this.currentSession("tdd"),
    });
    this.state = advanceState(this.state, {
      kind: "agentSpawned",
      role: "review",
      session: this.currentSession("review"),
    });
    await this.persistence.save(this.state);
  }

  private async runDirectExecution(group: Group, reviewBase: string): Promise<void> {
    const directSlice = group.slices[0];
    if (!directSlice) {
      return;
    }

    const unit = this.directUnit(directSlice.content, directSlice.number);
    this.sliceSkipFlag = false;
    this.progressSink.clearSkipping();

    const verifyBaseSha = await this.git.captureRef();
    this.phase = transition(this.phase, { kind: "StartPlanning", sliceNumber: unit.sliceNumber });

    let pteResult = await this.planThenExecute(unit.content, unit.sliceNumber);
    if (pteResult.replan) {
      pteResult = await this.planThenExecute(unit.content, unit.sliceNumber, true);
    }

    if (pteResult.skipped) {
      this.failIncompleteExecutionUnit(unit, "execution was skipped before delivery");
    }

    let tddResult = pteResult.tddResult;

    if (pteResult.hardInterrupt) {
      const guidance = pteResult.hardInterrupt;
      this.hardInterruptPending = null;
      await this.respawnTdd();
      this.progressSink.logBadge("tdd", "implementing...");
      await this.enterPhase("tdd", unit.sliceNumber);
      tddResult = await this.withRetry(
        () => this.tddAgent!.send(this.prompts.withBrief(guidance)),
        this.tddAgent!,
        "tdd",
        "tdd-interrupt",
      );
      this.phase = { kind: "Verifying", sliceNumber: unit.sliceNumber };
    }

    this.tddIsFirst = false;

    if (tddResult.needsInput) {
      await this.followUp(tddResult, this.tddAgent!);
    }

    await this.commitSweep(unit.label);

    const triage = await this.triageDiff(verifyBaseSha);
    if (triage.runCompleteness) {
      await this.completenessCheck(unit, verifyBaseSha);
    }

    const directResult = await this.runExecutionUnit(
      unit,
      reviewBase,
      tddResult,
      verifyBaseSha,
      triage,
    );
    this.phase = { kind: "Idle" };

    if (directResult.skipped) {
      this.failIncompleteExecutionUnit(unit, "verification or review did not complete");
    }

    if (triage.runGap) {
      await this.gapAnalysis(group, verifyBaseSha);
    }
  }

  private failIncompleteSlice(slice: Slice, reason: string): never {
    this.phase = { kind: "Idle" };
    this.sliceSkipFlag = false;
    throw new IncompleteRunError(`Slice ${slice.number} did not complete: ${reason}`);
  }

  private canSkipCurrentSlice(): boolean {
    return "sliceNumber" in this.phase;
  }

  private pipeToSink(agent: AgentHandle, role: AgentRole): void {
    const streamer = this.progressSink.createStreamer(role);
    agent.pipe(
      (text) => {
        streamer(text);
        this.logWriter.write(role, text);
      },
      (summary) => this.progressSink.setActivity(summary),
    );
  }

  private logOrch(text: string): void {
    this.logWriter.write("ORCH", text);
  }

  private async persistStateEvent(event: StateEvent): Promise<void> {
    this.state = advanceState(this.state, event);
    await this.persistence.save(this.state);
  }

  private async enterPhase(phase: PersistedPhase, sliceNumber: number): Promise<void> {
    this.logOrch(`Entered phase ${phase} for slice ${sliceNumber}`);
    await this.persistStateEvent({ kind: "phaseEntered", phase, sliceNumber });
  }

  private async clearPersistedPhase(): Promise<void> {
    if (this.state.currentPhase === undefined && this.state.completedAt !== undefined) {
      return;
    }
    this.state = {
      ...this.state,
      currentPhase: undefined,
      completedAt: this.state.completedAt ?? new Date().toISOString(),
    };
    await this.persistence.save(this.state);
  }

  private currentSliceNumber(defaultSliceNumber = 0): number {
    return this.state.currentSlice ?? this.state.lastCompletedSlice ?? defaultSliceNumber;
  }

  private providerForRole(role: "tdd" | "review"): Provider {
    return this.config.agentConfig[role].provider;
  }

  private sessionForRole(role: "tdd" | "review"): PersistedAgentSession | undefined {
    const session = role === "tdd" ? this.state.tddSession : this.state.reviewSession;
    if (session?.provider !== this.providerForRole(role)) {
      return undefined;
    }
    return session;
  }

  private currentSession(role: "tdd" | "review"): PersistedAgentSession {
    const agent = role === "tdd" ? this.tddAgent : this.reviewAgent;
    if (!agent) {
      throw new Error(`Missing ${role} agent`);
    }
    return { provider: this.providerForRole(role), id: agent.sessionId };
  }

  private async sendRulesReminder(role: "tdd" | "review"): Promise<void> {
    const agent = role === "tdd" ? this.tddAgent : this.reviewAgent;
    if (!agent) {
      throw new Error(`Missing ${role} agent`);
    }
    await agent.sendQuiet(this.prompts.rulesReminder(role));
  }

  private async respawnReview(): Promise<void> {
    if (this.reviewAgent) {
      this.reviewAgent.kill();
    }
    this.reviewAgent = this.agents.spawn("review", { cwd: this.config.cwd });
    this.pipeToSink(this.reviewAgent, "review");
    await this.sendRulesReminder("review");
    this.reviewIsFirst = true;
    this.state = advanceState(this.state, {
      kind: "agentSpawned",
      role: "review",
      session: this.currentSession("review"),
    });
    await this.persistence.save(this.state);
  }

  private async validateOrRefreshResumedAgent(
    role: "tdd" | "review",
  ): Promise<"resumed" | "fresh" | "none"> {
    const session = this.sessionForRole(role);
    if (!session) {
      return "none";
    }

    const agent = role === "tdd" ? this.tddAgent : this.reviewAgent;
    if (!agent) {
      throw new Error(`Missing ${role} agent`);
    }

    try {
      await agent.sendQuiet("Reply with exactly OK.");
      return "resumed";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logOrch(`Failed to resume ${role} session for ${session.provider}; starting fresh (${message})`);
      if (role === "tdd") {
        await this.respawnTdd();
      } else {
        await this.respawnReview();
      }
      return "fresh";
    }
  }

  dispose(): void {
    if (this.tddAgent) {
      this.tddAgent.kill();
    }
    if (this.reviewAgent) {
      this.reviewAgent.kill();
    }
    if (this.verifyAgent) {
      this.verifyAgent.kill();
    }
    this.progressSink.teardown();
  }

  async execute(
    groups: readonly Group[],
    opts?: {
      onReady?: (info: { tddSessionId: string; reviewSessionId: string }) => void;
    },
  ): Promise<void> {
    try {
      this.progressSink.logExecutionMode(this.config.executionMode);

      if (groups.length === 0) {
        return;
      }

      this.state = await this.persistence.load();

      if (this.state.tddSession && this.state.tddSession.provider !== this.providerForRole("tdd")) {
        this.state = { ...this.state, tddSession: undefined };
      }
      if (
        this.state.reviewSession &&
        this.state.reviewSession.provider !== this.providerForRole("review")
      ) {
        this.state = { ...this.state, reviewSession: undefined };
      }

      // Spawn initial agents
      this.tddAgent = this.agents.spawn("tdd", {
        resumeSessionId: this.sessionForRole("tdd")?.id,
        cwd: this.config.cwd,
      });
      this.reviewAgent = this.agents.spawn("review", {
        resumeSessionId: this.sessionForRole("review")?.id,
        cwd: this.config.cwd,
      });
      this.pipeToSink(this.tddAgent, "tdd");
      this.pipeToSink(this.reviewAgent, "review");

      const resumedTdd = await this.validateOrRefreshResumedAgent("tdd");
      const resumedReview = await this.validateOrRefreshResumedAgent("review");
      const reminders: Promise<void>[] = [];
      if (resumedTdd === "none") {
        reminders.push(this.sendRulesReminder("tdd"));
      }
      if (resumedReview === "none") {
        reminders.push(this.sendRulesReminder("review"));
      }
      await Promise.all(reminders);

      if (resumedTdd === "resumed") {
        this.tddIsFirst = false;
      }
      if (resumedReview === "resumed") {
        this.reviewIsFirst = false;
      }

      opts?.onReady?.({
        tddSessionId: this.tddAgent.sessionId,
        reviewSessionId: this.reviewAgent.sessionId,
      });

      // Register keyboard interrupts
      const interrupts = this.progressSink.registerInterrupts();
      interrupts.onGuide((text) => {
        if (this.tddAgent) {
          this.tddAgent.inject(text);
        }
      });
      interrupts.onInterrupt((text) => {
        this.hardInterruptPending = text;
        if (this.tddAgent) {
          this.tddAgent.kill();
        }
      });
      interrupts.onSkip(() => {
        if (!this.canSkipCurrentSlice()) {
          return false;
        }
        this.sliceSkipFlag = !this.sliceSkipFlag;
        return true;
      });
      interrupts.onQuit(() => {
        this.quitRequested = true;
        if (this.tddAgent) {
          this.tddAgent.kill();
        }
      });

      const runBaseSha = await this.git.captureRef();

      await this.persistRunState();

      if (this.config.executionMode === "direct") {
        const directGroup = groups[0];
        if (!directGroup) {
          return;
        }
        const directSlice = directGroup.slices[0];
        if (!directSlice) {
          return;
        }
        this.currentDirectRequestContent = directSlice.content;
        try {
          await this.runDirectExecution(directGroup, runBaseSha);
          await this.finalPasses(runBaseSha);
        } finally {
          this.currentDirectRequestContent = null;
        }
        return;
      }

      for (let i = 0; i < groups.length; i++) {
        const group = groups[i];

        const allSlicesDone =
          this.state.lastCompletedSlice !== undefined &&
          group.slices.every((s) => s.number <= this.state.lastCompletedSlice!);
        const groupAlreadyFinalized = this.state.lastCompletedGroup === group.name;

        // Skip entire group only when its slices and its post-slice group work are already complete
        if (allSlicesDone && groupAlreadyFinalized) {
          this.slicesCompleted += group.slices.length;
          this.progressSink.updateProgress({ completedSlices: this.slicesCompleted });
          continue;
        }

        this.progressSink.updateProgress({
          groupName: group.name,
          groupSliceCount: group.slices.length,
          groupCompleted: 0,
        });
        const groupBaseSha = await this.git.captureRef();
        let reviewBase = groupBaseSha;
        let groupCompleted = 0;

        if (this.config.executionMode === "grouped") {
          const groupedResult = await this.runGroupedExecutionUnit(group, reviewBase, groupBaseSha);
          reviewBase = groupedResult.reviewBase;

          if (groupedResult.skipped) {
            this.failIncompleteExecutionUnit(this.groupedUnit(group), "verification or review did not complete");
          }

          groupCompleted = group.slices.length;
          this.progressSink.updateProgress({
            completedSlices: this.slicesCompleted,
            groupCompleted,
          });
        } else {
          for (const slice of group.slices) {
          // Reset skip state from previous slice
          this.sliceSkipFlag = false;
          this.progressSink.clearSkipping();

          if (this.quitRequested) {
            return;
          }

          if (
            this.state.lastCompletedSlice !== undefined &&
            slice.number <= this.state.lastCompletedSlice
          ) {
            this.slicesCompleted++;
            groupCompleted++;
            this.progressSink.updateProgress({
              completedSlices: this.slicesCompleted,
              groupCompleted,
            });
            continue;
          }

          this.logOrch(`Starting slice ${slice.number} (${group.name})`);
          await this.persistStateEvent({
            kind: "sliceStarted",
            sliceNumber: slice.number,
            groupName: group.name,
          });

          this.progressSink.updateProgress({
            currentSlice: { number: slice.number },
            completedSlices: this.slicesCompleted,
          });

          this.progressSink.logSliceIntro(slice);

          const verifyBaseSha = await this.git.captureRef();

          // Plan-then-execute with replan loop
          this.phase = transition(this.phase, { kind: "StartPlanning", sliceNumber: slice.number });
          let replanAttempts = 0;
          let pteResult: PlanThenExecuteResult;
          do {
            pteResult = await this.planThenExecute(slice.content, slice.number);
            replanAttempts++;
          } while (pteResult.replan && replanAttempts < this.config.maxReplans);

          // After max replans, auto-accept
          if (pteResult.replan) {
            pteResult = await this.planThenExecute(slice.content, slice.number, true);
          }

          if (pteResult.skipped) {
            this.failIncompleteSlice(slice, "execution was skipped before delivery");
          }

          let tddResult = pteResult.tddResult;

          // Hard interrupt: agent was killed during plan or execute phase
          if (pteResult.hardInterrupt) {
            const guidance = pteResult.hardInterrupt;
            this.hardInterruptPending = null;
            await this.respawnTdd();
            this.progressSink.logBadge("tdd", "implementing...");
            await this.enterPhase("tdd", slice.number);
            tddResult = await this.withRetry(
              () => this.tddAgent!.send(this.prompts.withBrief(guidance)),
              this.tddAgent!,
              "tdd",
              "tdd-interrupt",
            );
            this.phase = { kind: "Verifying", sliceNumber: slice.number };
          }

          this.tddIsFirst = false;

          if (tddResult.needsInput) {
            await this.followUp(tddResult, this.tddAgent!);
          }

          // Commit sweep
          await this.commitSweep(`Slice ${slice.number}`);

          // Triage: classify the diff to decide which pipeline phases to run
          const triage = await this.triageDiff(verifyBaseSha);

          // Completeness check
          if (triage.runCompleteness) {
            await this.completenessCheck(this.sliceUnit(slice, group.name), verifyBaseSha);
          }

          // Post-TDD pipeline: verify → review → summary
          const sliceResult = await this.runExecutionUnit(
            this.sliceUnit(slice, group.name),
            reviewBase,
            tddResult,
            verifyBaseSha,
            triage,
          );
          reviewBase = sliceResult.reviewBase;
          this.phase = { kind: "Idle" };

          if (sliceResult.skipped) {
            this.failIncompleteSlice(slice, "verification or review did not complete");
          }

          if (!sliceResult.skipped) {
            groupCompleted++;
            this.progressSink.updateProgress({
              completedSlices: this.slicesCompleted,
              groupCompleted,
            });
          }
        }
        }

        // Gap analysis
        await this.gapAnalysis(group, groupBaseSha);

        // Commit sweep
        await this.commitSweep(group.name);

        // Mark group complete
        this.state = advanceState(this.state, { kind: "groupDone", groupName: group.name });
        await this.persistence.save(this.state);

        // Inter-group transition
        if (i < groups.length - 1) {
          await this.respawnBoth();

          if (!this.config.auto) {
            const next = groups[i + 1];
            const nextLabel = `${next.name} (${next.slices.map((s) => `Slice ${s.number}`).join(", ")})`;
            const proceed = await this.gate.confirmNextGroup(nextLabel);
            if (!proceed) {
              return;
            }
          }
        }
      }

      // Final passes
      await this.finalPasses(runBaseSha);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logOrch(`Execution failed: ${message}`);
      throw error;
    } finally {
      await this.logWriter.close();
    }
  }

  async planThenExecute(
    sliceContent: string,
    sliceNumber: number,
    forceAccept = false,
  ): Promise<PlanThenExecuteResult> {
    if (this.config.executionMode === "direct") {
      this.phase = transition(this.phase, { kind: "PlanReady", planText: "" });
      this.phase = transition(this.phase, { kind: "PlanAccepted" });

      const directExecutePrompt = this.prompts.directExecute(sliceContent);
      this.progressSink.logBadge("tdd", "implementing...");
      await this.enterPhase("tdd", sliceNumber);
      const executeResult = await this.withRetry(
        () => this.tddAgent!.send(directExecutePrompt),
        this.tddAgent!,
        "tdd",
        "direct-execute",
      );

      if (executeResult.needsInput) {
        await this.followUp(executeResult, this.tddAgent!);
      }

      if (this.sliceSkipFlag) {
        this.phase = { kind: "Idle" };
        return { tddResult: executeResult, skipped: true };
      }

      const execInterrupt = this.hardInterruptPending;
      if (execInterrupt) {
        return { tddResult: executeResult, skipped: false, hardInterrupt: execInterrupt };
      }

      const directTestPassPrompt = this.prompts.directTestPass(sliceContent);
      this.progressSink.logBadge("tdd", "testing...");
      await this.enterPhase("tdd", sliceNumber);
      const testPassResult = await this.withRetry(
        () => this.tddAgent!.send(directTestPassPrompt),
        this.tddAgent!,
        "tdd",
        "direct-test-pass",
      );

      if (testPassResult.needsInput) {
        await this.followUp(testPassResult, this.tddAgent!);
      }

      if (this.sliceSkipFlag) {
        this.phase = { kind: "Idle" };
        return { tddResult: executeResult, skipped: true };
      }

      const testPassInterrupt = this.hardInterruptPending;
      if (testPassInterrupt) {
        return { tddResult: executeResult, skipped: false, hardInterrupt: testPassInterrupt };
      }

      this.tddIsFirst = false;
      this.phase = transition(this.phase, { kind: "ExecutionDone" });
      return { tddResult: executeResult, skipped: false };
    }

    if (this.config.planDisabled) {
      this.phase = transition(this.phase, { kind: "PlanReady", planText: "" });
      this.phase = transition(this.phase, { kind: "PlanAccepted" });

      const prompt = this.tddIsFirst
        ? this.prompts.withBrief(this.prompts.tdd(sliceContent, undefined, sliceNumber))
        : this.prompts.tdd(sliceContent, undefined, sliceNumber);
      this.progressSink.logBadge("tdd", "implementing...");
      await this.enterPhase("tdd", sliceNumber);
      const tddResult = await this.withRetry(
        () => this.tddAgent!.send(prompt),
        this.tddAgent!,
        "tdd",
        "tdd-direct",
      );
      this.tddIsFirst = false;
      this.phase = transition(this.phase, { kind: "ExecutionDone" });
      return { tddResult, skipped: false };
    }

    // ── Plan phase ──
    const planPrompt = this.prompts.plan(sliceContent, sliceNumber);
    const planAgent = this.agents.spawn("plan", { cwd: this.config.cwd });
    this.pipeToSink(planAgent, "plan");
    this.progressSink.logBadge("plan", "planning...");
    await this.enterPhase("plan", sliceNumber);
    const planResult = await this.withRetry(() => planAgent.send(planPrompt), planAgent, "plan", "plan");

    const plan = planResult.planText ?? planResult.assistantText ?? "";

    if (this.sliceSkipFlag) {
      planAgent.kill();
      this.phase = { kind: "Idle" };
      return { tddResult: planResult, skipped: true, planText: plan };
    }

    const hardInterruptGuidance = this.hardInterruptPending;
    if (hardInterruptGuidance) {
      planAgent.kill();
      this.phase = { kind: "Idle" };
      return {
        tddResult: planResult,
        skipped: false,
        hardInterrupt: hardInterruptGuidance,
        planText: plan,
      };
    }

    planAgent.kill();

    this.phase = transition(this.phase, { kind: "PlanReady", planText: plan });

    // ── Confirmation gate ──
    const skipConfirm = forceAccept || this.config.auto;
    let operatorGuidance: string | undefined;
    if (!skipConfirm) {
      const decision = await this.gate.confirmPlan(plan);
      if (decision.kind === "reject") {
        this.phase = transition(this.phase, { kind: "PlanRejected" });
        return { tddResult: planResult, skipped: false, replan: true, planText: plan };
      }
      if (decision.kind === "edit") {
        operatorGuidance = decision.guidance;
      }
    }

    this.phase = transition(this.phase, { kind: "PlanAccepted" });

    // ── Execute phase ──
    const executePrompt = this.prompts.tddExecute(
      plan,
      sliceNumber,
      this.tddIsFirst,
      operatorGuidance,
    );
    this.progressSink.logBadge("tdd", "implementing...");
    await this.enterPhase("tdd", sliceNumber);
    const tddResult = await this.withRetry(
      () => this.tddAgent!.send(executePrompt),
      this.tddAgent!,
      "tdd",
      "tdd-execute",
    );

    // Dead session fallback
    if (!this.tddAgent!.alive) {
      const deadSessionInterrupt = this.hardInterruptPending;
      if (deadSessionInterrupt) {
        this.phase = { kind: "Idle" };
        return { tddResult, skipped: false, hardInterrupt: deadSessionInterrupt, planText: plan };
      }
      await this.respawnTdd();
      this.progressSink.logBadge("tdd", "implementing...");
      await this.enterPhase("tdd", sliceNumber);
      const retryResult = await this.withRetry(
        () => this.tddAgent!.send(executePrompt),
        this.tddAgent!,
        "tdd",
        "tdd-execute-retry",
      );
      this.phase = transition(this.phase, { kind: "ExecutionDone" });
      return { tddResult: retryResult, skipped: false, planText: plan };
    }

    if (this.sliceSkipFlag) {
      this.phase = { kind: "Idle" };
      return { tddResult, skipped: true, planText: plan };
    }

    const execInterrupt = this.hardInterruptPending;
    if (execInterrupt) {
      return { tddResult, skipped: false, hardInterrupt: execInterrupt, planText: plan };
    }

    this.tddIsFirst = false;
    this.phase = transition(this.phase, { kind: "ExecutionDone" });
    return { tddResult, skipped: false, planText: plan };
  }

  async runGroupedExecutionUnit(
    group: Group,
    reviewBase: string,
    groupBaseSha: string,
  ): Promise<{ reviewBase: string; skipped: boolean }> {
    const unit = this.groupedUnit(group);
    this.sliceSkipFlag = false;
    this.progressSink.clearSkipping();

    if (this.quitRequested) {
      return { reviewBase, skipped: true };
    }

    this.progressSink.updateProgress({
      currentSlice: { number: unit.sliceNumber },
      completedSlices: this.slicesCompleted,
    });

    const executePrompt = this.prompts.groupedExecute(
      unit.groupName,
      unit.content,
      this.tddIsFirst,
    );
    this.phase = { kind: "Executing", sliceNumber: unit.sliceNumber, planText: null };
    this.progressSink.logBadge("tdd", "implementing...");
    await this.enterPhase("tdd", unit.sliceNumber);
    const executeResult = await this.withRetry(
      () => this.tddAgent!.send(executePrompt),
      this.tddAgent!,
      "tdd",
      "group-execute",
    );
    this.tddIsFirst = false;

    if (executeResult.needsInput) {
      await this.followUp(executeResult, this.tddAgent!);
    }

    if (this.sliceSkipFlag) {
      return { reviewBase, skipped: true };
    }

    const testPassPrompt = this.prompts.groupedTestPass(unit.groupName, unit.content);
    this.progressSink.logBadge("tdd", "testing...");
    await this.enterPhase("tdd", unit.sliceNumber);
    const testPassResult = await this.withRetry(
      () => this.tddAgent!.send(testPassPrompt),
      this.tddAgent!,
      "tdd",
      "group-test-pass",
    );

    if (testPassResult.needsInput) {
      await this.followUp(testPassResult, this.tddAgent!);
    }

    this.phase = transition(this.phase, { kind: "ExecutionDone" });

    await this.commitSweep(`Group ${unit.groupName}`);

    const triage = await this.triageDiff(groupBaseSha);
    if (triage.runCompleteness) {
      await this.completenessCheck(unit, groupBaseSha);
    }

    return this.runExecutionUnit(unit, reviewBase, executeResult, groupBaseSha, triage);
  }

  async runExecutionUnit(
    unit: ExecutionUnit,
    reviewBase: string,
    tddResult: AgentResult,
    verifyBaseSha: string,
    triage: TriageResult = FULL_TRIAGE,
  ): Promise<{ reviewBase: string; skipped: boolean }> {
    const tddText = tddResult.assistantText ?? "";
    const headAfterTdd = await this.git.captureRef();

    if (isAlreadyImplemented(tddText, headAfterTdd, reviewBase)) {
      this.phase = { kind: "Idle" };
      await this.markExecutionUnitComplete(unit);
      return { reviewBase, skipped: false };
    }

    // Verify gate
    if (this.config.verifySkill === null || !triage.runVerify) {
      // verify disabled or triage skipped it
    } else {
      const verified = await this.verify(unit, verifyBaseSha);
      if (!verified) {
        return { reviewBase, skipped: true };
      }
    }

    if (this.sliceSkipFlag) {
      return { reviewBase, skipped: true };
    }

    this.phase = transition(this.phase, { kind: "VerifyPassed" });
    this.phase = transition(this.phase, { kind: "CompletenessOk" });

    if (unit.kind !== "direct") {
      this.state = advanceState(this.state, {
        kind: "sliceImplemented",
        sliceNumber: unit.sliceNumber,
        reviewBaseSha: verifyBaseSha,
      });
      await this.persistence.save(this.state);
    }

    // Review-fix loop — gated on minimum diff threshold
    const diffStats = await this.git.measureDiff(reviewBase);
    if (!shouldReview(diffStats, this.config.reviewThreshold)) {
      this.phase = transition(this.phase, { kind: "SliceComplete" });
      await this.markExecutionUnitComplete(unit);
      return { reviewBase, skipped: false };
    }

    if (this.sliceSkipFlag) {
      return { reviewBase, skipped: true };
    }

    if (this.config.reviewSkill !== null && triage.runReview) {
      await this.reviewFix(unit, reviewBase);
    }
    const newReviewBase = await this.git.captureRef();

    if (this.sliceSkipFlag) {
      return { reviewBase: newReviewBase, skipped: true };
    }

    this.phase = transition(this.phase, { kind: "ReviewClean" });

    // Slice summary
    await this.tddAgent!.sendQuiet(this.summaryPromptForUnit(unit));

    await this.markExecutionUnitComplete(unit);
    return { reviewBase: newReviewBase, skipped: false };
  }

  async reviewFix(unit: ExecutionUnit, baseSha: string): Promise<void> {
    let reviewSha = baseSha;
    let priorFindings: string | undefined;

    for (let cycle = 1; cycle <= this.config.maxReviewCycles; cycle++) {
      if (this.sliceSkipFlag) {
        break;
      }

      if (!(await this.git.hasChanges(reviewSha))) {
        break;
      }

      this.progressSink.updateProgress({
        activeAgent: "REV",
        activeAgentActivity: `reviewing (cycle ${cycle})...`,
      });

      const reviewPromptText = this.reviewPromptForUnit(unit, reviewSha, priorFindings);
      const reviewPrompt = this.reviewIsFirst
        ? this.prompts.withBrief(reviewPromptText)
        : reviewPromptText;
      this.progressSink.logBadge("review", "reviewing...");
      await this.enterPhase("review", unit.sliceNumber);
      const reviewResult = await this.withRetry(
        () => this.reviewAgent!.send(reviewPrompt),
        this.reviewAgent!,
        "review",
        "review",
      );
      this.reviewIsFirst = false;
      const reviewText = reviewResult.assistantText;

      if (!reviewText || isCleanReview(reviewText)) {
        break;
      }

      this.phase = transition(this.phase, { kind: "ReviewIssues" });
      priorFindings = reviewText;
      const preFixSha = await this.git.captureRef();
      const fixPrompt = unit.kind === "direct"
        ? `A code review found issues with the current direct request implementation. Address them.

## Current direct request
${unit.content}

## Review findings
${reviewText}

Rules:
- Keep fixes scoped to this direct request.
- Do not reframe the work as a plan slice or invent future work.
- Treat each concrete finding as an implementation obligation unless you can prove it is incorrect with code and passing tests.`
        : this.prompts.tdd(unit.content, reviewText, unit.sliceNumber);
      this.progressSink.logBadge("tdd", "implementing...");
      await this.enterPhase("tdd", unit.sliceNumber);
      const fixResult = await this.withRetry(
        () => this.tddAgent!.send(this.tddIsFirst ? this.prompts.withBrief(fixPrompt) : fixPrompt),
        this.tddAgent!,
        "tdd",
        "review-fix",
      );
      this.tddIsFirst = false;

      if (fixResult.needsInput) {
        await this.followUp(fixResult, this.tddAgent!);
      }

      if (!(await this.git.hasChanges(preFixSha))) {
        break;
      }

      reviewSha = preFixSha;
    }
  }

  async completenessCheck(unit: ExecutionUnit, baseSha: string): Promise<void> {
    if (this.sliceSkipFlag) {
      return;
    }
    if (!(await this.git.hasChanges(baseSha))) {
      return;
    }

    const prompt = this.completenessPromptForUnit(unit, baseSha);

    for (let cycle = 1; cycle <= this.config.maxReviewCycles; cycle++) {
      const checkAgent = this.agents.spawn("completeness", { cwd: this.config.cwd });
      this.pipeToSink(checkAgent, "completeness");
      await this.enterPhase("verify", unit.sliceNumber);
      const result = await this.withRetry(
        () => checkAgent.send(prompt),
        checkAgent,
        "completeness",
        "completeness-check",
      );
      checkAgent.kill();

      const text = result.assistantText ?? "";
      const hasMissing = text.includes("❌") || text.includes("MISSING");
      const completionSentinel = unit.kind === "group"
        ? "GROUP_COMPLETE"
        : unit.kind === "direct"
          ? "DIRECT_COMPLETE"
          : "SLICE_COMPLETE";
      if (text.includes(completionSentinel) && !hasMissing) {
        return;
      }

      // Phase: Verifying → CompletenessCheck → Executing (issues found)
      this.phase = transition(this.phase, { kind: "VerifyPassed" });
      this.phase = transition(this.phase, { kind: "CompletenessIssues" });

      const fixPrompt = unit.kind === "direct"
        ? `A completeness check found that your implementation does not fully match the direct request. Fix ALL issues below.

## Current direct request
${unit.content}

## Completeness Findings
${text}

Rules:
- ❌ MISSING items are HARD FAILURES. The direct request is the contract. Code that works but doesn't implement what was requested is NOT complete.
- ⚠️ DIVERGENT items mean your approach differs from the request's intent. Change your implementation to match the request, not the other way around.
- If the request says "use function X" or "call Y", your code must actually import and call X/Y. Passing tests are necessary but NOT sufficient.
- Do NOT argue that your approach is equivalent. Do NOT skip items because tests pass without them. Implement what the request says.`
        : this.prompts.tdd(
            unit.content,
            `A completeness check found that your implementation does not fully match the plan. Fix ALL issues below.\n\n## Completeness Findings\n${text}\n\nRules:\n- ❌ MISSING items are HARD FAILURES. The plan is the contract. Code that works but doesn't implement the plan's specified approach is NOT complete. You must implement what the plan says, not an alternative that passes tests.\n- ⚠️ DIVERGENT items mean your approach differs from the plan's intent. Change your implementation to match the plan, not the other way around.\n- If the plan says "use function X" or "call Y", your code must actually import and call X/Y. Passing tests are necessary but NOT sufficient — the plan's architectural requirements are equally binding.\n- Do NOT argue that your approach is equivalent. Do NOT skip items because tests pass without them. Implement what the plan says.`,
            unit.sliceNumber,
          );
      const preFixSha = await this.git.captureRef();
      this.progressSink.logBadge("tdd", "implementing...");
      await this.enterPhase("tdd", unit.sliceNumber);
      const fixResult = await this.withRetry(
        () => this.tddAgent!.send(this.tddIsFirst ? this.prompts.withBrief(fixPrompt) : fixPrompt),
        this.tddAgent!,
        "tdd",
        "completeness-fix",
      );
      this.tddIsFirst = false;

      if (fixResult.needsInput) {
        await this.followUp(fixResult, this.tddAgent!);
      }

      this.phase = transition(this.phase, { kind: "ExecutionDone" });

      if (await this.git.hasChanges(preFixSha)) {
        await this.commitSweep(`${unit.label} completeness fix`);
      }
    }

    throw new IncompleteRunError(`${unit.label} completeness failed after retry budget`);
  }

  async verify(unit: ExecutionUnit, verifyBaseSha: string): Promise<boolean> {
    this.progressSink.updateProgress({ activeAgent: "VFY", activeAgentActivity: "verifying..." });

    if (!this.verifyAgent) {
      this.verifyAgent = this.agents.spawn("verify", { cwd: this.config.cwd });
      this.pipeToSink(this.verifyAgent, "verify");
    }

    const verifyPrompt = this.verifyPromptForUnit(unit, verifyBaseSha);
    this.progressSink.logBadge("verify", "verifying...");
    await this.enterPhase("verify", unit.sliceNumber);
    const verifyResult = await this.withRetry(
      () => this.verifyAgent!.send(verifyPrompt),
      this.verifyAgent,
      "verify",
      "verify",
    );
    let parsed = parseVerifyResult(verifyResult.assistantText ?? "");

    for (let cycle = 1; !isVerifyPassing(parsed) && cycle <= this.config.maxReviewCycles; cycle++) {
      this.phase = transition(this.phase, { kind: "VerifyFailed" });

      const builderFixable = parsed.retryable && parsed.sliceLocalFailures.length > 0;
      const failureSummary = this.formatVerifyFailureSummary(parsed);

      if (!builderFixable) {
        if (this.config.auto) {
          throw new IncompleteRunError(`${unit.label} verification failed: ${parsed.summary}`);
        }

        const decision = await this.gate.verifyFailed(unit.label, failureSummary, false);
        if (decision.kind === "skip") {
          return false;
        }
        throw new IncompleteRunError(`${unit.label} verification failed and execution stopped`);
      }

      // Send findings to TDD for fixing
      const retryPrompt = `Verification found issues after your implementation. Fix them in ${unit.label}.\n\n## Current ${
        unit.kind === "group" ? "group" : unit.kind === "direct" ? "direct request" : "slice"
      } content\n${unit.content}\n\n## Slice-local failures\n${parsed.sliceLocalFailures.join("\n")}\n\n## Verification summary\n${parsed.summary}`;
      const preFixSha = await this.git.captureRef();
      this.progressSink.logBadge("tdd", "implementing...");
      await this.enterPhase("tdd", unit.sliceNumber);
      const fixResult = await this.withRetry(
        () => this.tddAgent!.send(retryPrompt),
        this.tddAgent!,
        "tdd",
        "verify-fix",
      );
      await this.checkCredit(fixResult, this.tddAgent!, "tdd");

      this.phase = transition(this.phase, { kind: "ExecutionDone" });

      const tddMadeChanges = await this.git.hasChanges(preFixSha);

      if (!tddMadeChanges) {
        if (this.config.auto) {
          throw new IncompleteRunError(`${unit.label} verification failed without builder changes`);
        }

        const decision = await this.gate.verifyFailed(
          unit.label,
          `${failureSummary}\n\nBuilder made no relevant change.`,
          true,
        );

        if (decision.kind === "skip") {
          return false;
        }
        if (decision.kind === "stop") {
          throw new IncompleteRunError(`${unit.label} verification failed and execution stopped`);
        }
        continue;
      }

      // Re-verify — tell the verifier what TDD fixed
      const fixSummary = fixResult.assistantText?.slice(0, 500) ?? "TDD attempted fixes.";
      this.progressSink.logBadge("verify", "verifying...");
      await this.enterPhase("verify", unit.sliceNumber);
      const reVerifyResult = await this.withRetry(
        () => this.verifyAgent!.send(this.verifyPromptForUnit(unit, verifyBaseSha, fixSummary)),
        this.verifyAgent!,
        "verify",
        "re-verify",
      );
      parsed = parseVerifyResult(reVerifyResult.assistantText ?? "");

      if (!isVerifyPassing(parsed) && !this.config.auto) {
        const nextBuilderFixable = parsed.retryable && parsed.sliceLocalFailures.length > 0;
        const decision = await this.gate.verifyFailed(
          unit.label,
          this.formatVerifyFailureSummary(parsed),
          nextBuilderFixable,
        );

        if (decision.kind === "skip") {
          return false;
        }
        if (decision.kind === "stop") {
          throw new IncompleteRunError(`${unit.label} verification failed and execution stopped`);
        }
        continue;
      }
    }

    if (!isVerifyPassing(parsed)) {
      throw new IncompleteRunError(`${unit.label} verification failed after retry budget`);
    }

    return true;
  }

  async finalPasses(runBaseSha: string): Promise<void> {
    if (!(await this.git.hasChanges(runBaseSha))) {
      await this.clearPersistedPhase();
      return;
    }

    this.phase = transition(this.phase, { kind: "StartFinalPasses" });

    const passes = this.finalPassesForRun(runBaseSha);

    for (const pass of passes) {
      let passClean = false;

      for (let cycle = 1; cycle <= this.config.maxReviewCycles; cycle++) {
        const finalAgent = this.agents.spawn("final", { cwd: this.config.cwd });
        this.pipeToSink(finalAgent, "final");
        const finalPrompt = this.prompts.withBrief(pass.prompt);
        this.progressSink.logBadge("final", "finalising...");
        await this.enterPhase("final", this.currentSliceNumber());
        const finalResult = await this.withRetry(
          () => finalAgent.send(finalPrompt),
          finalAgent,
          "final",
          "final-pass",
        );
        finalAgent.kill();

        if (finalResult.exitCode !== 0) {
          continue;
        }
        const findings = finalResult.assistantText ?? "";
        if (!findings || findings.includes("NO_ISSUES_FOUND")) {
          passClean = true;
          break;
        }

        const fixPrompt = this.finalFixPrompt(pass, findings);
        const actualFixPrompt = this.tddIsFirst ? this.prompts.withBrief(fixPrompt) : fixPrompt;
        const preFixSha = await this.git.captureRef();
        this.progressSink.logBadge("tdd", "implementing...");
        await this.enterPhase("tdd", this.currentSliceNumber());
        const fixResult = await this.withRetry(
          () => this.tddAgent!.send(actualFixPrompt),
          this.tddAgent!,
          "tdd",
          "final-fix",
        );
        this.tddIsFirst = false;
        await this.checkCredit(fixResult, this.tddAgent!, "tdd");

        if (fixResult.needsInput) {
          await this.followUp(fixResult, this.tddAgent!);
        }

        if (await this.git.hasChanges(preFixSha)) {
          await this.commitSweep(`${pass.name} final fix`);
        }
      }

      if (!passClean) {
        throw new IncompleteRunError(`Final pass "${pass.name}" failed after retry budget`);
      }
    }

    this.phase = transition(this.phase, { kind: "AllPassesDone" });
    await this.clearPersistedPhase();
  }

  async gapAnalysis(group: Group, groupBaseSha: string): Promise<void> {
    if (!(await this.git.hasChanges(groupBaseSha))) {
      return;
    }
    if (this.config.gapDisabled) {
      return;
    }

    this.phase = transition(this.phase, { kind: "StartGap", groupName: group.name });

    const groupContent = group.slices.map((s) => s.content).join("\n\n---\n\n");
    const gapPrompt = this.gapPromptForRun(groupContent, groupBaseSha);

    for (let cycle = 1; cycle <= this.config.maxReviewCycles; cycle++) {
      const gapAgent = this.agents.spawn("gap", { cwd: this.config.cwd });
      this.pipeToSink(gapAgent, "gap");
      this.progressSink.logBadge("gap", "filling gaps...");
      await this.enterPhase(
        "gap",
        this.currentSliceNumber(group.slices[group.slices.length - 1]?.number ?? 0),
      );
      const gapResult = await this.withRetry(
        () => gapAgent.send(gapPrompt),
        gapAgent,
        "gap",
        "gap",
      );
      gapAgent.kill();

      const gapText = gapResult.assistantText ?? "";

      if (gapResult.exitCode !== 0 || gapText.includes("NO_GAPS_FOUND")) {
        this.phase = transition(this.phase, { kind: "GapDone" });
        return;
      }

      const fixPrompt = this.gapFixPrompt(groupContent, gapText);
      const actualFixPrompt = this.tddIsFirst ? this.prompts.withBrief(fixPrompt) : fixPrompt;
      const preFixSha = await this.git.captureRef();
      this.progressSink.logBadge("tdd", "implementing...");
      await this.enterPhase(
        "tdd",
        this.currentSliceNumber(group.slices[group.slices.length - 1]?.number ?? 0),
      );
      const fixResult = await this.withRetry(
        () => this.tddAgent!.send(actualFixPrompt),
        this.tddAgent!,
        "tdd",
        "gap-fix",
      );
      this.tddIsFirst = false;
      await this.checkCredit(fixResult, this.tddAgent!, "tdd");

      if (fixResult.needsInput) {
        await this.followUp(fixResult, this.tddAgent!);
      }

      if (await this.git.hasChanges(preFixSha)) {
        await this.commitSweep(`${group.name} gap fixes`);
      }
    }

    throw new IncompleteRunError(`${group.name} gap analysis failed after retry budget`);
  }

  async triageDiff(baseSha: string): Promise<TriageResult> {
    const diff = await this.git.getDiff(baseSha);
    if (!diff) {
      return FULL_TRIAGE;
    }
    try {
      const agent = this.agents.spawn("triage", { cwd: this.config.cwd });
      const prompt = buildTriagePrompt(diff);
      const result = await agent.send(prompt);
      agent.kill();
      const triage = parseTriageResult(result.assistantText ?? "");
      this.progressSink.logBadge("triage", triage.reason);
      return triage;
    } catch {
      return FULL_TRIAGE;
    }
  }

  async commitSweep(label: string): Promise<void> {
    const dirty = await this.git.hasDirtyTree();
    if (!dirty) {
      return;
    }
    if (!this.tddAgent?.alive) {
      return;
    }

    const prompt = this.prompts.commitSweep(label);
    const result = await this.withRetry(
      () => this.tddAgent!.send(prompt),
      this.tddAgent,
      "tdd",
      "commit-sweep",
    );

    if (result.needsInput) {
      await this.followUp(result, this.tddAgent);
    }
  }

  async followUp(
    result: AgentResult,
    agent: AgentHandle,
    role: AgentRole = "tdd",
    maxFollowUps = 3,
  ): Promise<AgentResult> {
    let current = result;
    let followUps = 0;

    while (current.needsInput && !this.config.auto && followUps < maxFollowUps) {
      const answer = await this.gate.askUser("Your response (or Enter to skip): ");

      if (!answer.trim()) {
        current = await agent.send(
          "No preference — proceed with your best judgement. Make the decision yourself and continue implementing.",
        );
      } else {
        current = await agent.send(answer);
      }
      await this.checkCredit(current, agent, role);
      followUps++;
    }

    return current;
  }

  async withRetry(
    fn: () => Promise<AgentResult>,
    agent: AgentHandle,
    role: AgentRole,
    label: string,
    maxRetries = 2,
    delayMs = this.retryDelayMs,
  ): Promise<AgentResult> {
    let attempt = 0;
    while (true) {
      const result = await fn();
      if (!agent.alive) {
        return result;
      }
      const apiError = detectApiError(result, agent.stderr);
      if (!apiError) {
        return result;
      }

      if (!apiError.retryable) {
        if (await this.waitForUsageAvailability(apiError, role, label)) {
          continue;
        }
        await this.persistence.save(this.state);
        const decision = await this.gate.creditExhausted(
          label,
          `${apiError.kind}: ${result.resultText.slice(0, 200)}`,
        );
        if (decision.kind === "quit") {
          throw new CreditExhaustedError(
            `Terminal API error during ${label}: ${apiError.kind}`,
            result.assistantText.length > 0 ? "mid-response" : "rejected",
          );
        }
        // retry — operator chose to wait and retry
        continue;
      }

      attempt++;
      if (attempt > maxRetries) {
        throw new Error(`Max retries (${maxRetries}) exceeded for ${label}: ${apiError.kind}`);
      }

      this.progressSink.setActivity(`waiting to retry (${apiError.kind})...`);
      await new Promise((r) => setTimeout(r, delayMs * attempt));
    }
  }

  private async waitForUsageAvailability(
    apiError: ApiError,
    role: AgentRole,
    label: string,
  ): Promise<boolean> {
    if (!this.config.auto || apiError.kind !== "credit-exhausted") {
      return false;
    }

    let attempt = 0;
    while (true) {
      const waitMs = Math.min(
        this.usageProbeDelayMs * 2 ** attempt,
        this.usageProbeMaxDelayMs,
      );
      this.logOrch(`Auto mode blocked by usage limit during ${label}; probing again after ${waitMs}ms`);
      this.progressSink.setActivity(`usage limited; probing ${role} again in ${Math.round(waitMs / 1000)}s`);
      await this.persistence.save(this.state);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, waitMs));

      const probe = this.agents.spawn(role, { cwd: this.config.cwd });
      try {
        const probeResult = await probe.send("Reply with exactly OK.");
        const probeError = detectApiError(probeResult, probe.stderr);
        if (probeError === null) {
          this.logOrch(`Usage probe succeeded for ${label}; retrying`);
          this.progressSink.setActivity(`usage available again; retrying ${label}...`);
          return true;
        }
      } finally {
        probe.kill();
      }

      attempt++;
    }
  }

  async checkCredit(
    result: AgentResult,
    agent: AgentHandle,
    role: AgentRole,
    label = "post-send",
  ): Promise<void> {
    const apiError = detectApiError(result, agent.stderr);
    if (!apiError || apiError.retryable) {
      return;
    }
    if (await this.waitForUsageAvailability(apiError, role, label)) {
      return;
    }
    await this.persistence.save(this.state);
    const decision = await this.gate.creditExhausted(
      label,
      `${apiError.kind}: ${result.resultText.slice(0, 200)}`,
    );
    if (decision.kind === "quit") {
      throw new CreditExhaustedError(
        `Terminal API error: ${apiError.kind}`,
        result.assistantText.length > 0 ? "mid-response" : "rejected",
      );
    }
    // operator chose retry — caller will re-send
  }

  async respawnTdd(): Promise<void> {
    if (this.tddAgent) {
      this.tddAgent.kill();
    }
    this.tddAgent = this.agents.spawn("tdd", { cwd: this.config.cwd });
    this.pipeToSink(this.tddAgent, "tdd");
    await this.tddAgent.sendQuiet(this.prompts.rulesReminder("tdd"));
    this.tddIsFirst = true;
    this.state = advanceState(this.state, {
      kind: "agentSpawned",
      role: "tdd",
      session: this.currentSession("tdd"),
    });
    await this.persistence.save(this.state);
  }

  async respawnBoth(): Promise<void> {
    if (this.tddAgent) {
      this.tddAgent.kill();
    }
    if (this.reviewAgent) {
      this.reviewAgent.kill();
    }
    if (this.verifyAgent) {
      this.verifyAgent.kill();
      this.verifyAgent = null;
    }
    this.tddAgent = this.agents.spawn("tdd", { cwd: this.config.cwd });
    this.reviewAgent = this.agents.spawn("review", { cwd: this.config.cwd });
    this.pipeToSink(this.tddAgent, "tdd");
    this.pipeToSink(this.reviewAgent, "review");
    await Promise.all([
      this.tddAgent.sendQuiet(this.prompts.rulesReminder("tdd")),
      this.reviewAgent.sendQuiet(this.prompts.rulesReminder("review")),
    ]);
    this.tddIsFirst = true;
    this.reviewIsFirst = true;
    this.state = advanceState(this.state, {
      kind: "agentSpawned",
      role: "tdd",
      session: this.currentSession("tdd"),
    });
    this.state = advanceState(this.state, {
      kind: "agentSpawned",
      role: "review",
      session: this.currentSession("review"),
    });
    await this.persistence.save(this.state);
  }
}
