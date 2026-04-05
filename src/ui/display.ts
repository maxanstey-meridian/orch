import { type AgentStyle } from "#domain/agent-types.js";
import type { ExecutionMode } from "#domain/config.js";
import { type Slice, type Group } from "#infrastructure/plan/plan-parser.js";

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

export const BOT_TDD: AgentStyle = {
  label: "TDD",
  color: a.cyan,
  badge: `${a.bgCyan} TDD ${a.reset}`,
};
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
  if (slice.why) {
    log(`${a.dim}│  ${slice.why.trim()}${a.reset}`);
  }
  log(`${a.dim}└──${a.reset}\n`);
};

export const printSliceContent = (log: LogFn, slice: Slice) => {
  log(`\n${a.bold}${a.white}┌─ Slice ${slice.number}: ${slice.title}${a.reset}`);
  if (slice.why) {
    log(`${a.dim}│  ${slice.why.trim()}${a.reset}`);
  }
  if (slice.files.length) {
    log(`${a.dim}│${a.reset}`);
    log(`${a.dim}│  ${a.reset}${a.bold}Files:${a.reset}`);
    for (const f of slice.files) {
      log(`${a.dim}│    ${a.reset}${f.path} (${f.action})`);
    }
  }
  if (slice.details) {
    log(`${a.dim}│${a.reset}`);
    log(`${a.dim}│  ${a.reset}${a.bold}Details:${a.reset}`);
    log(`${a.dim}│  ${a.reset}${slice.details}`);
  }
  if (slice.tests) {
    log(`${a.dim}│${a.reset}`);
    log(`${a.dim}│  ${a.reset}${a.bold}Tests:${a.reset}`);
    log(`${a.dim}│  ${a.reset}${slice.tests}`);
  }
  log(`${a.dim}└──${a.reset}\n`);
};

export const printSliceSummary = (log: LogFn, sliceNumber: number, summary: string) => {
  if (!summary.trim()) {
    return;
  }
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

export const formatPlanSummary = (log: LogFn, groups: readonly Group[]): void => {
  for (const g of groups) {
    log(`\n${a.bold}${a.cyan}┌─ ${g.name}${a.reset}`);
    for (const s of g.slices) {
      log(`${a.dim}│${a.reset}  ${a.bold}Slice ${s.number}: ${s.title}${a.reset}`);
      if (s.why) {
        log(`${a.dim}│     ${s.why}${a.reset}`);
      }
      const fileList = s.files.map((f) => `${f.path} (${f.action})`).join(", ");
      log(`${a.dim}│     Files: ${fileList}${a.reset}`);
      if (s.tests) {
        log(`${a.dim}│     Tests: ${s.tests}${a.reset}`);
      }
    }
    log(`${a.dim}└──${a.reset}`);
  }
};

export const formatExecutionModeSummary = (executionMode: ExecutionMode): string => {
  switch (executionMode) {
    case "direct":
      return "Execution direct — bounded request with no generated plan";
    case "grouped":
      return "Execution grouped — coarse increments with group-boundary gates";
    case "sliced":
      return "Execution sliced — fine-grained slices with per-slice cadence";
  }
};

export const printExecutionModeBanner = (log: LogFn, executionMode: ExecutionMode): void => {
  log(`${a.bold}${formatExecutionModeSummary(executionMode)}${a.reset}`);
};

export type BannerOpts = {
  readonly planPath: string;
  readonly brief: string;
  readonly hasContext: boolean;
  readonly executionMode: ExecutionMode;
  readonly auto: boolean;
  readonly interactive: boolean;
  readonly groupFilter?: string;
  readonly tddSessionId: string;
  readonly reviewSessionId: string;
  readonly groups: readonly Group[];
  readonly worktree?: { readonly path: string; readonly branch: string };
  readonly orchrcSummary?: string;
};

export const printStartupBanner = (log: LogFn, opts: BannerOpts): void => {
  const executionSummary = formatExecutionModeSummary(opts.executionMode).replace(
    /^Execution\s+/,
    "",
  );
  log(
    `\n${a.bold}🚀 Orchestrator${a.reset} ${a.dim}${new Date().toISOString().slice(0, 16)}${a.reset}`,
  );
  log(`   ${a.dim}Plan${a.reset}     ${opts.planPath}`);
  if (opts.worktree) {
    log(`   ${a.dim}Branch${a.reset}   ${opts.worktree.branch}`);
    log(`   ${a.dim}Worktree${a.reset} ${opts.worktree.path}`);
  }
  log(
    `   ${a.dim}Brief${a.reset}   ${opts.hasContext ? `${a.green}✓${a.reset} .orch/brief.md` : `${a.dim}none${a.reset}`}`,
  );
  log(`   ${a.dim}Execution${a.reset} ${executionSummary}`);
  log(
    `   ${a.dim}Control${a.reset} ${opts.groupFilter ? `start from "${opts.groupFilter}"` : opts.auto ? "automatic" : "interactive"}`,
  );
  if (opts.orchrcSummary) {
    log(`   ${a.dim}Config${a.reset}  .orchrc.json (${opts.orchrcSummary})`);
  }
  log(`   ${BOT_TDD.badge} ${a.dim}persistent (${opts.tddSessionId.slice(0, 8)})${a.reset}`);
  log(`   ${BOT_REVIEW.badge} ${a.dim}persistent (${opts.reviewSessionId.slice(0, 8)})${a.reset}`);
  log(`   ${BOT_GAP.badge} ${a.dim}fresh each group${a.reset}`);
  if (opts.interactive) {
    if (opts.executionMode === "sliced") {
      log(
        `   ${a.dim}Press${a.reset} ${a.bold}S${a.reset} ${a.dim}to skip current slice${a.reset}`,
      );
    } else {
      log(
        `   ${a.dim}Press${a.reset} ${a.bold}G${a.reset}/${a.bold}I${a.reset}/${a.bold}Q${a.reset} ${a.dim}for guide, interrupt, or quit${a.reset}`,
      );
    }
  }

  log("");
  for (let g = 0; g < opts.groups.length; g++) {
    const grp = opts.groups[g];
    const slices = grp.slices.map((s) => `${s.number}`).join(", ");
    const marker = g === 0 ? `${a.bold}▸${a.reset}` : " ";
    log(
      `   ${marker} ${a.dim}${String(g + 1).padStart(2)}.${a.reset} ${g === 0 ? a.bold : a.dim}${grp.name}${a.reset} ${a.dim}(${slices})${a.reset}`,
    );
  }
  log("");
};
