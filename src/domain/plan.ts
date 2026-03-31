export type FileAction = {
  readonly path: string;
  readonly action: "new" | "edit" | "delete";
};

export type SliceDependency = {
  readonly slice: number;
  readonly what: string;
};

export type Slice = {
  readonly number: number;
  readonly title: string;
  readonly content: string;
  readonly why: string;
  readonly files: readonly FileAction[];
  readonly details: string;
  readonly tests: string;
  readonly relatedFiles?: readonly string[];
  readonly keyContext?: string;
  readonly dependsOn?: readonly SliceDependency[];
  readonly testPatterns?: string;
  readonly signatures?: Readonly<Record<string, string>>;
  readonly gotchas?: readonly string[];
};

export type PlanContext = {
  readonly architecture?: string;
  readonly keyFiles?: Readonly<Record<string, string>>;
  readonly concepts?: Readonly<Record<string, string>>;
  readonly conventions?: Readonly<Record<string, string>>;
};

export type Group = {
  readonly name: string;
  readonly slices: readonly Slice[];
};

const formatFiles = (files: readonly FileAction[]): string =>
  files.map((f) => `\`${f.path}\` (${f.action})`).join(", ");

export const buildContent = (s: {
  readonly number: number;
  readonly title: string;
  readonly why: string;
  readonly files: readonly FileAction[];
  readonly details: string;
  readonly tests: string;
  readonly relatedFiles?: readonly string[];
  readonly keyContext?: string;
  readonly dependsOn?: readonly SliceDependency[];
  readonly testPatterns?: string;
  readonly signatures?: Readonly<Record<string, string>>;
  readonly gotchas?: readonly string[];
}): string => {
  const parts = [
    `### Slice ${s.number}: ${s.title}`,
    `\n\n**Why:** ${s.why}`,
    `\n\n**Files:** ${formatFiles(s.files)}`,
  ];

  if (s.relatedFiles?.length) {
    parts.push(`\n\n**Related files:** ${s.relatedFiles.map((f) => `\`${f}\``).join(", ")}`);
  }
  if (s.keyContext) {
    parts.push(`\n\n**Key context:** ${s.keyContext}`);
  }
  if (s.dependsOn?.length) {
    parts.push(`\n\n**Depends on:** ${s.dependsOn.map((d) => `Slice ${d.slice} (${d.what})`).join("; ")}`);
  }
  if (s.testPatterns) {
    parts.push(`\n\n**Test patterns:** ${s.testPatterns}`);
  }
  if (s.signatures && Object.keys(s.signatures).length) {
    const sigs = Object.entries(s.signatures).map(([k, v]) => `\`${k}\`: \`${v}\``).join(", ");
    parts.push(`\n\n**Key signatures:** ${sigs}`);
  }
  if (s.gotchas?.length) {
    parts.push(`\n\n**Gotchas:**\n${s.gotchas.map((g) => `- ${g}`).join("\n")}`);
  }

  parts.push(`\n\n${s.details}\n\n**Tests:** ${s.tests}`);

  return parts.join("");
};
