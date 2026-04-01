import { Box, Text, useInput } from "ink";
import React from "react";
import { useLogTail } from "#ui/dashboard/use-log-tail.js";

type TailViewProps = {
  readonly logPath?: string;
  readonly runId: string;
  readonly onBack: () => void;
};

const fallbackTerminalRows = 24;
const headerRows = 3;

export const TailView = ({ logPath, runId, onBack }: TailViewProps) => {
  const { lines, error } = useLogTail(logPath);
  const visibleLineCount = Math.max((process.stdout.rows ?? fallbackTerminalRows) - headerRows, 1);
  const visibleLines = lines.slice(-visibleLineCount);
  const fillerLineCount = Math.max(visibleLineCount - visibleLines.length, 0);

  useInput((_input, key) => {
    if (key.escape) {
      onBack();
    }
  });

  return (
    <Box flexDirection="column">
      <Text>{`Tail: ${runId}`}</Text>
      <Text>{`Log: ${logPath ?? "-"}`}</Text>
      <Box
        flexDirection="column"
        height={visibleLineCount}
      >
        {error !== undefined ? (
          <Text>{error}</Text>
        ) : visibleLines.length === 0 ? (
          <Text>No log output yet</Text>
        ) : (
          <>
            {Array.from({ length: fillerLineCount }, (_, index) => (
              <Text key={`tail-filler-${index}`}> </Text>
            ))}
            {visibleLines.map((line, index) => (
              <Text key={`${index}-${line}`}>{line}</Text>
            ))}
          </>
        )}
      </Box>
    </Box>
  );
};
