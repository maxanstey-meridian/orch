import type { AgentProcess, AgentResult } from './agent.js';
import type { ProjectProfile } from './fingerprint.js';
import type { TestGateResult } from './test-gate.js';
import { classifyFixOutcome } from './slice-pipeline.js';

const NO_ISSUES_SENTINEL = 'NO_ISSUES_FOUND';

export type AuditPass = {
  readonly name: string;
  readonly label: string;
};

export const AUDIT_PASSES: readonly AuditPass[] = [
  { name: 'type-fidelity', label: 'Type Fidelity' },
  { name: 'plan-completeness', label: 'Plan Completeness' },
  { name: 'cross-component', label: 'Cross-Component Integration' },
];

export type FinalReviewDeps = {
  readonly createAuditAgent: (pass: AuditPass) => AgentProcess;
  readonly implAgent: AgentProcess;
  readonly reviewAgent: AgentProcess;
  readonly hasChanges: (cwd: string, since: string) => Promise<boolean>;
  readonly captureRef: (cwd: string) => Promise<string>;
  readonly runTestGate: (input: { testCommand?: string }) => Promise<TestGateResult>;
  readonly extractFindings: (result: AgentResult) => string;
  readonly isCleanReview: (text: string) => boolean;
  readonly log: (message: string) => void;
};

export type FinalReviewOptions = {
  readonly runBaseline: string;
  readonly planContent: string;
  readonly profile: ProjectProfile;
  readonly cwd: string;
  readonly maxReviewCycles: number;
};

export const runFinalReview = async (
  opts: FinalReviewOptions,
  deps: FinalReviewDeps,
): Promise<void> => {
  const { runBaseline, planContent, profile, cwd, maxReviewCycles } = opts;
  const stack = profile.stack ?? 'unknown';

  // Skip if no changes since run baseline
  const changed = await deps.hasChanges(cwd, runBaseline);
  if (!changed) {
    deps.log('Final review: no changes since run baseline — skipping');
    return;
  }

  for (const pass of AUDIT_PASSES) {
    deps.log(`Final review: starting ${pass.label} audit`);

    const auditAgent = deps.createAuditAgent(pass);
    const auditPrompt = `[${pass.name}] Stack: ${stack}\n\n${planContent}`;
    const auditResult = await auditAgent.send(auditPrompt);

    if (auditResult.exitCode !== 0) {
      deps.log(`Final review: ${pass.label} audit agent failure (exit code ${auditResult.exitCode})`);
      continue;
    }

    const auditText = auditResult.assistantText.trim();
    if (!auditText || auditText === NO_ISSUES_SENTINEL) {
      deps.log(`Final review: ${pass.label} — no issues found`);
      continue;
    }

    // Send findings to impl agent
    await deps.implAgent.send(auditText);

    // Test gate after fix
    const testResult = await deps.runTestGate(profile);
    if (!testResult.passed) {
      deps.log(`Final review: ${pass.label} test gate failed after fix — skipping review`);
      continue;
    }

    // Review-fix cycle
    let baseline = await deps.captureRef(cwd);

    for (let cycle = 0; cycle < maxReviewCycles; cycle++) {
      const reviewChanged = await deps.hasChanges(cwd, baseline);
      if (!reviewChanged) {
        deps.log(`Final review: ${pass.label} no changes since review baseline — skipping review`);
        break;
      }

      const reviewResult = await deps.reviewAgent.send(planContent);

      if (reviewResult.exitCode !== 0) {
        deps.log(`Final review: ${pass.label} review agent failure (exit code ${reviewResult.exitCode})`);
        break;
      }

      const findings = deps.extractFindings(reviewResult);

      if (deps.isCleanReview(findings)) {
        deps.log(`Final review: ${pass.label} review clean`);
        break;
      }

      const fixResult = await deps.implAgent.send(findings);

      const fixChanged = await deps.hasChanges(cwd, baseline);
      const outcome = classifyFixOutcome(fixResult, fixChanged);

      if (outcome === 'deliberate-rejection') {
        deps.log(`Final review: ${pass.label} deliberate rejection — agent chose not to make changes`);
        break;
      }

      if (outcome === 'execution-failure') {
        deps.log(`Final review: ${pass.label} fix execution failure (exit code ${fixResult.exitCode})`);
      }

      if (outcome === 'successful-fix') {
        baseline = await deps.captureRef(cwd);
      }

      const fixTestResult = await deps.runTestGate(profile);
      if (!fixTestResult.passed) {
        deps.log(`Final review: ${pass.label} test gate warning after fix — ${fixTestResult.output}`);
      }
    }
  }
};
