import { type AgentResult, runAgentQuiet } from './agent.js';

export const extractFindings = (result: AgentResult): string => {
  return result.assistantText;
};

export const extractFormattedFindings = async (opts: {
  readonly prompt: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly sessionId: string;
}): Promise<string> => {
  try {
    return await runAgentQuiet(opts);
  } catch {
    return '';
  }
};
