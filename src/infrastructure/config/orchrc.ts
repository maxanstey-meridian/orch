import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { AgentRole } from "#domain/agent-types.js";
import { AGENT_ROLES } from "#domain/agent-types.js";

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

const agentsSchema = z.record(
  z.enum(AGENT_ROLES as unknown as [string, ...string[]]),
  z.string().regex(/^(claude(:(opus|sonnet|haiku))?|codex)$/),
).optional();

export const orchrcSchema = z
  .object({
    skills: skillsSchema.optional(),
    rules: rulesSchema.optional(),
    config: configSchema.optional(),
    agents: agentsSchema,
  })
  .strict();

export type OrchrConfig = z.infer<typeof orchrcSchema>;

const SKILL_KEYS = ["tdd", "review", "verify", "plan", "gap"] as const;
const RULE_KEYS = ["tdd", "review"] as const;

type SkillKey = (typeof SKILL_KEYS)[number];
type RuleKey = (typeof RULE_KEYS)[number];

export type ResolvedSkill = { default: true } | { disabled: true } | { content: string };

export type ResolvedOrchrConfig = {
  skills: Record<SkillKey, ResolvedSkill>;
  rules: Partial<Record<RuleKey, string>>;
  config: Partial<z.infer<typeof configSchema>>;
  agents?: Partial<Record<AgentRole, string>>;
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
    if (value === undefined) {
      continue;
    }
    if (typeof value === "string") {
      rules[key] = readFilePath(value, "Rule");
    } else {
      rules[key] = value.map((v) => readFilePath(v, "Rule")).join("\n\n");
    }
  }

  return { skills, rules, config: raw.config ?? {}, agents: raw.agents };
};

export const buildOrchrSummary = (config: ResolvedOrchrConfig): string | undefined => {
  const labels: string[] = [];
  for (const [key, value] of Object.entries(config.skills)) {
    if ("disabled" in value) {
      labels.push(`${key}: disabled`);
    } else if ("content" in value) {
      labels.push(`${key}: custom`);
    }
  }
  for (const [key, value] of Object.entries(config.config)) {
    if (value !== undefined) {
      labels.push(`${key}: ${value}`);
    }
  }
  if (config.agents) {
    for (const [role, value] of Object.entries(config.agents)) {
      if (value !== "claude") {
        labels.push(`${role}: ${value}`);
      }
    }
  }
  return labels.length > 0 ? labels.join(", ") : undefined;
};

export const resolveSkillValue = (resolved: ResolvedSkill, builtIn: string): string | null => {
  if ("disabled" in resolved) {
    return null;
  }
  if ("content" in resolved) {
    return resolved.content;
  }
  return builtIn;
};

export const loadAndResolveOrchrConfig = (cwd: string): ResolvedOrchrConfig =>
  resolveOrchrConfig(loadOrchrConfig(cwd), cwd);

export const loadOrchrConfig = (cwd: string): OrchrConfig => {
  let raw: string;
  try {
    raw = readFileSync(path.join(cwd, ".orchrc.json"), "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw e;
  }

  const parsed = orchrcSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid .orchrc.json:\n${issues}`);
  }
  return parsed.data;
};
