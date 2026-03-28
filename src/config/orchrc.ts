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

const SKILL_KEYS = ["tdd", "review", "verify", "plan", "gap"] as const;
const RULE_KEYS = ["tdd", "review"] as const;

type SkillKey = (typeof SKILL_KEYS)[number];
type RuleKey = (typeof RULE_KEYS)[number];

export type ResolvedSkill =
  | { default: true }
  | { disabled: true }
  | { content: string };

export type ResolvedOrchrConfig = {
  skills: Record<SkillKey, ResolvedSkill>;
  rules: Partial<Record<RuleKey, string>>;
  config: Partial<z.infer<typeof configSchema>>;
};

export const resolveOrchrConfig = (raw: OrchrConfig, cwd: string): ResolvedOrchrConfig => {
  const readFilePath = (rel: string, label: string): string => {
    const resolved = path.resolve(cwd, rel);
    try {
      return readFileSync(resolved, "utf-8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`${label} file not found: ${resolved}`);
      }
      throw e;
    }
  };

  const skills = {} as Record<SkillKey, ResolvedSkill>;
  for (const key of SKILL_KEYS) {
    const value = raw.skills?.[key];
    if (value === undefined) {
      skills[key] = { default: true };
    } else if (value === null) {
      skills[key] = { disabled: true };
    } else {
      skills[key] = { content: readFilePath(value, "Skill") };
    }
  }

  const rules: Partial<Record<RuleKey, string>> = {};
  for (const key of RULE_KEYS) {
    const value = raw.rules?.[key];
    if (value === undefined) continue;
    if (typeof value === "string") {
      rules[key] = readFilePath(value, "Rule");
    } else {
      rules[key] = value.map((v) => readFilePath(v, "Rule")).join("\n\n");
    }
  }

  return { skills, rules, config: raw.config ?? {} };
};

export const loadAndResolveOrchrConfig = (cwd: string): ResolvedOrchrConfig =>
  resolveOrchrConfig(loadOrchrConfig(cwd), cwd);

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
