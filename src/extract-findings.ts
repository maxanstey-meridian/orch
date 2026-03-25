import { type AgentProcess, type AgentResult } from './agent.js';

export const extractFindings = (result: AgentResult): string => {
  return result.assistantText;
};

export const extractFormattedFindings = async (
  agent: AgentProcess,
  prompt: string,
): Promise<string> => {
  try {
    return await agent.sendQuiet(prompt);
  } catch {
    return '';
  }
};
