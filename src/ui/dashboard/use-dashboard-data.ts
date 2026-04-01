import { useEffect, useState } from "react";
import type { DashboardModel } from "#domain/dashboard.js";
import { aggregateDashboard } from "#infrastructure/dashboard/data-aggregator.js";

const emptyModel: DashboardModel = {
  active: [],
  queued: [],
  completed: [],
};

export const useDashboardData = (
  registryPath: string,
  queuePath: string,
  intervalMs = 1_000,
): { model: DashboardModel; loading: boolean; error?: string } => {
  const [model, setModel] = useState<DashboardModel>(emptyModel);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    let latestRequestId = 0;

    const load = async (): Promise<void> => {
      const requestId = latestRequestId + 1;
      latestRequestId = requestId;

      try {
        const nextModel = await aggregateDashboard(registryPath, queuePath);
        if (cancelled || requestId !== latestRequestId) {
          return;
        }

        setModel(nextModel);
        setLoading(false);
        setError(undefined);
      } catch (loadError: unknown) {
        if (cancelled || requestId !== latestRequestId) {
          return;
        }

        setLoading(false);
        setError(loadError instanceof Error ? loadError.message : String(loadError));
      }
    };

    void load();
    const intervalId = setInterval(() => {
      void load();
    }, intervalMs);

    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [intervalMs, queuePath, registryPath]);

  return { model, loading, error };
};
