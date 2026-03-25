import type { AgentProcess, AgentResult } from './agent.js';
import type { Slice } from './plan-parser.js';
import type { ProjectProfile } from './fingerprint.js';
import type { TestGateResult } from './test-gate.js';
import { classifyFixOutcome } from './slice-pipeline.js';

const NO_GAPS_SENTINEL = 'NO_GAPS_FOUND';

export type GapAnalysisDeps = {
  readonly gapAgent: AgentProcess;
  readonly implAgent: AgentProcess;
  readonly reviewAgent: AgentProcess;
  readonly hasChanges: (cwd: string, since: string) => Promise<boolean>;
  readonly captureRef: (cwd: string) => Promise<string>;
  readonly runTestGate: (input: { testCommand?: string }) => Promise<TestGateResult>;
  readonly extractFindings: (result: AgentResult) => string;
  readonly isCleanReview: (text: string) => boolean;
  readonly log: (message: string) => void;
};

export type GapAnalysisOptions = {
  readonly slices: readonly Slice[];
  readonly baseline: string;
  readonly profile: ProjectProfile;
  readonly cwd: string;
  readonly maxReviewCycles: number;
};

export const runGapAnalysis = async (
  opts: GapAnalysisOptions,
  deps: GapAnalysisDeps,
): Promise<void> => {
  const { slices, baseline, profile, cwd, maxReviewCycles } = opts;

  // Skip if no changes since group baseline
  const changed = await deps.hasChanges(cwd, baseline);
  if (!changed) {
    deps.log('Gap analysis: no changes since group baseline — skipping');
    return;
  }

  // Aggregate all slice content
  const aggregated = slices.map(s => s.content).join('\n\n---\n\n');

  // Run gap agent
  const gapResult = await deps.gapAgent.send(aggregated);

  // Check gap agent exit code
  if (gapResult.exitCode !== 0) {
    deps.log(`Gap analysis: gap agent failure (exit code ${gapResult.exitCode})`);
    return;
  }

  // Check for no-gaps sentinel or empty output
  const gapText = gapResult.assistantText.trim();
  if (!gapText || gapText === NO_GAPS_SENTINEL) {
    deps.log('Gap analysis: no gaps found');
    return;
  }

  // Send gaps to impl agent
  await deps.implAgent.send(gapText);

  // Test gate after gap implementation
  const testResult = await deps.runTestGate(profile);
  if (!testResult.passed) {
    deps.log('Gap analysis: test gate failed after gap implementation — skipping review');
    return;
  }

  // Review-fix cycle (same pattern as slice pipeline)
  let reviewBaseline = await deps.captureRef(cwd);

  for (let cycle = 0; cycle < maxReviewCycles; cycle++) {
    const reviewChanged = await deps.hasChanges(cwd, reviewBaseline);
    if (!reviewChanged) {
      deps.log('Gap analysis: no changes since review baseline — skipping review');
      break;
    }

    const reviewResult = await deps.reviewAgent.send(aggregated);

    if (reviewResult.exitCode !== 0) {
      deps.log(`Gap analysis: review agent failure (exit code ${reviewResult.exitCode})`);
      break;
    }

    const findings = deps.extractFindings(reviewResult);

    if (deps.isCleanReview(findings)) {
      deps.log('Gap analysis: review clean');
      break;
    }

    // Send findings to impl agent for fix
    const fixResult = await deps.implAgent.send(findings);

    const fixChanged = await deps.hasChanges(cwd, reviewBaseline);
    const outcome = classifyFixOutcome(fixResult, fixChanged);

    if (outcome === 'deliberate-rejection') {
      deps.log('Gap analysis: deliberate rejection — agent chose not to make changes');
      break;
    }

    if (outcome === 'execution-failure') {
      deps.log(`Gap analysis: fix execution failure (exit code ${fixResult.exitCode})`);
    }

    if (outcome === 'successful-fix') {
      reviewBaseline = await deps.captureRef(cwd);
    }

    const fixTestResult = await deps.runTestGate(profile);
    if (!fixTestResult.passed) {
      deps.log(`Gap analysis: test gate warning after fix — ${fixTestResult.output}`);
    }
  }
};
