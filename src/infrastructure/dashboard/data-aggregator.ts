import { basename } from "path";
import type { DashboardRun } from "#domain/dashboard.js";
import type { DashboardModel } from "#domain/dashboard.js";
import type { Group } from "#domain/plan.js";
import type { RunEntry } from "#domain/registry.js";
import type { OrchestratorState } from "#domain/state.js";
import { parsePlan } from "#infrastructure/plan/plan-parser.js";
import { readQueue } from "#infrastructure/queue/queue-store.js";
import { pruneDeadEntries } from "#infrastructure/registry/run-registry.js";
import { loadState } from "#infrastructure/state/state.js";

const countSlices = (groups: readonly Group[]): number =>
  groups.reduce((total, group) => total + group.slices.length, 0);

const compareStartedAtAscending = (left: RunEntry, right: RunEntry): number =>
  new Date(left.startedAt).getTime() - new Date(right.startedAt).getTime();

const compareStartedAtDescending = (left: RunEntry, right: RunEntry): number =>
  new Date(right.startedAt).getTime() - new Date(left.startedAt).getTime();

const planNameFromPath = (planPath: string): string => basename(planPath, ".json");

const resolvePlanName = (groups: readonly Group[], planPath: string): string =>
  groups[0]?.name ?? planNameFromPath(planPath);

const buildSliceProgress = (lastCompletedSlice: number | undefined, totalSlices: number): string =>
  `S${lastCompletedSlice ?? 0}/${totalSlices}`;

const formatElapsedMs = (elapsedMs: number): string => {
  const elapsedMinutes = Math.floor(elapsedMs / 60_000);

  if (elapsedMinutes < 1) {
    return "<1m";
  }

  if (elapsedMinutes < 60) {
    return `${elapsedMinutes}m`;
  }

  const elapsedHours = Math.floor(elapsedMinutes / 60);
  const remainingMinutes = elapsedMinutes % 60;
  if (elapsedHours < 24) {
    return remainingMinutes === 0 ? `${elapsedHours}h` : `${elapsedHours}h ${remainingMinutes}m`;
  }

  const elapsedDays = Math.floor(elapsedHours / 24);
  const remainingHours = elapsedHours % 24;
  return remainingHours === 0 ? `${elapsedDays}d` : `${elapsedDays}d ${remainingHours}h`;
};

const sliceElapsed = (state: OrchestratorState, sliceNumber: number): string | undefined => {
  const timing = state.sliceTimings?.find((entry) => entry.number === sliceNumber);
  if (timing === undefined) {
    return undefined;
  }

  const endTime = timing.completedAt ?? new Date().toISOString();
  return formatElapsedMs(new Date(endTime).getTime() - new Date(timing.startedAt).getTime());
};

const projectGroups = (
  groups: readonly Group[],
  state: OrchestratorState,
): DashboardRun["groups"] =>
  groups.map((group) => ({
    name: group.name,
    slices: group.slices.map((slice) => {
      const status =
        slice.number <= (state.lastCompletedSlice ?? 0)
          ? "done"
          : state.currentPhase !== undefined && state.currentSlice === slice.number
            ? "active"
            : "pending";
      const elapsed =
        state.sliceTimings === undefined ? undefined : sliceElapsed(state, slice.number);

      return {
        number: slice.number,
        title: slice.title,
        status,
        ...(elapsed === undefined ? {} : { elapsed }),
      };
    }),
  }));

const loadStateSafely = async (statePath: string): Promise<OrchestratorState> => {
  try {
    return await loadState(statePath);
  } catch {
    return {};
  }
};

const loadPlanSafely = async (
  planPath: string,
): Promise<{
  readonly groups?: readonly Group[];
  readonly totalSlices: number;
  readonly planName: string;
}> => {
  try {
    const groups = await parsePlan(planPath);
    return {
      groups,
      totalSlices: countSlices(groups),
      planName: resolvePlanName(groups, planPath),
    };
  } catch {
    return {
      planName: planNameFromPath(planPath),
      totalSlices: 0,
    };
  }
};

const buildRun = async (entry: RunEntry, status: DashboardRun["status"]): Promise<DashboardRun> => {
  const [state, plan] = await Promise.all([
    loadStateSafely(entry.statePath),
    loadPlanSafely(entry.planPath),
  ]);
  const startedAt = state.startedAt ?? entry.startedAt;

  return {
    id: entry.id,
    repo: entry.repo,
    branch: entry.branch,
    planName: plan.planName,
    status,
    sliceProgress: buildSliceProgress(state.lastCompletedSlice, plan.totalSlices),
    currentPhase: state.currentPhase,
    elapsed: formatElapsed(startedAt),
    pid: entry.pid,
    ...(plan.groups === undefined ? {} : { groups: projectGroups(plan.groups, state) }),
  };
};

const buildCompletedRun = async (entry: RunEntry): Promise<DashboardRun> => {
  const [state, plan] = await Promise.all([
    loadStateSafely(entry.statePath),
    loadPlanSafely(entry.planPath),
  ]);
  const status =
    plan.groups === undefined
      ? "failed"
      : (state.lastCompletedSlice ?? 0) === plan.totalSlices
        ? "completed"
        : "failed";
  const startedAt = state.startedAt ?? entry.startedAt;

  return {
    id: entry.id,
    repo: entry.repo,
    branch: entry.branch,
    planName: plan.planName,
    status,
    sliceProgress: buildSliceProgress(state.lastCompletedSlice, plan.totalSlices),
    currentPhase: state.currentPhase,
    elapsed: formatElapsed(startedAt),
    pid: entry.pid,
    ...(plan.groups === undefined ? {} : { groups: projectGroups(plan.groups, state) }),
  };
};

export const formatElapsed = (startIso: string): string => {
  return formatElapsedMs(Date.now() - new Date(startIso).getTime());
};

export const aggregateDashboard = async (
  registryPath: string,
  queuePath: string,
): Promise<DashboardModel> => {
  const [{ alive, dead }, queued] = await Promise.all([
    pruneDeadEntries(registryPath),
    readQueue(queuePath),
  ]);

  return {
    active: await Promise.all(
      [...alive].sort(compareStartedAtAscending).map((entry) => buildRun(entry, "active")),
    ),
    queued,
    completed: await Promise.all(
      [...dead].sort(compareStartedAtDescending).map((entry) => buildCompletedRun(entry)),
    ),
  };
};
