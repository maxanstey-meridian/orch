import { type AgentResult } from './agent.js';

export const extractFindings = (result: AgentResult): string => {
  return result.assistantText;
};
