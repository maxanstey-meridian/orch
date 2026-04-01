import { homedir } from "os";
import { basename } from "path";
import { Box, Text, useInput } from "ink";
import React, { useEffect, useMemo, useRef, useState } from "react";
import type { DashboardModel } from "#domain/dashboard.js";
import type { DashboardRun } from "#domain/dashboard.js";
import type { QueueEntry } from "#domain/queue.js";
import { KeyBar } from "#ui/dashboard/key-bar.js";

export type MainViewProps = {
  readonly model: DashboardModel;
  readonly onOpenDetail: (runId: string) => void;
  readonly onOpenTail: (runId: string) => void;
  readonly onDelete?: (rowId: string) => void;
};

const Section = ({
  title,
  children,
}: {
  readonly title: string;
  readonly children: React.ReactNode;
}) => (
  <Box flexDirection="column">
    <Text>{title}</Text>
    {children}
  </Box>
);

const shortenId = (id: string): string => id.slice(0, 6);

const shortenRepo = (repoPath: string): string =>
  repoPath.startsWith(homedir()) ? `~${repoPath.slice(homedir().length)}` : repoPath;

const statusSymbol = (status: DashboardRun["status"]): string => {
  switch (status) {
    case "active":
      return "●";
    case "completed":
      return "✓";
    case "failed":
      return "✗";
    case "dead":
      return "!";
  }
};

const buildRunLabel = (run: DashboardRun): string =>
  `${statusSymbol(run.status)} ${shortenId(run.id)} ${shortenRepo(run.repo)} ${run.branch ?? run.planName ?? "-"} ${run.sliceProgress} ${run.currentPhase ?? "-"} ${run.elapsed}`;

const buildQueueLabel = (entry: QueueEntry): string =>
  `○ ${shortenId(entry.id)} ${shortenRepo(entry.repo)} ${entry.branch ?? basename(entry.planPath, ".json")} - - -`;

type RenderableRow =
  | {
      readonly kind: "run";
      readonly id: string;
      readonly label: string;
      readonly run: DashboardRun;
    }
  | {
      readonly kind: "queue";
      readonly id: string;
      readonly label: string;
      readonly queueEntry: QueueEntry;
    };

type SectionRows = {
  readonly title: string;
  readonly rows: RenderableRow[];
};

const buildSections = (model: DashboardModel): SectionRows[] => [
  {
    title: "Active",
    rows: model.active.map((run) => ({
      kind: "run",
      id: run.id,
      label: buildRunLabel(run),
      run,
    })),
  },
  {
    title: "Queued",
    rows: model.queued.map((entry) => ({
      kind: "queue",
      id: entry.id,
      label: buildQueueLabel(entry),
      queueEntry: entry,
    })),
  },
  {
    title: "Completed",
    rows: model.completed.map((run) => ({
      kind: "run",
      id: run.id,
      label: buildRunLabel(run),
      run,
    })),
  },
];

export const MainView = ({ model, onOpenDetail, onOpenTail, onDelete }: MainViewProps) => {
  const sections = useMemo(() => buildSections(model), [model]);
  const rows = useMemo(() => sections.flatMap((section) => section.rows), [sections]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const selectedRowRef = useRef<RenderableRow | undefined>(undefined);
  const isEmpty =
    model.active.length === 0 &&
    model.queued.length === 0 &&
    model.completed.length === 0;

  useEffect(() => {
    setSelectedIndex((currentIndex) => {
      if (rows.length === 0) {
        return 0;
      }

      return Math.min(currentIndex, rows.length - 1);
    });
  }, [rows.length]);

  useInput((input, key) => {
    if (rows.length === 0) {
      return;
    }

    const selectedRow = selectedRowRef.current;

    if (key.downArrow) {
      setSelectedIndex((currentIndex) => Math.min(currentIndex + 1, rows.length - 1));
      return;
    }

    if (key.upArrow) {
      setSelectedIndex((currentIndex) => Math.max(currentIndex - 1, 0));
      return;
    }

    if (key.return && selectedRow?.kind === "run") {
      onOpenDetail(selectedRow.id);
      return;
    }

    if (input === "f" && selectedRow?.kind === "run") {
      onOpenTail(selectedRow.id);
      return;
    }

    if (input === "k" && selectedRow?.kind === "run" && selectedRow.run.pid > 0) {
      process.kill(selectedRow.run.pid, "SIGTERM");
      return;
    }

    const isDeletableRow =
      selectedRow?.kind === "queue" ||
      (selectedRow?.kind === "run" && selectedRow.run.status !== "active");
    if (input === "d" && isDeletableRow) {
      onDelete?.(selectedRow.id);
    }
  });

  const selectedRow = rows[selectedIndex];
  selectedRowRef.current = selectedRow;

  let rowIndex = -1;
  const renderSectionRow = (row: RenderableRow): React.ReactNode => {
    rowIndex += 1;
    const isSelected = rowIndex === selectedIndex;

    return (
      <Text
        key={row.id}
        bold={isSelected}
        inverse={isSelected}
      >
        {`${isSelected ? ">" : " "} ${row.label}`}
      </Text>
    );
  };

  return (
    <Box flexDirection="column">
      <Section title="Active">
        {sections[0]?.rows.length === 0 ? <Text>No runs to display</Text> : sections[0]?.rows.map(renderSectionRow)}
      </Section>
      <Section title="Queued">
        {sections[1]?.rows.length === 0 ? <Text>No runs to display</Text> : sections[1]?.rows.map(renderSectionRow)}
      </Section>
      <Section title="Completed">
        {sections[2]?.rows.length === 0 ? <Text>No runs to display</Text> : sections[2]?.rows.map(renderSectionRow)}
      </Section>
      {isEmpty ? <Text>No runs to display</Text> : null}
      <KeyBar />
    </Box>
  );
};
