import type { AgentStyle } from "#domain/agent-types.js";

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
} as const;

export type WriteFn = (text: string) => void;

export type Streamer = ((text: string) => void) & { flush: () => void };

export const makeStreamer = (
  style: AgentStyle,
  writeFn: WriteFn = (t) => {
    process.stdout.write(t);
  },
): Streamer => {
  const gutter = `${style.color}│${ANSI.reset} `;
  const wrapIndent = `${style.color}│${ANSI.reset}   `;
  const maxWidth = (process.stdout.columns || 120) - 4;
  let atLineStart = true;
  let blankLines = 0;
  let col = 0;

  const highlight = (text: string): string =>
    text
      .replace(/\bRED\b/g, `${ANSI.bold}${ANSI.red}RED${ANSI.reset}`)
      .replace(/\bGREEN\b/g, `${ANSI.bold}${ANSI.green}GREEN${ANSI.reset}`)
      .replace(
        /\b([Cc]ommitted at|[Cc]ommit) `([a-f0-9]{7,40})`/g,
        `$1 ${ANSI.bold}${ANSI.yellow}\`$2\`${ANSI.reset}`,
      );

  const write = (text: string) => {
    // Each assistant event is a full block — add separator if needed
    if (!atLineStart) {
      writeFn("\n");
      atLineStart = true;
      blankLines = 1;
    }
    if (blankLines < 2) {
      writeFn(`${gutter}\n`);
      blankLines++;
    }

    const formatted = highlight(text);
    const words = formatted.split(/(\s+)/);

    for (const word of words) {
      if (atLineStart) {
        writeFn(gutter);
        atLineStart = false;
        col = 0;
      }
      if (word === "\n") {
        writeFn("\n");
        atLineStart = true;
        blankLines++;
        col = 0;
      } else if (word.includes("\n")) {
        for (const ch of word) {
          if (atLineStart) {
            writeFn(gutter);
            atLineStart = false;
            col = 0;
          }
          writeFn(ch);
          if (ch === "\n") {
            atLineStart = true;
            blankLines++;
            col = 0;
          } else {
            blankLines = 0;
            col++;
          }
        }
      } else if (col + word.length > maxWidth && col > 0 && word.trim()) {
        writeFn("\n");
        writeFn(wrapIndent);
        writeFn(word);
        col = 2 + word.length;
        blankLines = 0;
      } else {
        writeFn(word);
        col += word.length;
        blankLines = 0;
      }
    }
  };

  write.flush = () => {
    if (!atLineStart) {
      writeFn("\n");
      atLineStart = true;
    }
  };

  return write;
};
