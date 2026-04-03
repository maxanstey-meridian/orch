import { z } from "zod";
import type { Group, PlannedExecutionMode, Slice } from "#domain/plan.js";
import { buildContent } from "#domain/plan.js";

export type { FileAction } from "#domain/plan.js";

export const FileActionSchema = z.object({
  path: z.string().min(1),
  action: z.enum(["new", "edit", "delete"]),
});

const DependencySchema = z.object({
  slice: z.number().int().nonnegative(),
  what: z.string().min(1),
});

export const PlanSliceSchema = z.object({
  number: z.number().int().positive(),
  title: z.string().min(1),
  why: z.string().min(1),
  files: z.array(FileActionSchema).min(1),
  criteria: z.array(z.string().min(1)).min(1).optional(),
  details: z.string().min(1),
  tests: z.string().min(1),
  relatedFiles: z.array(z.string()).optional(),
  keyContext: z.string().optional(),
  dependsOn: z.array(DependencySchema).optional(),
  testPatterns: z.string().optional(),
  signatures: z.record(z.string()).optional(),
  gotchas: z.array(z.string()).optional(),
});

const PlanContextSchema = z.object({
  architecture: z.string().optional(),
  keyFiles: z.record(z.string()).optional(),
  concepts: z.record(z.string()).optional(),
  conventions: z.record(z.string()).optional(),
});

export const PlanGroupSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  slices: z.array(PlanSliceSchema).min(1),
});

export const PlanSchema = z
  .object({
    executionMode: z.enum(["grouped", "sliced"]).optional(),
    context: PlanContextSchema.optional(),
    groups: z.array(PlanGroupSchema).min(1),
  })
  .superRefine((plan, ctx) => {
    const flattenedSlices = plan.groups.flatMap((group) => group.slices);
    const seen = new Set<number>();

    for (const slice of flattenedSlices) {
      if (seen.has(slice.number)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Slice numbers must be unique across all groups",
        });
        return;
      }
      seen.add(slice.number);
    }

    for (const [index, slice] of flattenedSlices.entries()) {
      const expectedNumber = index + 1;
      if (slice.number !== expectedNumber) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Slice numbers must be sequential across all groups starting at 1",
        });
        return;
      }
    }
  });

export type PlanSliceJson = z.infer<typeof PlanSliceSchema>;
export type PlanGroupJson = z.infer<typeof PlanGroupSchema>;
export type PlanJson = z.infer<typeof PlanSchema>;
export type PlanDocument = {
  readonly executionMode?: PlannedExecutionMode;
  readonly groups: readonly Group[];
};

export const parsePlanDocumentJson = (json: string, source = "<json>"): PlanDocument => {
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

  return {
    executionMode: result.data.executionMode,
    groups: result.data.groups.map((g) => ({
      name: g.name,
      description: g.description,
      slices: g.slices.map(
        (s): Slice => ({
          number: s.number,
          title: s.title,
          content: buildContent(s),
          why: s.why,
          files: s.files,
          criteria: s.criteria,
          details: s.details,
          tests: s.tests,
          relatedFiles: s.relatedFiles,
          keyContext: s.keyContext,
          dependsOn: s.dependsOn,
          testPatterns: s.testPatterns,
          signatures: s.signatures,
          gotchas: s.gotchas,
        }),
      ),
    })),
  };
};

export const parsePlanJson = (json: string, source = "<json>"): readonly Group[] => {
  return parsePlanDocumentJson(json, source).groups;
};
