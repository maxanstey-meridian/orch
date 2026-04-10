import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

export type InitProfile = {
  readonly language: string;
  readonly framework?: string;
  readonly style?: string;
  readonly linting?: string;
  readonly references?: string[];
  readonly extraContext?: string;
};

export type AskFn = (prompt: string) => Promise<string>;
export type AskHandle = { readonly ask: AskFn; readonly close: () => void };

export const createAsk = (
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): AskHandle => {
  const rl = createInterface({ input, output });
  const ask: AskFn = (prompt: string) =>
    new Promise((resolveAnswer) => {
      rl.question(prompt, (answer) => {
        resolveAnswer(answer.trim());
      });
    });

  return {
    ask,
    close: () => {
      rl.close();
    },
  };
};

export const runInit = async (
  cwd: string,
  askOrHandle: AskFn | AskHandle = createAsk(),
): Promise<InitProfile | null> => {
  const ask = typeof askOrHandle === "function" ? askOrHandle : askOrHandle.ask;
  const close = typeof askOrHandle === "function" ? undefined : askOrHandle.close;

  try {
    console.log("Initialising project profile. Press Enter to skip any question.");

    const language = await ask("Language? (e.g. TypeScript, C#, Python) ");
    if (!language) {
      return null;
    }

    const framework = await ask("Framework? (e.g. NestJS, Express, ASP.NET — or blank for none) ");
    const style = await ask("Coding style preferences? (naming, architecture, patterns — free text) ");
    const linting = await ask("Linting/formatting tools? (e.g. oxlint + oxfmt, eslint, none) ");
    const refsRaw = await ask(
      "Paths to reference files? (comma-separated, e.g. ../CLAUDE.md, ./styleguide.md) ",
    );
    const extraContext = await ask("Any other context for agents? (free text) ");

    let references: string[] | undefined;
    if (refsRaw) {
      const candidates = refsRaw
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
      const valid: string[] = [];
      for (const candidate of candidates) {
        const resolved = resolve(cwd, candidate);
        if (existsSync(resolved)) {
          valid.push(resolved);
        } else {
          console.warn(`Warning: reference path not found, skipping: ${candidate}`);
        }
      }
      if (valid.length > 0) {
        references = valid;
      }
    }

    return {
      language,
      ...(framework ? { framework } : {}),
      ...(style ? { style } : {}),
      ...(linting ? { linting } : {}),
      ...(references ? { references } : {}),
      ...(extraContext ? { extraContext } : {}),
    };
  } finally {
    close?.();
  }
};

export const profileToMarkdown = (profile: InitProfile): string => {
  const lines: string[] = ["## Project Profile (from init)", ""];
  lines.push(`- **Language:** ${profile.language}`);
  if (profile.framework) {
    lines.push(`- **Framework:** ${profile.framework}`);
  }
  if (profile.style) {
    lines.push(`- **Style:** ${profile.style}`);
  }
  if (profile.linting) {
    lines.push(`- **Linting:** ${profile.linting}`);
  }
  if (profile.references?.length) {
    lines.push(`- **References:** ${profile.references.join(", ")}`);
  }
  if (profile.extraContext) {
    lines.push(`- **Notes:** ${profile.extraContext}`);
  }
  lines.push("");
  return lines.join("\n");
};

const PROFILE_MARKDOWN_HEADER = "## Project Profile (from init)";

const profileFieldLabels = {
  Language: "language",
  Framework: "framework",
  Style: "style",
  Linting: "linting",
  References: "references",
  Notes: "extraContext",
} as const;

type ProfileFieldLabel = keyof typeof profileFieldLabels;

const parseProfileFieldLine = (
  line: string,
): { readonly label: ProfileFieldLabel; readonly value: string } | null => {
  const match = /^- \*\*(Language|Framework|Style|Linting|References|Notes):\*\* (.+)$/u.exec(line);
  if (match === null) {
    return null;
  }

  const label = match[1];
  const value = match[2];
  if (
    label !== "Language" &&
    label !== "Framework" &&
    label !== "Style" &&
    label !== "Linting" &&
    label !== "References" &&
    label !== "Notes"
  ) {
    return null;
  }

  return { label, value: value.trim() };
};

export const parseProfileMarkdown = (markdown: string): InitProfile | null => {
  const lines = markdown
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines[0] !== PROFILE_MARKDOWN_HEADER) {
    return null;
  }

  const parsed: { -readonly [K in keyof InitProfile]?: InitProfile[K] } = {};

  for (const line of lines.slice(1)) {
    const field = parseProfileFieldLine(line);
    if (field === null) {
      return null;
    }

    const key = profileFieldLabels[field.label];
    if (key === "references") {
      const references = field.value
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
      if (references.length > 0) {
        parsed.references = references;
      }
      continue;
    }

    parsed[key] = field.value;
  }

  if (typeof parsed.language !== "string" || parsed.language.length === 0) {
    return null;
  }

  return {
    language: parsed.language,
    ...(parsed.framework ? { framework: parsed.framework } : {}),
    ...(parsed.style ? { style: parsed.style } : {}),
    ...(parsed.linting ? { linting: parsed.linting } : {}),
    ...(parsed.references ? { references: parsed.references } : {}),
    ...(parsed.extraContext ? { extraContext: parsed.extraContext } : {}),
  };
};
