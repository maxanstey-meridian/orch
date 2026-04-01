export type RunEntry = {
  readonly id: string;
  readonly pid: number;
  readonly repo: string;
  readonly planPath: string;
  readonly statePath: string;
  readonly branch?: string;
  readonly startedAt: string;
};
