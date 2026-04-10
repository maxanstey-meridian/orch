import {
  type CreditDecision,
  type GateDecision,
  OperatorGate,
  type VerifyDecision,
} from "#application/ports/operator-gate.port.js";
import { IncompleteRunError } from "#domain/errors.js";

const buildVerifyFailureMessage = (executionUnitLabel: string, summary: string): string =>
  `${executionUnitLabel} verification failed in auto mode: ${summary}`;

export class SilentOperatorGate implements OperatorGate {
  async confirmPlan(_planPreview: string): Promise<GateDecision> {
    return { kind: "accept" };
  }

  async verifyFailed(
    executionUnitLabel: string,
    summary: string,
    _retryable: boolean,
  ): Promise<VerifyDecision> {
    throw new IncompleteRunError(buildVerifyFailureMessage(executionUnitLabel, summary));
  }

  async creditExhausted(_label: string, _message: string): Promise<CreditDecision> {
    return { kind: "quit" };
  }

  async askUser(_prompt: string): Promise<string> {
    return "";
  }

  async confirmNextGroup(_groupLabel: string): Promise<boolean> {
    return true;
  }
}
