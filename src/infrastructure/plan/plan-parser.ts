import { readFile } from "fs/promises";
import type { PlanDocument } from "#domain/plan.js";
import { parsePlanDocumentJson, parsePlanJson } from "./plan-schema.js";

export type { Slice, Group, FileAction } from "#domain/plan.js";

export const parsePlanDocument = async (filePath: string): Promise<PlanDocument> => {
  const text = await readFile(filePath, "utf-8");
  return parsePlanDocumentJson(text, filePath);
};

export const parsePlan = async (
  filePath: string,
): Promise<readonly import("../../domain/plan.js").Group[]> => {
  const text = await readFile(filePath, "utf-8");
  return parsePlanJson(text, filePath);
};
