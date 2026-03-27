import { z } from "zod";

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
