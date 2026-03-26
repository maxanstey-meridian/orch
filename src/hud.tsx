import React, { useState, useEffect } from "react";
import { render, Text, Static, useInput } from "ink";

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

export type WriteFn = (text: string) => void;

export type KeyHandler = (key: string) => void;
export type InterruptSubmitHandler = (text: string, mode: "guide" | "interrupt") => void;

export type Hud = {
  update: (partial: Partial<HudState>) => void;
  teardown: () => void;
  wrapLog: (logFn: (...args: unknown[]) => void) => (...args: unknown[]) => void;
  createWriter: () => WriteFn;
  onKey: (handler: KeyHandler) => void;
  onInterruptSubmit: (handler: InterruptSubmitHandler) => void;
  /** Switch HUD to text input mode. Pass "guide" or "interrupt". */
  startPrompt: (mode: "guide" | "interrupt") => void;
  /** Show "skipping…" indicator on the shortcut bar. */
  setSkipping: (v: boolean) => void;
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

export const buildStatusLine = (state: HudState, columns: number): string => {
  const parts: string[] = [];
  if (state.currentSlice) {
    parts.push(`S${state.currentSlice.number}/${state.totalSlices}`);
  }
  if (state.groupName != null) {
    const bar =
      state.groupSliceCount != null && state.groupCompleted != null
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

// ─── Globals for bridging external calls → React state ───────────────────────

const _lines: string[] = [];
let _hudState: HudState = { totalSlices: 0, completedSlices: 0, startTime: Date.now() };
let _notify: (() => void) | null = null;
let _getCols: () => number = () => 80;
let _keyHandler: KeyHandler | null = null;
let _interruptSubmitHandler: InterruptSubmitHandler | null = null;
let _startPrompt: ((mode: "guide" | "interrupt") => void) | null = null;
let _setSkipping: ((v: boolean) => void) | null = null;

// ─── ink component ───────────────────────────────────────────────────────────

const App = () => {
  const [items, setItems] = useState<string[]>([]);
  const [, setTick] = useState(0);
  const [mode, setMode] = useState<"status" | "guide" | "interrupt">("status");
  const [inputText, setInputText] = useState("");
  const [skipping, setSkipping] = useState(false);

  useEffect(() => {
    _notify = () => {
      setItems([..._lines]);
      setTick((t) => t + 1);
    };
    _startPrompt = (m) => {
      setMode(m);
      setInputText("");
    };
    _setSkipping = setSkipping;
    const iv = setInterval(() => setTick((t) => t + 1), 1000);
    return () => {
      _notify = null;
      _startPrompt = null;
      _setSkipping = null;
      clearInterval(iv);
    };
  }, []);

  useInput((input, key) => {
    if (mode === "guide" || mode === "interrupt") {
      if (key.return) {
        const text = inputText.trim();
        const m = mode;
        setMode("status");
        setInputText("");
        if (text && _interruptSubmitHandler) _interruptSubmitHandler(text, m);
      } else if (key.escape) {
        setMode("status");
        setInputText("");
      } else if (key.backspace || key.delete) {
        setInputText((t) => t.slice(0, -1));
      } else if (input && !key.ctrl && !key.meta) {
        setInputText((t) => t + input);
      }
      return;
    }

    // Status mode — dispatch to external handler
    if (key.escape) return; // ignore
    if (input && _keyHandler) _keyHandler(input);
    if (key.return && _keyHandler) _keyHandler("return");
  });

  const cols = _getCols();

  if (mode === "guide" || mode === "interrupt") {
    const label = mode === "guide" ? "Guide" : "Interrupt";
    const color = mode === "guide" ? "cyan" : "yellow";
    const prompt = ` [${label}] Message for agent: ${inputText}█`;
    const padded = prompt + " ".repeat(Math.max(0, cols - prompt.length));
    return (
      <>
        <Static items={items}>{(line, index) => <Text key={index}>{line}</Text>}</Static>
        <Text> </Text>
        <Text bold color={color}>
          {padded}
        </Text>
      </>
    );
  }

  const status = buildStatusLine(_hudState, cols - 2);
  const padded = " " + status + " ".repeat(Math.max(0, cols - status.length - 2)) + " ";
  return (
    <>
      <Static items={items}>{(line, index) => <Text key={index}>{line}</Text>}</Static>
      <Text> </Text>
      <Text bold inverse>
        {padded}
      </Text>
      <Text>
        <Text dimColor>{" G: guide | I: interrupt | "}</Text>
        {skipping ? (
          <Text color="whiteBright">{"S: skipping…"}</Text>
        ) : (
          <Text dimColor>{"S: skip"}</Text>
        )}
        <Text dimColor>{" | Q: quit"}</Text>
      </Text>
    </>
  );
};

// ─── createHud ───────────────────────────────────────────────────────────────

export const createHud = (enabled: boolean, stdout: NodeJS.WriteStream = process.stdout): Hud => {
  if (!enabled) {
    return {
      update: () => {},
      teardown: () => {},
      wrapLog:
        (logFn) =>
        (...args: unknown[]) =>
          logFn(...args),
      createWriter: () => (text: string) => {
        stdout.write(text);
      },
      onKey: () => {},
      onInterruptSubmit: () => {},
      startPrompt: () => {},
      setSkipping: () => {},
    };
  }

  _hudState = { totalSlices: 0, completedSlices: 0, startTime: Date.now() };
  _lines.length = 0;
  _getCols = () => stdout.columns ?? 80;
  _keyHandler = null;
  _interruptSubmitHandler = null;

  let tornDown = false;
  const instance = render(<App />);

  const notify = () => {
    if (!tornDown && _notify) _notify();
  };

  let writerBuffer = "";

  return {
    update: (partial) => {
      if (tornDown) return;
      _hudState = { ..._hudState, ...partial };
      notify();
    },
    teardown: () => {
      if (tornDown) return;
      tornDown = true;
      if (writerBuffer.trim()) _lines.push(writerBuffer);
      writerBuffer = "";
      _notify = null;
      _keyHandler = null;
      _interruptSubmitHandler = null;
      _startPrompt = null;
      _lines.length = 0;
      instance.unmount();
    },
    wrapLog:
      (_logFn) =>
      (...args: unknown[]) => {
        if (tornDown) return;
        const text = args.map((a) => (typeof a === "string" ? a : String(a))).join(" ");
        _lines.push(text);
        notify();
      },
    createWriter: () => (text: string) => {
      if (tornDown) return;
      writerBuffer += text;
      const parts = writerBuffer.split("\n");
      writerBuffer = parts.pop() ?? "";
      for (const line of parts) _lines.push(line);
      if (parts.length > 0) notify();
    },
    onKey: (handler) => {
      _keyHandler = handler;
    },
    onInterruptSubmit: (handler) => {
      _interruptSubmitHandler = handler;
    },
    startPrompt: (m) => {
      if (_startPrompt) _startPrompt(m);
    },
    setSkipping: (v) => {
      if (_setSkipping) _setSkipping(v);
    },
  };
};
