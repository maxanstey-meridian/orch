import type { AgentSpawner } from "#application/ports/agent-spawner.port.js";
import type {
  ExecutionUnitTierInput,
  ExecutionUnitTierSelector,
} from "#application/ports/execution-unit-tier-selector.port.js";
import type { OrchestratorConfig } from "#domain/config.js";
import { COMPLEXITY_TRIAGE_FALLBACK, type ComplexityTriageResult } from "#domain/triage.js";
import { buildComplexityTriagePrompt, parseComplexityTriageResult } from "./complexity-triage.js";

export class AgentExecutionUnitTierSelector implements ExecutionUnitTierSelector {
  constructor(
    private readonly agents: AgentSpawner,
    private readonly config: OrchestratorConfig,
  ) {}

  async select(input: ExecutionUnitTierInput): Promise<ComplexityTriageResult> {
    if (input.content.trim().length === 0) {
      return {
        ...COMPLEXITY_TRIAGE_FALLBACK,
        reason: `${COMPLEXITY_TRIAGE_FALLBACK.reason}: empty ${input.unitKind} content`,
      };
    }

    try {
      const agent = this.agents.spawn("triage", { cwd: this.config.cwd });
      const result = await agent.send(buildComplexityTriagePrompt(input.content));
      agent.kill();
      const triageText =
        result.assistantText.trim().length > 0 ? result.assistantText : result.resultText;
      return parseComplexityTriageResult(triageText);
    } catch {
      return COMPLEXITY_TRIAGE_FALLBACK;
    }
  }
}
