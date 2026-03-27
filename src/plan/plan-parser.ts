import { readFile } from "fs/promises";
import type { FileAction } from "./plan-schema.js";
import { parsePlanJson } from "./plan-schema.js";

export type Slice = {
  readonly number: number;
  readonly title: string;
  readonly content: string;
  readonly why: string;
  readonly files: readonly FileAction[];
  readonly details: string;
  readonly tests: string;
};

export type Group = {
  readonly name: string;
  readonly slices: readonly Slice[];
};

export const parsePlan = async (filePath: string): Promise<readonly Group[]> => {
  const text = await readFile(filePath, "utf-8");
  return parsePlanJson(text, filePath);
};
