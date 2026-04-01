import { removeFromQueue } from "#infrastructure/queue/queue-store.js";
import { Box, Text } from "ink";
import React, { useMemo, useState } from "react";
import { MainView } from "#ui/dashboard/main-view.js";
import { useDashboardData } from "#ui/dashboard/use-dashboard-data.js";

export type ViewState =
  | { readonly view: "main" }
  | { readonly view: "detail"; readonly runId: string }
  | { readonly view: "tail"; readonly runId: string; readonly returnTo: "main" | "detail" };

export type DashboardAppProps = {
  readonly registryPath: string;
  readonly queuePath: string;
  readonly intervalMs?: number;
};

export const DashboardApp = ({
  registryPath,
  queuePath,
  intervalMs,
}: DashboardAppProps) => {
  const [viewState, setViewState] = useState<ViewState>({ view: "main" });
  const [dismissedRowIds, setDismissedRowIds] = useState<string[]>([]);
  const { model, loading, error } = useDashboardData(registryPath, queuePath, intervalMs);
  const visibleModel = useMemo(
    () => ({
      active: model.active,
      queued: model.queued.filter((entry) => !dismissedRowIds.includes(entry.id)),
      completed: model.completed.filter((run) => !dismissedRowIds.includes(run.id)),
    }),
    [dismissedRowIds, model],
  );

  if (loading) {
    return <Text>Loading dashboard…</Text>;
  }

  if (error !== undefined) {
    return <Text>{`Dashboard error: ${error}`}</Text>;
  }

  if (viewState.view === "detail") {
    return (
      <Box flexDirection="column">
        <Text>{`Detail placeholder: ${viewState.runId}`}</Text>
      </Box>
    );
  }

  if (viewState.view === "tail") {
    return (
      <Box flexDirection="column">
        <Text>{`Tail placeholder: ${viewState.runId}`}</Text>
      </Box>
    );
  }

  return (
    <MainView
      model={visibleModel}
      onOpenDetail={(runId) => {
        setViewState({ view: "detail", runId });
      }}
      onOpenTail={(runId) => {
        setViewState({ view: "tail", runId, returnTo: "main" });
      }}
      onDelete={(rowId) => {
        setDismissedRowIds((currentIds) =>
          currentIds.includes(rowId) ? currentIds : [...currentIds, rowId],
        );

        if (model.queued.some((entry) => entry.id === rowId)) {
          void removeFromQueue(queuePath, rowId);
        }
      }}
    />
  );
};
