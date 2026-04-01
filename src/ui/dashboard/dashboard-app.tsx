import { Box, Text } from "ink";
import React, { useState } from "react";
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
  const { model, loading, error } = useDashboardData(registryPath, queuePath, intervalMs);

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
      model={model}
      onOpenDetail={(runId) => {
        setViewState({ view: "detail", runId });
      }}
      onOpenTail={(runId) => {
        setViewState({ view: "tail", runId, returnTo: "main" });
      }}
      onKill={() => {}}
    />
  );
};
