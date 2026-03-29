import { readFile } from "fs/promises";
import { parsePlanJson } from "./plan-schema.js";

export type { Slice, Group, FileAction } from "../domain/plan.js";

export const parsePlan = async (filePath: string): Promise<readonly import("../domain/plan.js").Group[]> => {
  const text = await readFile(filePath, "utf-8");
  return parsePlanJson(text, filePath);
};
