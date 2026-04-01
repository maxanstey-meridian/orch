import type { QueueEntry } from "#domain/queue.js";
import type { PersistedPhase } from "#domain/state.js";

export type DashboardRun = {
  readonly id: string;
  readonly repo: string;
  readonly branch?: string;
  readonly planName?: string;
  readonly startedAt?: string;
  readonly status: "active" | "dead" | "completed" | "failed";
  readonly sliceProgress: string;
  readonly currentPhase?: PersistedPhase;
  readonly elapsed: string;
  readonly pid: number;
  readonly logPath?: string;
  readonly groups?: Array<{
    readonly name: string;
    readonly slices: Array<{
      readonly number: number;
      readonly title: string;
      readonly status: "done" | "active" | "pending" | "failed";
      readonly elapsed?: string;
    }>;
  }>;
};

export type DashboardModel = {
  readonly active: DashboardRun[];
  readonly queued: QueueEntry[];
  readonly completed: DashboardRun[];
};
