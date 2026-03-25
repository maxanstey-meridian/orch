import { readFile, writeFile, rm } from 'fs/promises';

export type OrchestratorState = {
  readonly implSessionId?: string;
  readonly reviewSessionId?: string;
  readonly gapSessionId?: string;
  readonly lastCompletedSlice?: number;
};

export const loadState = async (filePath: string): Promise<OrchestratorState> => {
  try {
    const text = await readFile(filePath, 'utf-8');
    return JSON.parse(text) as OrchestratorState;
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
