export type QueueEntry = {
  id: string;
  repo: string;
  planPath: string;
  branch?: string;
  flags: string[];
  addedAt: string;
};
