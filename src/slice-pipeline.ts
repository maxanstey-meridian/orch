import type { AgentProcess, AgentResult } from './agent.js';
import type { Slice } from './plan-parser.js';
import type { OrchestratorState } from './state.js';
import type { ProjectProfile } from './fingerprint.js';
import type { TestGateResult } from './test-gate.js';
import type { FollowUpOptions } from './follow-up.js';

export type SlicePipelineDeps = {
  readonly implAgent: AgentProcess;
  readonly reviewAgent: AgentProcess;
  readonly captureRef: (cwd: string) => Promise<string>;
  readonly hasChanges: (cwd: string, since: string) => Promise<boolean>;
  readonly runTestGate: (input: { testCommand?: string }) => Promise<TestGateResult>;
  readonly handleFollowUps: (opts: FollowUpOptions) => Promise<AgentResult>;
  readonly extractFindings: (result: AgentResult) => string;
  readonly extractFormattedFindings: (agent: AgentProcess, prompt: string) => Promise<string>;
  readonly isCleanReview: (text: string) => boolean;
  readonly saveState: (filePath: string, state: OrchestratorState) => Promise<void>;
  readonly log: (message: string) => void;
};

export type SlicePipelineOptions = {
  readonly slices: readonly Slice[];
  readonly state: OrchestratorState;
  readonly statePath: string;
  readonly profile: ProjectProfile;
  readonly brief: string;
  readonly cwd: string;
  readonly interactive: boolean;
  readonly maxReviewCycles: number;
};

type FixOutcome = 'deliberate-rejection' | 'execution-failure' | 'successful-fix';

const classifyFixOutcome = (
  result: AgentResult,
  changed: boolean,
): FixOutcome => {
  if (result.exitCode !== 0) return 'execution-failure';
  if (!changed) return 'deliberate-rejection';
  return 'successful-fix';
};

export const processSlices = async (
  opts: SlicePipelineOptions,
  deps: SlicePipelineDeps,
): Promise<void> => {
  const { slices, statePath, profile, cwd, interactive, maxReviewCycles } = opts;
  let state = { ...opts.state };

  for (const slice of slices) {
    // Skip already completed slices
    if (state.lastCompletedSlice !== undefined && slice.number <= state.lastCompletedSlice) {
      deps.log(`Skipping slice ${slice.number} (already completed)`);
      continue;
    }

    deps.log(`Starting slice ${slice.number}: ${slice.title}`);

    // 1. Run implementation agent (TDD)
    const implResult = await deps.implAgent.send(slice.content);

    // Check for implementation failure
    if (implResult.exitCode !== 0) {
      deps.log(`Slice ${slice.number}: implementation failure (exit code ${implResult.exitCode})`);
      continue;
    }

    // 2. Handle follow-ups
    await deps.handleFollowUps({
      agent: deps.implAgent,
      result: implResult,
      deps: { promptOperator: async () => '' },
      interactive,
    });

    // 3. Test gate
    const testResult = await deps.runTestGate(profile);
    if (!testResult.passed) {
      deps.log(`Slice ${slice.number}: test gate failed — skipping`);
      continue;
    }

    // 4. Review-fix cycle
    let baseline = await deps.captureRef(cwd);

    for (let cycle = 0; cycle < maxReviewCycles; cycle++) {
      // Check for changes since baseline
      const changed = await deps.hasChanges(cwd, baseline);
      if (!changed) {
        deps.log(`Slice ${slice.number}: no changes since baseline — skipping review`);
        break;
      }

      // Run review agent
      const reviewResult = await deps.reviewAgent.send(slice.content);

      // Check review agent exit code
      if (reviewResult.exitCode !== 0) {
        deps.log(`Slice ${slice.number}: review agent failure (exit code ${reviewResult.exitCode})`);
        break;
      }

      // Extract findings
      const findings = deps.extractFindings(reviewResult);

      // Check if review is clean
      if (deps.isCleanReview(findings)) {
        deps.log(`Slice ${slice.number}: review clean`);
        break;
      }

      // Send findings to impl agent for fix
      const fixResult = await deps.implAgent.send(findings);

      // Classify fix outcome
      const fixChanged = await deps.hasChanges(cwd, baseline);
      const outcome = classifyFixOutcome(fixResult, fixChanged);

      if (outcome === 'deliberate-rejection') {
        deps.log(`Slice ${slice.number}: deliberate rejection — agent chose not to make changes`);
        break;
      }

      if (outcome === 'execution-failure') {
        deps.log(`Slice ${slice.number}: fix execution failure (exit code ${fixResult.exitCode})`);
        // Continue cycle — next review may catch regressions
      }

      if (outcome === 'successful-fix') {
        // Advance baseline
        baseline = await deps.captureRef(cwd);
      }

      // Test gate after fix — warn on failure but continue
      const fixTestResult = await deps.runTestGate(profile);
      if (!fixTestResult.passed) {
        deps.log(`Slice ${slice.number}: test gate warning after fix — ${fixTestResult.output}`);
      }
    }

    // 5. Extract summary via quiet mode
    await deps.extractFormattedFindings(deps.implAgent, 'Summarise what you built');

    // 6. Mark slice complete
    state = { ...state, lastCompletedSlice: slice.number };
    await deps.saveState(statePath, state);
  }
};
