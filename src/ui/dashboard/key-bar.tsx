import { Box, Text } from "ink";
import React from "react";

export type KeyBarProps = {
  readonly text?: string;
};

const defaultKeyBarText = "↑↓ navigate  ⏎ detail  f tail  q queue  k kill";

export const KeyBar = ({ text = defaultKeyBarText }: KeyBarProps) => (
  <Box marginTop={1}>
    <Text dimColor>{text}</Text>
  </Box>
);
