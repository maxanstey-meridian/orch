export type QueueEntry = {
  readonly id: string;
  readonly repo: string;
  readonly planPath: string;
  readonly branch?: string;
  readonly flags: readonly string[];
  readonly addedAt: string;
};
