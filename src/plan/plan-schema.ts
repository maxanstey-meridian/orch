import { z } from "zod";
import type { Group, Slice } from "./plan-parser.js";

export const FileActionSchema = z.object({
  path: z.string().min(1),
  action: z.enum(["new", "edit", "delete"]),
});

export const PlanSliceSchema = z.object({
  number: z.number().int().positive(),
  title: z.string().min(1),
  why: z.string().min(1),
  files: z.array(FileActionSchema).min(1),
  details: z.string().min(1),
  tests: z.string().min(1),
});

export const PlanGroupSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  slices: z.array(PlanSliceSchema).min(1),
});

export const PlanSchema = z
  .object({
    groups: z.array(PlanGroupSchema).min(1),
  })
  .refine(
    (plan) => {
      const seen = new Set<number>();
      for (const group of plan.groups) {
        for (const slice of group.slices) {
          if (seen.has(slice.number)) return false;
          seen.add(slice.number);
        }
      }
      return true;
    },
    { message: "Slice numbers must be unique across all groups" },
  );

export type FileAction = z.infer<typeof FileActionSchema>;
export type PlanSliceJson = z.infer<typeof PlanSliceSchema>;
export type PlanGroupJson = z.infer<typeof PlanGroupSchema>;
export type PlanJson = z.infer<typeof PlanSchema>;

const formatFiles = (files: FileAction[]): string =>
  files.map((f) => `\`${f.path}\` (${f.action})`).join(", ");

const buildContent = (s: PlanSliceJson): string =>
  `### Slice ${s.number}: ${s.title}\n\n**Why:** ${s.why}\n\n**Files:** ${formatFiles(s.files)}\n\n${s.details}\n\n**Tests:** ${s.tests}`;

export const parsePlanJson = (json: string, source = "<json>"): readonly Group[] => {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    throw new Error(`Invalid JSON in plan: ${source} — ${(e as Error).message}`);
  }

  const result = PlanSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid plan (${source}):\n${issues}`);
  }

  return result.data.groups.map((g) => ({
    name: g.name,
    slices: g.slices.map((s): Slice => ({
      number: s.number,
      title: s.title,
      content: buildContent(s),
      why: s.why,
      files: s.files,
      details: s.details,
      tests: s.tests,
    })),
  }));
};
