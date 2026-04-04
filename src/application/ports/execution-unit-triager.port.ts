import type { ExecutionMode } from "#domain/config.js";
import type { BoundaryTriageResult } from "#domain/triage.js";

export type ExecutionUnitKind = "slice" | "group" | "direct";

export type ExecutionUnitTriageInput = {
  readonly mode: ExecutionMode;
  readonly unitKind: ExecutionUnitKind;
  readonly diff: string;
  readonly diffStats: {
    readonly added: number;
    readonly removed: number;
    readonly total: number;
  };
  readonly reviewThreshold: number;
  readonly finalBoundary: boolean;
  readonly moreUnitsInGroup: boolean;
  readonly pending: {
    readonly verify: boolean;
    readonly completeness: boolean;
    readonly review: boolean;
    readonly gap: boolean;
  };
};

export abstract class ExecutionUnitTriager {
  abstract decide(input: ExecutionUnitTriageInput): Promise<BoundaryTriageResult>;
}
