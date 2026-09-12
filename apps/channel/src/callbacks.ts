/**
 * The callback grammar — every button's payload, and how to read it back.
 *
 * Telegram gives an inline button 64 bytes of `callback_data` and nothing else.
 * That is the entire memory of the button UI, and it is deliberately the only
 * one: **no navigation state is held in the process.** A student who taps a
 * button on a card posted before a restart still lands on the right screen,
 * because the screen is named in the payload rather than looked up in a map
 * that died with the old process.
 *
 * Two mechanical facts drive the encoding:
 *
 * - A `<Button value="x">` with no `onClick` renders `callback_data` as
 *   `JSON.stringify(value)` — the quotes are on the wire. `decode` accepts both
 *   forms so a test can read what a card rendered.
 * - A payload over 64 bytes makes the Telegram adapter **drop the button
 *   silently**. `fitsTelegram` exists so a test catches that rather than a
 *   student finding a keyboard with a missing row.
 *
 * Keep the tokens short for that reason, and keep this file free of anything
 * but parsing: no database, no rules, no strings a student reads.
 */
import type { Role } from "./domain";

/** Practice-type token → the `practice_types.code` it selects. `all` selects every type. */
export const TYPE_TOKENS = {
  trios: "trios",
  inter: "intermodule",
  ment: "mentoring",
} as const;

export type TypeToken = keyof typeof TYPE_TOKENS | "all";

/** `w` this week, `n` next week, `d` pick an exact date. */
export type Period = "w" | "n" | "d";

const ROLES: Role[] = ["coach", "client", "listener"];

export type Action =
  | { kind: "menu" }
  | { kind: "find" }
  | { kind: "findPeriod"; type: TypeToken }
  | { kind: "findSlots"; type: TypeToken; period: Period }
  | { kind: "findOnDate"; type: TypeToken; date: string }
  | { kind: "session"; sessionId: number }
  | { kind: "book"; sessionId: number; role?: Role }
  | { kind: "progress" }
  | { kind: "bookings" }
  | { kind: "cancelAsk"; bookingId: number }
  | { kind: "cancelDo"; bookingId: number }
  | { kind: "reschedule"; bookingId: number }
  | { kind: "reschedulePeriod"; bookingId: number; period: Period }
  | { kind: "rescheduleDo"; bookingId: number; sessionId: number }
  | { kind: "info" }
  | { kind: "calendar" }
  | { kind: "noop" };

/**
 * The builders. Screens call these; nothing composes a payload by hand.
 *
 * Every value here is also a valid "go back to this screen" target, which is
 * what makes `Back` a one-liner on every card.
 */
export const cb = {
  menu: () => "m",
  find: () => "f",
  findPeriod: (type: TypeToken) => `f:${type}`,
  findSlots: (type: TypeToken, period: Period) => `f:${type}:${period}`,
  findOnDate: (type: TypeToken, date: string) => `f:${type}:d:${date}`,
  session: (sessionId: number) => `s:${sessionId}`,
  book: (sessionId: number, role?: Role) =>
    role ? `b:${sessionId}:${role}` : `b:${sessionId}`,
  progress: () => "p",
  bookings: () => "k",
  cancelAsk: (bookingId: number) => `c:${bookingId}`,
  cancelDo: (bookingId: number) => `C:${bookingId}`,
  reschedule: (bookingId: number) => `x:${bookingId}`,
  reschedulePeriod: (bookingId: number, period: Period) => `x:${bookingId}:${period}`,
  rescheduleDo: (bookingId: number, sessionId: number) => `X:${bookingId}:${sessionId}`,
  info: () => "i",
  calendar: () => "g",
  noop: () => "noop",
} as const;

/** Telegram's own limit, in bytes, for one button's callback_data. */
export const CALLBACK_DATA_LIMIT = 64;

/** What the renderer will put on the wire for a `value` prop. */
export function wireForm(value: string): string {
  return JSON.stringify(value);
}

/** Does this payload survive Telegram's 64-byte cap once JSON-encoded? */
export function fitsTelegram(value: string): boolean {
  return Buffer.byteLength(wireForm(value), "utf8") <= CALLBACK_DATA_LIMIT;
}

const isTypeToken = (value: string): value is TypeToken =>
  value === "all" || Object.hasOwn(TYPE_TOKENS, value);

const isPeriod = (value: string): value is Period =>
  value === "w" || value === "n" || value === "d";

const isRole = (value: string): value is Role => (ROLES as string[]).includes(value);

const id = (value: string | undefined): number | undefined => {
  if (!value || !/^\d{1,12}$/.test(value)) return undefined;
  return Number(value);
};

/** An ISO Kyiv date, exactly as `findOnDate` wrote it. */
const isDate = (value: string | undefined): value is string =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);

/**
 * Read a payload back.
 *
 * Total by construction: anything unrecognised returns `undefined`, and the
 * router turns that into the menu plus a note rather than an error a student
 * has to interpret. Accepts the JSON-quoted wire form as well as the raw value.
 */
export function decode(raw: string | undefined): Action | undefined {
  if (!raw) return undefined;

  let value = raw;
  if (value.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed !== "string") return undefined;
      value = parsed;
    } catch {
      return undefined;
    }
  }

  const [head, a, b, c] = value.split(":");

  switch (head) {
    case "m":
      return { kind: "menu" };
    case "p":
      return { kind: "progress" };
    case "k":
      return { kind: "bookings" };
    case "i":
      return { kind: "info" };
    case "g":
      return { kind: "calendar" };
    case "noop":
      return { kind: "noop" };

    case "f": {
      if (a === undefined) return { kind: "find" };
      if (!isTypeToken(a)) return undefined;
      if (b === undefined) return { kind: "findPeriod", type: a };
      if (!isPeriod(b)) return undefined;
      // `f:<type>:d` opens the date picker; `f:<type>:d:<date>` picks one.
      if (b === "d" && c !== undefined) {
        return isDate(c) ? { kind: "findOnDate", type: a, date: c } : undefined;
      }
      return { kind: "findSlots", type: a, period: b };
    }

    case "s": {
      const sessionId = id(a);
      return sessionId === undefined ? undefined : { kind: "session", sessionId };
    }

    case "b": {
      const sessionId = id(a);
      if (sessionId === undefined) return undefined;
      if (b === undefined) return { kind: "book", sessionId };
      return isRole(b) ? { kind: "book", sessionId, role: b } : undefined;
    }

    case "c": {
      const bookingId = id(a);
      return bookingId === undefined ? undefined : { kind: "cancelAsk", bookingId };
    }

    case "C": {
      const bookingId = id(a);
      return bookingId === undefined ? undefined : { kind: "cancelDo", bookingId };
    }

    case "x": {
      const bookingId = id(a);
      if (bookingId === undefined) return undefined;
      if (b === undefined) return { kind: "reschedule", bookingId };
      return isPeriod(b) ? { kind: "reschedulePeriod", bookingId, period: b } : undefined;
    }

    case "X": {
      const bookingId = id(a);
      const sessionId = id(b);
      if (bookingId === undefined || sessionId === undefined) return undefined;
      return { kind: "rescheduleDo", bookingId, sessionId };
    }

    default:
      return undefined;
  }
}

/** The practice code a type token selects, or undefined for "every type". */
export function codeFor(token: TypeToken): string | undefined {
  return token === "all" ? undefined : TYPE_TOKENS[token];
}

/** The token that selects a practice code, for building a Back target. */
export function tokenFor(code: string): TypeToken {
  const found = (Object.keys(TYPE_TOKENS) as (keyof typeof TYPE_TOKENS)[]).find(
    (key) => TYPE_TOKENS[key] === code,
  );
  return found ?? "all";
}
