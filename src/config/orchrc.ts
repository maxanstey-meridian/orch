import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

const skillValue = z.string().nullable().optional();

const skillsSchema = z.object({
  tdd: skillValue,
  review: skillValue,
  verify: skillValue,
  plan: skillValue,
  gap: skillValue,
});

const rulesSchema = z.object({
  tdd: z.union([z.string(), z.array(z.string())]).optional(),
  review: z.union([z.string(), z.array(z.string())]).optional(),
});

const configSchema = z.object({
  maxReviewCycles: z.number().int().positive().optional(),
  reviewThreshold: z.number().int().nonnegative().optional(),
  maxReplans: z.number().int().positive().optional(),
});

export const orchrcSchema = z.object({
  skills: skillsSchema.optional(),
  rules: rulesSchema.optional(),
  config: configSchema.optional(),
}).strict();

export type OrchrConfig = z.infer<typeof orchrcSchema>;

export const loadOrchrConfig = (cwd: string): OrchrConfig => {
  let raw: string;
  try {
    raw = readFileSync(path.join(cwd, ".orchrc.json"), "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw e;
  }

  const parsed = orchrcSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid .orchrc.json:\n${issues}`);
  }
  return parsed.data;
};
