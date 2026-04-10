import { render, Static, Text, useInput } from "ink";
import { createInterface } from "node:readline";
import React, { useEffect, useState } from "react";
import type { ExecutionMode } from "#domain/config.js";

export type HudState = {
  executionMode?: ExecutionMode;
  currentSlice?: { readonly number: number };
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
  startPrompt: (mode: "guide" | "interrupt") => void;
  setSkipping: (value: boolean) => void;
  setActivity: (text: string) => void;
  askUser: (prompt: string) => Promise<string>;
};

export const HUD_MAX_LINES = 400;

export const appendHudLines = (
  lines: string[],
  entries: string | readonly string[],
  maxLines = HUD_MAX_LINES,
): void => {
  if (typeof entries === "string") {
    lines.push(entries);
  } else {
    lines.push(...entries);
  }

  const overflow = lines.length - maxLines;
  if (overflow > 0) {
    lines.splice(0, overflow);
  }
};

export const flushHudWriterBuffer = (lines: string[], writerBuffer: string): string => {
  if (writerBuffer.trim().length > 0) {
    appendHudLines(lines, writerBuffer);
  }
  return "";
};

const formatElapsed = (ms: number): string => {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, "0");
  const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, "0");
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
};

const buildProgressBar = (completed: number, total: number, width: number): string => {
  const filled = total > 0 ? Math.round((completed / total) * width) : 0;
  const empty = width - filled;
  if (empty === 0) {
    return `[${"=".repeat(filled)}]`;
  }
  return `[${"=".repeat(filled)}>${".".repeat(empty - 1)}]`;
};

export const buildStatusLine = (state: HudState, columns: number): string => {
  const parts: string[] = [];
  if (
    state.currentSlice &&
    state.executionMode !== "direct" &&
    state.executionMode !== "grouped"
  ) {
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

const lines: string[] = [];
let hudState: HudState = { totalSlices: 0, completedSlices: 0, startTime: Date.now() };
let notify: (() => void) | null = null;
let getColumns: () => number = () => 80;
let keyHandler: KeyHandler | null = null;
let interruptSubmitHandler: InterruptSubmitHandler | null = null;
let startPromptHandler: ((mode: "guide" | "interrupt") => void) | null = null;
let setSkippingHandler: ((value: boolean) => void) | null = null;
let setActivityHandler: ((text: string) => void) | null = null;
let askPromptHandler: ((prompt: string) => void) | null = null;
let askResolve: ((answer: string) => void) | null = null;

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧"] as const;
const SHIMMER = ["#ffffff", "#cccccc", "#999999", "#cccccc"] as const;

const ShimmerText = ({ text, offset }: { readonly text: string; readonly offset: number }) => (
  <>
    {[...text].map((char, index) => (
      <Text key={index} color={SHIMMER[(index + offset) % SHIMMER.length]}>
        {char}
      </Text>
    ))}
  </>
);

const App = () => {
  const [items, setItems] = useState<string[]>([]);
  const [, setTick] = useState(0);
  const [mode, setMode] = useState<"status" | "guide" | "interrupt" | "ask">("status");
  const [inputText, setInputText] = useState("");
  const [askLabel, setAskLabel] = useState("");
  const [skipping, setSkipping] = useState(false);
  const [activity, setActivity] = useState("");
  const [spinIndex, setSpinIndex] = useState(0);

  useEffect(() => {
    notify = () => {
      setItems([...lines]);
      setTick((tick) => tick + 1);
    };
    startPromptHandler = (nextMode) => {
      setMode(nextMode);
      setInputText("");
    };
    setSkippingHandler = setSkipping;
    setActivityHandler = setActivity;
    askPromptHandler = (prompt) => {
      setAskLabel(prompt);
      setMode("ask");
      setInputText("");
    };

    const timer = setInterval(() => {
      setTick((tick) => tick + 1);
    }, 1000);

    return () => {
      notify = null;
      startPromptHandler = null;
      setSkippingHandler = null;
      setActivityHandler = null;
      askPromptHandler = null;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!activity) {
      return;
    }

    const timer = setInterval(() => {
      setSpinIndex((index) => (index + 1) % SPINNER.length);
    }, 250);

    return () => {
      clearInterval(timer);
    };
  }, [activity]);

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      keyHandler?.("\x03");
      return;
    }

    if (mode === "guide" || mode === "interrupt" || mode === "ask") {
      if (key.return) {
        const text = inputText.trim();
        if (mode === "ask") {
          setMode("status");
          setInputText("");
          const resolveAsk = askResolve;
          askResolve = null;
          resolveAsk?.(text);
          return;
        }

        const submitMode = mode;
        setMode("status");
        setInputText("");
        if (text) {
          interruptSubmitHandler?.(text, submitMode);
        }
        return;
      }

      if (key.escape) {
        setMode("status");
        setInputText("");
        if (mode === "ask") {
          const resolveAsk = askResolve;
          askResolve = null;
          resolveAsk?.("");
        }
        return;
      }

      if (key.backspace || key.delete) {
        setInputText((text) => text.slice(0, -1));
        return;
      }

      if (input && !key.ctrl && !key.meta) {
        setInputText((text) => text + input);
      }
      return;
    }

    if (key.escape) {
      return;
    }
    if (input) {
      keyHandler?.(input);
    }
    if (key.return) {
      keyHandler?.("return");
    }
  });

  const columns = getColumns();

  if (mode === "ask") {
    const prompt = ` ${askLabel}${inputText}█`;
    const padded = prompt + " ".repeat(Math.max(0, columns - prompt.length));
    return (
      <>
        <Static items={items}>{(line, index) => <Text key={index}>{line}</Text>}</Static>
        <Text> </Text>
        <Text bold color="green">
          {padded}
        </Text>
      </>
    );
  }

  if (mode === "guide" || mode === "interrupt") {
    const label = mode === "guide" ? "Guide" : "Interrupt";
    const color = mode === "guide" ? "cyan" : "yellow";
    const prompt = ` [${label}] Message for agent: ${inputText}█`;
    const padded = prompt + " ".repeat(Math.max(0, columns - prompt.length));
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

  const status = buildStatusLine(hudState, columns - 2);
  const padded = ` ${status}${" ".repeat(Math.max(0, columns - status.length - 2))} `;
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
        {activity ? (
          <Text>
            {`  ${SPINNER[spinIndex]} `}
            <ShimmerText text={activity} offset={spinIndex} />
          </Text>
        ) : null}
      </Text>
    </>
  );
};

export const createHud = (
  enabled: boolean,
  stdout: NodeJS.WriteStream = process.stdout,
): Hud => {
  if (!enabled || !process.stdin.isTTY) {
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
      setActivity: () => {},
      askUser: (prompt) =>
        new Promise((resolveAnswer) => {
          const rl = createInterface({ input: process.stdin, output: stdout });
          rl.question(prompt, (answer) => {
            rl.close();
            resolveAnswer(answer);
          });
        }),
    };
  }

  hudState = { totalSlices: 0, completedSlices: 0, startTime: Date.now() };
  lines.length = 0;
  getColumns = () => stdout.columns ?? 80;
  keyHandler = null;
  interruptSubmitHandler = null;

  let tornDown = false;
  const instance = render(<App />);

  const flush = () => {
    if (!tornDown && notify) {
      notify();
    }
  };

  let writerBuffer = "";

  return {
    update: (partial) => {
      if (tornDown) {
        return;
      }
      hudState = { ...hudState, ...partial };
      flush();
    },
    teardown: () => {
      if (tornDown) {
        return;
      }
      tornDown = true;
      writerBuffer = flushHudWriterBuffer(lines, writerBuffer);
      notify = null;
      keyHandler = null;
      interruptSubmitHandler = null;
      startPromptHandler = null;
      lines.length = 0;
      instance.unmount();
    },
    wrapLog:
      (_logFn) =>
      (...args: unknown[]) => {
        if (tornDown) {
          return;
        }
        writerBuffer = flushHudWriterBuffer(lines, writerBuffer);
        const text = args.map((arg) => (typeof arg === "string" ? arg : String(arg))).join(" ");
        appendHudLines(lines, text);
        flush();
      },
    createWriter: () => (text: string) => {
      if (tornDown) {
        return;
      }
      writerBuffer += text;
      const parts = writerBuffer.split("\n");
      writerBuffer = parts.pop() ?? "";
      appendHudLines(lines, parts);
      if (parts.length > 0) {
        flush();
      }
    },
    onKey: (handler) => {
      keyHandler = handler;
    },
    onInterruptSubmit: (handler) => {
      interruptSubmitHandler = handler;
    },
    startPrompt: (mode) => {
      startPromptHandler?.(mode);
    },
    setSkipping: (value) => {
      setSkippingHandler?.(value);
    },
    setActivity: (text) => {
      setActivityHandler?.(text);
    },
    askUser: (prompt) =>
      new Promise((resolveAnswer) => {
        askResolve = resolveAnswer;
        askPromptHandler?.(prompt);
      }),
  };
};
