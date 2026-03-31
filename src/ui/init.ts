import { existsSync } from "fs";
import { resolve } from "path";
import { createInterface } from "readline";

// ─── Types ──────────────────────────────────────────────────────────────────

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

// ─── Default ask (readline-based) ───────────────────────────────────────────

export const createAsk = (
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): AskHandle => {
  const rl = createInterface({ input, output });
  const ask: AskFn = (prompt: string): Promise<string> =>
    new Promise<string>((res) => {
      rl.question(prompt, (answer: string) => res(answer.trim()));
    });
  const close = () => rl.close();
  return { ask, close };
};

// ─── Init dialogue ─────────────────────────────────────────────────────────

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
    const style = await ask(
      "Coding style preferences? (naming, architecture, patterns — free text) ",
    );
    const linting = await ask("Linting/formatting tools? (e.g. oxlint + oxfmt, eslint, none) ");
    const refsRaw = await ask(
      "Paths to reference files? (comma-separated, e.g. ../CLAUDE.md, ./styleguide.md) ",
    );
    const extraContext = await ask("Any other context for agents? (free text) ");

    // Filter reference paths — resolve against cwd, store absolute paths
    let references: string[] | undefined;
    if (refsRaw) {
      const candidates = refsRaw
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean);
      const valid: string[] = [];
      for (const p of candidates) {
        const resolved = resolve(cwd, p);
        if (existsSync(resolved)) {
          valid.push(resolved);
        } else {
          console.warn(`Warning: reference path not found, skipping: ${p}`);
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

// ─── Markdown serialisation ─────────────────────────────────────────────────

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
