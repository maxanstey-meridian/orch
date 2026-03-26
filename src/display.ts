import { type AgentStyle } from "./agent.js";
import { type Slice } from "./plan-parser.js";

export type LogFn = (...args: unknown[]) => void;

export const a = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  white: "\x1b[37m",
  bgCyan: "\x1b[46m\x1b[30m",
  bgMagenta: "\x1b[45m\x1b[30m",
  bgGreen: "\x1b[42m\x1b[30m",
};

export const ts = (): string => {
  const d = new Date();
  return `${a.dim}${d.toLocaleTimeString("en-GB", { hour12: false })}${a.reset}`;
};

export const BOT_TDD: AgentStyle = { label: "TDD", color: a.cyan, badge: `${a.bgCyan} TDD ${a.reset}` };
export const BOT_REVIEW: AgentStyle = {
  label: "REVIEW",
  color: a.magenta,
  badge: `${a.bgMagenta} REV ${a.reset}`,
};
export const BOT_GAP: AgentStyle = {
  label: "GAP",
  color: a.yellow,
  badge: `${a.yellow}${a.bold} GAP ${a.reset}`,
};
export const BOT_FINAL: AgentStyle = {
  label: "FINAL",
  color: a.green,
  badge: `${a.bgGreen} FIN ${a.reset}`,
};
export const BOT_VERIFY: AgentStyle = {
  label: "VERIFY",
  color: a.green,
  badge: `${a.bgGreen} VFY ${a.reset}`,
};
export const BOT_PLAN: AgentStyle = {
  label: "PLAN",
  color: a.white,
  badge: `${a.bold}${a.white} PLN ${a.reset}`,
};

export const logSection = (log: LogFn, title: string) => {
  const line = "━".repeat(64);
  log(`\n${a.bold}${a.white}${line}${a.reset}`);
  log(`${a.bold}  ${title}${a.reset}`);
  log(`${a.bold}${a.white}${line}${a.reset}`);
};

export const printSliceIntro = (log: LogFn, slice: Slice) => {
  log(`\n${a.bold}${a.white}┌─ Slice ${slice.number}: ${slice.title}${a.reset}`);
  const introLine = slice.content
    .split("\n")
    .find((l: string) => l.trim() && !l.startsWith("#") && !l.startsWith("---"));
  if (introLine) log(`${a.dim}│  ${introLine.trim()}${a.reset}`);
  log(`${a.dim}└──${a.reset}\n`);
};

export const printSliceSummary = (log: LogFn, sliceNumber: number, summary: string) => {
  if (!summary.trim()) return;
  log("");
  log(`${a.bold}${a.green}┌─ Slice ${sliceNumber} complete ────────────────────────────${a.reset}`);
  for (const line of summary.trim().split("\n")) {
    const formatted = line
      .replace(/^## (.+)/, `${a.bold}${a.white}│ $1${a.reset}`)
      .replace(/^- (.+)/, `${a.dim}│${a.reset}  - $1`)
      .replace(/^(?!│)(.+)/, `${a.dim}│${a.reset}  $1`);
    log(formatted);
  }
  log(`${a.bold}${a.green}└──────────────────────────────────────────────${a.reset}`);
};
