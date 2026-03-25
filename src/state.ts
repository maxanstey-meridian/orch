import { readFile, writeFile, rm } from 'fs/promises';

export type OrchestratorState = {
  readonly lastCompletedSlice?: number;
};

const parseState = (text: string): OrchestratorState => {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
  const obj = parsed as Record<string, unknown>;
  return {
    ...(typeof obj.lastCompletedSlice === 'number' && Number.isFinite(obj.lastCompletedSlice) && obj.lastCompletedSlice >= 0
      ? { lastCompletedSlice: obj.lastCompletedSlice }
      : {}),
  };
};

export const loadState = async (filePath: string): Promise<OrchestratorState> => {
  try {
    const text = await readFile(filePath, 'utf-8');
    return parseState(text);
  } catch {
    return {};
  }
};

export const saveState = async (filePath: string, state: OrchestratorState): Promise<void> => {
  await writeFile(filePath, JSON.stringify(state, null, 2));
};

export const clearState = async (filePath: string): Promise<void> => {
  await rm(filePath, { force: true });
};
