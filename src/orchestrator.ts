import type { Group } from './plan-parser.js';
import type { OrchestratorState } from './state.js';
import type { FingerprintResult, ProjectProfile } from './fingerprint.js';
import type { SlicePipelineOptions } from './slice-pipeline.js';
import type { GapAnalysisOptions } from './gap-analysis.js';
import type { FinalReviewOptions } from './final-review.js';

export type OrchestratorArgs = {
  readonly planPath: string;
  readonly automatic: boolean;
  readonly skipFingerprint: boolean;
  readonly noInteraction: boolean;
  readonly groupFilter?: string;
};

export type OrchestratorDeps = {
  readonly parsePlan: (path: string) => Promise<readonly Group[]>;
  readonly runFingerprint: () => Promise<FingerprintResult>;
  readonly loadState: (path: string) => Promise<OrchestratorState>;
  readonly clearState: (path: string) => Promise<void>;
  readonly captureRef: (cwd: string) => Promise<string>;
  readonly hasChanges: (cwd: string, since: string) => Promise<boolean>;
  readonly processSlices: (opts: SlicePipelineOptions, deps: unknown) => Promise<void>;
  readonly runGapAnalysis: (opts: GapAnalysisOptions, deps: unknown) => Promise<void>;
  readonly runFinalReview: (opts: FinalReviewOptions, deps: unknown) => Promise<void>;
  readonly promptContinue: (nextGroup: string) => Promise<boolean>;
  readonly log: (message: string) => void;
};

const STATE_PATH = '.orchestrator-state.json';
const CWD = '.';
const MAX_REVIEW_CYCLES = 3;
const DEFAULTS: FingerprintResult = { brief: '', profile: {} };

export const resolveStartGroup = (groups: readonly Group[], filter?: string): number => {
  if (!filter) return 0;
  const lower = filter.toLowerCase();
  return groups.findIndex(g => g.name.toLowerCase() === lower);
};

export const runOrchestrator = async (
  args: OrchestratorArgs,
  deps: OrchestratorDeps,
): Promise<void> => {
  const { planPath, automatic, skipFingerprint, noInteraction, groupFilter } = args;
  const interactive = !noInteraction;
  const suppressPrompts = automatic || noInteraction;

  // Parse plan
  const groups = await deps.parsePlan(planPath);
  if (groups.length === 0) {
    deps.log('No groups found in plan — terminating');
    return;
  }

  // Fingerprint
  let fingerprint = DEFAULTS;
  if (skipFingerprint) {
    deps.log('Skipping fingerprint — no codebase brief or profile available');
  } else {
    fingerprint = await deps.runFingerprint();
  }

  const { brief, profile } = fingerprint;

  // Load state
  const state = await deps.loadState(STATE_PATH);

  // Resolve starting group
  const startIndex = resolveStartGroup(groups, groupFilter);
  if (startIndex === -1) {
    const available = groups.map(g => g.name).join(', ');
    deps.log(`Group "${groupFilter}" not found. Available groups: ${available}`);
    return;
  }

  // Capture run baseline
  const runBaseline = await deps.captureRef(CWD);

  // Process groups
  const remainingGroups = groups.slice(startIndex);
  let completed = true;

  for (let i = 0; i < remainingGroups.length; i++) {
    const group = remainingGroups[i];
    const isFirst = i === 0;

    if (!isFirst) {
      deps.log(`Session compaction before group: ${group.name}`);
    }

    deps.log(`Starting group: ${group.name}`);

    // Capture per-group baseline for gap analysis
    const groupBaseline = await deps.captureRef(CWD);

    // Process slices
    await deps.processSlices({
      slices: group.slices,
      state,
      statePath: STATE_PATH,
      profile,
      brief,
      cwd: CWD,
      interactive,
      maxReviewCycles: MAX_REVIEW_CYCLES,
    }, deps);

    // Gap analysis
    await deps.runGapAnalysis({
      slices: group.slices,
      baseline: groupBaseline,
      profile,
      cwd: CWD,
      maxReviewCycles: MAX_REVIEW_CYCLES,
    }, deps);

    // Inter-group transition (not after last group)
    if (i < remainingGroups.length - 1 && !suppressPrompts) {
      const next = remainingGroups[i + 1];
      const proceed = await deps.promptContinue(next.name);
      if (!proceed) {
        deps.log(`Operator declined. To resume, use --group "${next.name}"`);
        completed = false;
        break;
      }
    }
  }

  if (!completed) return;

  // Final review
  const runChanged = await deps.hasChanges(CWD, runBaseline);
  if (runChanged) {
    const planContent = groups.map(g => g.slices.map(s => s.content).join('\n\n')).join('\n\n---\n\n');
    await deps.runFinalReview({
      runBaseline,
      planContent,
      profile,
      cwd: CWD,
      maxReviewCycles: MAX_REVIEW_CYCLES,
    }, deps);
  }

  // Cleanup — silently ignore failures (e.g. EACCES)
  try {
    await deps.clearState(STATE_PATH);
  } catch {
    // Spec: state file cleanup failure is silently ignored
  }
  deps.log('Orchestration complete');
};
