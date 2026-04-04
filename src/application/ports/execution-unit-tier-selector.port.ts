import type { ExecutionMode } from "#domain/config.js";
import type { ComplexityTriageResult } from "#domain/triage.js";
import type { ExecutionUnitKind } from "./execution-unit-triager.port.js";

export type ExecutionUnitTierInput = {
  readonly mode: ExecutionMode;
  readonly unitKind: ExecutionUnitKind;
  readonly content: string;
};

export abstract class ExecutionUnitTierSelector {
  abstract select(input: ExecutionUnitTierInput): Promise<ComplexityTriageResult>;
}
