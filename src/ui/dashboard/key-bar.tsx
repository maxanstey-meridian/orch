import { Box, Text } from "ink";
import React from "react";

export type KeyBarProps = {
  readonly shortcuts: readonly string[];
};

export const KeyBar = ({ shortcuts }: KeyBarProps) => (
  <Box marginTop={1}>
    <Text>{`Keys: ${shortcuts.join(" | ")}`}</Text>
  </Box>
);
