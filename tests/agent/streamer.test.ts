import { describe, it, expect, afterEach } from "vitest";
import type { AgentStyle } from "../../src/agent/agent.js";
import { makeStreamer } from "../../src/agent/streamer.js";
import { a } from "../../src/ui/display.js";

const style: AgentStyle = { label: "TEST", color: "C", badge: "B" };
const gutter = `C│\x1b[0m `;
const wrapIndent = `C│\x1b[0m   `;

describe("makeStreamer", () => {
  const origColumns = process.stdout.columns;
  afterEach(() => {
    process.stdout.columns = origColumns;
  });

  it("prefixes each line with a gutter", () => {
    let output = "";
    const spy = (t: string) => { output += t; };
    const s = makeStreamer(style, spy);
    s("hello");
    s.flush();
    expect(output).toContain(`${gutter}hello`);
  });

  it("wraps long lines at maxWidth", () => {
    process.stdout.columns = 40;
    let output = "";
    const spy = (t: string) => { output += t; };
    const s = makeStreamer(style, spy);
    // maxWidth = 40 - 4 = 36. Feed words that exceed that.
    s("word ".repeat(10).trim());
    s.flush();
    expect(output).toContain(wrapIndent);
  });

  it("highlights RED and GREEN keywords", () => {
    let output = "";
    const spy = (t: string) => { output += t; };
    const s = makeStreamer(style, spy);
    s("RED and GREEN");
    s.flush();
    expect(output).toContain(`${a.bold}${a.red}RED${a.reset}`);
    expect(output).toContain(`${a.bold}${a.green}GREEN${a.reset}`);
  });

  it("highlights commit hashes", () => {
    let output = "";
    const spy = (t: string) => { output += t; };
    const s = makeStreamer(style, spy);
    s("Committed at `abc1234`");
    s.flush();
    expect(output).toContain(`${a.bold}${a.yellow}`);
    expect(output).toContain("abc1234");
  });

  it("flush emits newline when not at line start", () => {
    let output = "";
    const spy = (t: string) => { output += t; };
    const s = makeStreamer(style, spy);
    s("text");
    const beforeFlush = output;
    s.flush();
    // flush should add exactly one trailing newline
    expect(output.length).toBeGreaterThan(beforeFlush.length);
    expect(output.endsWith("\n")).toBe(true);
  });

  it("flush is idempotent — second call adds nothing", () => {
    let output = "";
    const spy = (t: string) => { output += t; };
    const s = makeStreamer(style, spy);
    s("text");
    s.flush();
    const afterFirstFlush = output;
    s.flush();
    expect(output).toBe(afterFirstFlush);
  });
});
