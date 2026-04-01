import { Box, Text, useInput } from "ink";
import React from "react";
import type { DashboardRun } from "#domain/dashboard.js";
import { KeyBar } from "#ui/dashboard/key-bar.js";

type DetailViewProps = {
  readonly run: DashboardRun;
  readonly onBack: () => void;
  readonly onTail: () => void;
};

type SliceStatus = NonNullable<DashboardRun["groups"]>[number]["slices"][number]["status"];

const formatHeaderValue = (value: string | undefined): string => value ?? "-";

const isErrorWithCode = (value: unknown): value is { readonly code: string } =>
  typeof value === "object" &&
  value !== null &&
  "code" in value &&
  typeof value.code === "string";

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
    if (key.escape || key.leftArrow) {
      onBack();
      return;
    }

    if (input === "f") {
      onTail();
      return;
    }

    if (input === "k" && run.status === "active" && run.pid > 0) {
      try {
        process.kill(run.pid, "SIGTERM");
      } catch (error) {
        if (isErrorWithCode(error) && error.code === "ESRCH") {
          onBack();
          return;
        }

        throw error;
      }
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
      <KeyBar text="←/Esc back  f tail  k kill" />
    </Box>
  );
};
