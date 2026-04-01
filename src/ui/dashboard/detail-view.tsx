import { Box, Text, useInput } from "ink";
import React from "react";
import type { DashboardRun } from "#domain/dashboard.js";

type DetailViewProps = {
  readonly run: DashboardRun;
  readonly onBack: () => void;
  readonly onTail: () => void;
};

type SliceStatus = NonNullable<DashboardRun["groups"]>[number]["slices"][number]["status"];

const formatHeaderValue = (value: string | undefined): string => value ?? "-";

const getStatusPresentation = (
  status: SliceStatus,
): { readonly symbol: string; readonly color?: string; readonly dimColor?: boolean } => {
  switch (status) {
    case "done":
      return { symbol: "✓", color: "green" };
    case "active":
      return { symbol: "▶", color: "cyan" };
    case "pending":
      return { symbol: "○", dimColor: true };
    case "failed":
      return { symbol: "✗", color: "red" };
  }
};

export const DetailView = ({ run, onBack, onTail }: DetailViewProps) => {
  useInput((input, key) => {
    if (key.escape) {
      onBack();
      return;
    }

    if (input === "f") {
      onTail();
      return;
    }

    if (input === "k" && run.pid > 0) {
      process.kill(run.pid, "SIGTERM");
    }
  });

  return (
    <Box flexDirection="column">
      <Text>{`Plan: ${formatHeaderValue(run.planName)}`}</Text>
      <Text>{`Branch: ${formatHeaderValue(run.branch)}`}</Text>
      <Text>{`Started: ${formatHeaderValue(run.startedAt)}`}</Text>
      <Text>{`Elapsed: ${run.elapsed}`}</Text>
      {run.groups === undefined || run.groups.length === 0 ? (
        <Text>No plan details available</Text>
      ) : (
        run.groups.map((group) => (
          <Box
            key={group.name}
            flexDirection="column"
            marginTop={1}
          >
            <Text>{group.name}</Text>
            {group.slices.map((slice) => {
              const presentation = getStatusPresentation(slice.status);

              return (
                <Text key={slice.number}>
                  <Text
                    color={presentation.color}
                    dimColor={presentation.dimColor}
                  >
                    {presentation.symbol}
                  </Text>
                  {` S${slice.number} ${slice.title}${slice.elapsed === undefined ? "" : ` ${slice.elapsed}`}`}
                </Text>
              );
            })}
          </Box>
        ))
      )}
    </Box>
  );
};
