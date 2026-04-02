import type { AgentResult } from "./agent-types.js";

export type ApiError = {
  readonly kind: "overloaded" | "rate-limited" | "credit-exhausted" | "unknown";
  readonly retryable: boolean;
  readonly retryAt?: string;
};

const MONTHS: Readonly<Record<string, number>> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

type ZonedParts = {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
};

const zonedFormatterCache = new Map<string, Intl.DateTimeFormat>();

const getZonedFormatter = (timeZone: string): Intl.DateTimeFormat => {
  const cached = zonedFormatterCache.get(timeZone);
  if (cached) {
    return cached;
  }
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  });
  zonedFormatterCache.set(timeZone, formatter);
  return formatter;
};

const getZonedParts = (date: Date, timeZone: string): ZonedParts => {
  const parts = getZonedFormatter(timeZone).formatToParts(date);
  const valueOf = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");
  return {
    year: valueOf("year"),
    month: valueOf("month"),
    day: valueOf("day"),
    hour: valueOf("hour"),
    minute: valueOf("minute"),
  };
};

const zonedDateTimeToUtc = (parts: ZonedParts, timeZone: string): Date => {
  let guess = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);

  for (let i = 0; i < 4; i++) {
    const zoned = getZonedParts(new Date(guess), timeZone);
    const desired = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
    const actual = Date.UTC(zoned.year, zoned.month - 1, zoned.day, zoned.hour, zoned.minute);
    const diff = desired - actual;
    if (diff === 0) {
      break;
    }
    guess += diff;
  }

  return new Date(guess);
};

const extractRetryAt = (text: string, now = new Date()): string | undefined => {
  const match = text.match(
    /resets?\s+([A-Za-z]{3,9})\s+(\d{1,2})\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^)]+)\)/i,
  );
  if (!match) {
    return undefined;
  }

  const [, rawMonth, rawDay, rawHour, rawMinute, meridiem, timeZone] = match;
  const month = MONTHS[rawMonth.slice(0, 3).toLowerCase()];
  if (!month) {
    return undefined;
  }

  const day = Number(rawDay);
  const minute = Number(rawMinute ?? "0");
  const baseHour = Number(rawHour) % 12;
  const hour = meridiem.toLowerCase() === "pm" ? baseHour + 12 : baseHour;
  const zonedNow = getZonedParts(now, timeZone);
  let year = zonedNow.year;
  let retryAt = zonedDateTimeToUtc({ year, month, day, hour, minute }, timeZone);

  if (retryAt.getTime() <= now.getTime()) {
    year += 1;
    retryAt = zonedDateTimeToUtc({ year, month, day, hour, minute }, timeZone);
  }

  return retryAt.toISOString();
};

export const detectApiError = (result: AgentResult, stderr: string): ApiError | null => {
  if (result.exitCode === 0) {
    return null;
  }

  const combined = `${result.resultText}\n${stderr}`;

  if (/529|overloaded/i.test(combined)) {
    return { kind: "overloaded", retryable: true };
  }

  if (/rate\s+limit/i.test(combined)) {
    return { kind: "rate-limited", retryable: true };
  }

  if (/credit/i.test(combined) && /(exhaust|limit|exceed)/i.test(combined)) {
    return { kind: "credit-exhausted", retryable: false, retryAt: extractRetryAt(combined) };
  }

  if (/quota/i.test(combined) && /(exceed|limit)/i.test(combined)) {
    return { kind: "credit-exhausted", retryable: false, retryAt: extractRetryAt(combined) };
  }

  if (/usage\s+limit/i.test(combined) || /hit\s+your\s+limit/i.test(combined)) {
    return { kind: "credit-exhausted", retryable: false, retryAt: extractRetryAt(combined) };
  }

  return null;
};
