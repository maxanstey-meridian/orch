import { readFile } from "fs/promises";
import type { FileAction } from "./plan-schema.js";

export type Slice = {
  readonly number: number;
  readonly title: string;
  readonly content: string;
  readonly why?: string;
  readonly files?: readonly FileAction[];
  readonly details?: string;
  readonly tests?: string;
};

export type Group = {
  readonly name: string;
  readonly slices: readonly Slice[];
};

const GROUP_RE = /^## Group:\s*(.+)$/;
const SLICE_RE = /^### (?:Slice|Phase)\s+(\d+)(?::\s*(.+))?$/;

export const parsePlanText = (text: string, source = "<text>"): readonly Group[] => {
  const lines = text.split("\n");

  const groups: { name: string; slices: Slice[] }[] = [];
  let currentGroup: { name: string; slices: Slice[] } | null = null;
  let currentSlice: { number: number; title: string; lines: string[] } | null = null;

  const flushSlice = () => {
    if (currentSlice && currentGroup) {
      currentGroup.slices.push({
        number: currentSlice.number,
        title: currentSlice.title,
        content: currentSlice.lines.join("\n").trimEnd(),
      });
      currentSlice = null;
    }
  };

  for (const line of lines) {
    const groupMatch = line.match(GROUP_RE);
    if (groupMatch) {
      flushSlice();
      currentGroup = { name: groupMatch[1].trim(), slices: [] };
      groups.push(currentGroup);
      continue;
    }

    const sliceMatch = line.match(SLICE_RE);
    if (sliceMatch && currentGroup) {
      flushSlice();
      const num = parseInt(sliceMatch[1], 10);
      const title = sliceMatch[2]?.trim() || `Slice ${num}`;
      currentSlice = { number: num, title, lines: [line] };
      continue;
    }

    if (currentSlice) {
      currentSlice.lines.push(line);
    }
  }

  flushSlice();

  if (groups.length === 0) {
    throw new Error(`No groups found in plan: ${source}`);
  }

  // Validate globally unique slice numbers
  const seen = new Set<number>();
  for (const group of groups) {
    for (const slice of group.slices) {
      if (seen.has(slice.number)) {
        throw new Error(
          `Duplicate slice number ${slice.number} in plan: ${source}. Slice numbers must be globally unique across all groups.`,
        );
      }
      seen.add(slice.number);
    }
  }

  return groups;
};

export const parsePlan = async (filePath: string): Promise<readonly Group[]> => {
  const text = await readFile(filePath, "utf-8");
  return parsePlanText(text, filePath);
};
