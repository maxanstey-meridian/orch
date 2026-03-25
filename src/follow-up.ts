import type { AgentProcess, AgentResult } from './agent.js';

const AUTONOMY_MESSAGE = 'No further input from the operator. Proceed autonomously using your best judgement.';

export type FollowUpDeps = {
  readonly promptOperator: () => Promise<string>;
};

export type FollowUpOptions = {
  readonly agent: AgentProcess;
  readonly result: AgentResult;
  readonly deps: FollowUpDeps;
  readonly interactive?: boolean;
  readonly maxFollowUps?: number;
};

export const handleFollowUps = async (opts: FollowUpOptions): Promise<AgentResult> => {
  const { agent, deps, interactive = true, maxFollowUps = 3 } = opts;
  let current = opts.result;

  for (let i = 0; i < maxFollowUps && current.needsInput && interactive; i++) {
    const response = await deps.promptOperator();
    const message = response || AUTONOMY_MESSAGE;
    current = await agent.send(message);
  }

  return current;
};
