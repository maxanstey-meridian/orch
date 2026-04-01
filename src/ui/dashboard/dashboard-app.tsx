import { defaultQueuePath, removeFromQueue } from "#infrastructure/queue/queue-store.js";
import { defaultRegistryPath } from "#infrastructure/registry/run-registry.js";
import { render, Text } from "ink";
import React, { useEffect, useMemo, useState } from "react";
import type { DashboardRun } from "#domain/dashboard.js";
import { DetailView } from "#ui/dashboard/detail-view.js";
import { MainView } from "#ui/dashboard/main-view.js";
import { QueuePrompt } from "#ui/dashboard/queue-prompt.js";
import { TailView } from "#ui/dashboard/tail-view.js";
import { useDashboardData } from "#ui/dashboard/use-dashboard-data.js";

export type ViewState =
  | { readonly view: "main" }
  | { readonly view: "queue" }
  | { readonly view: "detail"; readonly runId: string }
  | { readonly view: "tail"; readonly runId: string; readonly returnTo: "main" | "detail" };

export type DashboardAppProps = {
  readonly registryPath: string;
  readonly queuePath: string;
  readonly intervalMs?: number;
};

const runEndedDwellMs = 1_500;

const findDetailRun = (runs: readonly DashboardRun[], runId: string): DashboardRun | undefined =>
  runs.find((run) => run.id === runId);

const findTailRun = (model: {
  readonly active: readonly DashboardRun[];
  readonly completed: readonly DashboardRun[];
}, runId: string): DashboardRun | undefined =>
  [...model.active, ...model.completed].find((run) => run.id === runId);

const RunEndedView = ({ onReturn }: { readonly onReturn: () => void }) => {
  useEffect(() => {
    const timeoutId = setTimeout(() => {
      onReturn();
    }, runEndedDwellMs);

    return () => {
      clearTimeout(timeoutId);
    };
  }, [onReturn]);

  return <Text>Run ended</Text>;
};

export const DashboardApp = ({
  registryPath,
  queuePath,
  intervalMs,
}: DashboardAppProps) => {
  const [viewState, setViewState] = useState<ViewState>({ view: "main" });
  const [tailLogPath, setTailLogPath] = useState<string | undefined>(undefined);
  const [dismissedRowIds, setDismissedRowIds] = useState<string[]>([]);
  const { model, loading, error, refresh } = useDashboardData(registryPath, queuePath, intervalMs);
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

  if (viewState.view === "queue") {
    return (
      <QueuePrompt
        queuePath={queuePath}
        onCancel={() => {
          setViewState({ view: "main" });
        }}
        onDone={() => {
          refresh();
          setViewState({ view: "main" });
        }}
      />
    );
  }

  if (viewState.view === "detail") {
    const selectedRun = findDetailRun(
      [...visibleModel.active, ...visibleModel.completed],
      viewState.runId,
    );
    if (selectedRun === undefined) {
      return <RunEndedView onReturn={() => setViewState({ view: "main" })} />;
    }

    return (
      <DetailView
        run={selectedRun}
        onBack={() => {
          setViewState({ view: "main" });
        }}
        onTail={() => {
          setTailLogPath(selectedRun.logPath);
          setViewState({ view: "tail", runId: selectedRun.id, returnTo: "detail" });
        }}
      />
    );
  }

  if (viewState.view === "tail") {
    const returnToView = (): void => {
      if (viewState.returnTo === "detail") {
        setViewState({ view: "detail", runId: viewState.runId });
        return;
      }

      setViewState({ view: "main" });
    };

    return (
      <TailView
        logPath={tailLogPath}
        runId={viewState.runId}
        onBack={returnToView}
      />
    );
  }

  return (
    <MainView
      model={visibleModel}
      onOpenDetail={(runId) => {
        setViewState({ view: "detail", runId });
      }}
      onOpenTail={(runId) => {
        setTailLogPath(findTailRun(visibleModel, runId)?.logPath);
        setViewState({ view: "tail", runId, returnTo: "main" });
      }}
      onOpenQueue={() => {
        setViewState({ view: "queue" });
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

export const renderDashboard = async (
  props: Partial<DashboardAppProps> = {},
): Promise<void> => {
  const instance = render(
    <DashboardApp
      registryPath={props.registryPath ?? defaultRegistryPath()}
      queuePath={props.queuePath ?? defaultQueuePath()}
      intervalMs={props.intervalMs}
    />,
  );

  await instance.waitUntilExit();
};
