export type HudState = {
  currentSlice?: { number: number };
  totalSlices: number;
  completedSlices: number;
  groupName?: string;
  groupSliceCount?: number;
  groupCompleted?: number;
  activeAgent?: string;
  activeAgentActivity?: string;
  startTime: number;
  creditSignal?: string;
};

export type Hud = {
  update: (partial: Partial<HudState>) => void;
  teardown: () => void;
  wrapLog: (logFn: (...args: unknown[]) => void) => (...args: unknown[]) => void;
};

const formatElapsed = (ms: number): string => {
  const totalSec = Math.floor(ms / 1000);
  const h = String(Math.floor(totalSec / 3600)).padStart(2, "0");
  const m = String(Math.floor((totalSec % 3600) / 60)).padStart(2, "0");
  const s = String(totalSec % 60).padStart(2, "0");
  return `${h}:${m}:${s}`;
};

const buildProgressBar = (completed: number, total: number, width: number): string => {
  const filled = total > 0 ? Math.round((completed / total) * width) : 0;
  const empty = width - filled;
  if (empty === 0) return `[${"=".repeat(filled)}]`;
  return `[${"=".repeat(filled)}>${".".repeat(empty - 1)}]`;
};

const buildStatusLine = (state: HudState, columns: number): string => {
  const parts: string[] = [];

  if (state.currentSlice) {
    parts.push(`S${state.currentSlice.number}/${state.totalSlices}`);
  }

  if (state.groupName != null) {
    const bar = state.groupSliceCount != null && state.groupCompleted != null
      ? ` ${buildProgressBar(state.groupCompleted, state.groupSliceCount, 8)} ${state.groupCompleted}/${state.groupSliceCount}`
      : "";
    parts.push(`Group: ${state.groupName}${bar}`);
  }

  if (state.activeAgent) {
    const activity = state.activeAgentActivity ? `: ${state.activeAgentActivity}` : "";
    parts.push(`${state.activeAgent}${activity}`);
  }

  parts.push(formatElapsed(Date.now() - state.startTime));

  if (state.creditSignal) {
    parts.push(`Credits: ${state.creditSignal}`);
  }

  const line = parts.join(" | ");
  return line.length > columns ? line.slice(0, columns) : line;
};

const renderBar = (stdout: NodeJS.WriteStream, state: HudState): void => {
  const cols = stdout.columns ?? 80;
  const rows = stdout.rows ?? 24;
  const line = buildStatusLine(state, cols);

  // Save cursor, move to bottom row, clear line, write status, restore cursor
  stdout.write(`\x1b7\x1b[${rows};1H\x1b[2K${line}\x1b8`);
};

export const createHud = (
  enabled: boolean,
  stdout: NodeJS.WriteStream = process.stdout,
): Hud => {
  if (!enabled) {
    return {
      update: () => {},
      teardown: () => {},
      wrapLog: (logFn) => (...args: unknown[]) => logFn(...args),
    };
  }

  const setScrollRegion = () => {
    const r = stdout.rows ?? 24;
    stdout.write(`\x1b[1;${r - 1}r`);
  };

  setScrollRegion();

  let state: HudState = { totalSlices: 0, completedSlices: 0, startTime: Date.now() };
  let tornDown = false;

  const onResize = () => {
    setScrollRegion();
    renderBar(stdout, state);
  };

  stdout.on("resize", onResize);

  return {
    update: (partial) => {
      if (tornDown) return;
      state = { ...state, ...partial };
      renderBar(stdout, state);
    },
    teardown: () => {
      if (tornDown) return;
      tornDown = true;
      stdout.removeListener("resize", onResize);
      stdout.write("\x1b[r");
    },
    wrapLog: (logFn) => (...args: unknown[]) => {
      logFn(...args);
      renderBar(stdout, state);
    },
  };
};
