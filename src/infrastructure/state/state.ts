import { readFile, writeFile, rm } from "fs/promises";
import { join } from "path";
import { z } from "zod";

export type { OrchestratorState } from "#domain/state.js";
import type { OrchestratorState } from "#domain/state.js";

const persistedPhases = ["tdd", "review", "verify", "gap", "final", "plan"] as const;
const providers = ["claude", "codex"] as const;
const executionModes = ["direct", "grouped", "sliced"] as const;

const persistedAgentSessionSchema = z.object({
  provider: z.enum(providers),
  id: z.string().min(1),
});

const stateSchema = z
  .object({
    startedAt: z.string().optional(),
    completedAt: z.string().optional(),
    executionMode: z.enum(executionModes).optional(),
    currentPhase: z.enum(persistedPhases).optional(),
    currentSlice: z.number().int().nonnegative().optional(),
    currentGroup: z.string().min(1).optional(),
    sliceTimings: z
      .array(
        z.object({
          number: z.number().int().nonnegative(),
          startedAt: z.string(),
          completedAt: z.string().optional(),
        }),
      )
      .optional(),
    lastCompletedSlice: z.number().int().nonnegative().optional(),
    lastCompletedGroup: z.string().min(1).optional(),
    lastSliceImplemented: z.number().int().nonnegative().optional(),
    reviewBaseSha: z.string().min(1).optional(),
    tddSession: persistedAgentSessionSchema.optional(),
    reviewSession: persistedAgentSessionSchema.optional(),
    tddSessionId: z.string().min(1).optional(),
    reviewSessionId: z.string().min(1).optional(),
    worktree: z
      .object({
        path: z.string().min(1),
        branch: z.string().min(1),
        baseSha: z.string().min(1),
      })
      .optional(),
  })
  .passthrough();

export const loadState = async (filePath: string): Promise<OrchestratorState> => {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }

  const result = stateSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(
      `Corrupt state file (${filePath}):\n${issues}\nDelete the file to start fresh, or use --reset.`,
    );
  }
  const { tddSessionId: _legacyTddSessionId, reviewSessionId: _legacyReviewSessionId, ...state } =
    result.data;
  return state;
};

export const saveState = async (filePath: string, state: OrchestratorState): Promise<void> => {
  await writeFile(filePath, JSON.stringify(state, null, 2));
};

export const clearState = async (filePath: string): Promise<void> => {
  await rm(filePath, { force: true });
};

export const statePathForPlan = (orchDir: string, planId: string): string =>
  join(orchDir, "state", `plan-${planId}.json`);
