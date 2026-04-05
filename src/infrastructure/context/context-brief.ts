import type { RepoContextArtifact, RepoContextData } from "#domain/context.js";

const renderDictionarySection = (
  title: string,
  values: Readonly<Record<string, string>> | undefined,
): string[] => {
  if (values === undefined || Object.keys(values).length === 0) {
    return [];
  }

  return [
    `## ${title}`,
    "",
    ...Object.entries(values).map(([key, value]) => `- **${key}:** ${value}`),
    "",
  ];
};

const renderContextSections = (context: RepoContextData): string[] => {
  const lines = [
    "# Codebase Brief",
    "",
    "> Auto-generated from .orch/context.json. Injected into agent prompts to maintain",
    "> consistency across compaction boundaries. Do not edit — regenerate instead.",
    "",
  ];

  if (context.architecture !== undefined) {
    lines.push("## Architecture", "", context.architecture, "");
  }

  lines.push(...renderDictionarySection("Key Files", context.keyFiles));
  lines.push(...renderDictionarySection("Concepts", context.concepts));
  lines.push(...renderDictionarySection("Conventions", context.conventions));

  return lines;
};

export const renderBriefFromContext = (artifact: RepoContextArtifact): string =>
  renderContextSections(artifact.effective.context).join("\n").trimEnd() + "\n";
