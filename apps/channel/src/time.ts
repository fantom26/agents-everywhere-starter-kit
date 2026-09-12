/**
 * Kyiv time, deterministically.
 *
 * Sessions are stored as ISO-8601 UTC instants. Everything a student reads is
 * rendered in `Europe/Kyiv` regardless of where their phone thinks it is, and
 * everything they say ("Wednesday after 18:00") is interpreted in Kyiv too.
 * Doing that conversion by hand with a fixed +02:00/+03:00 offset breaks twice
 * a year, so the offset is probed from the IANA database at the instant in
 * question.
 */
import { t } from "./strings";

export const KYIV = "Europe/Kyiv";

const FIELDS = new Intl.DateTimeFormat("en-US", {
  timeZone: KYIV,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

type WallClock = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

/** The Kyiv wall-clock reading of a UTC instant. */
export function kyivWallClock(instant: Date): WallClock {
  const parts = new Map<string, string>(
    FIELDS.formatToParts(instant).map(({ type, value }) => [type, value]),
  );
  const read = (name: string) => Number(parts.get(name));
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
    second: read("second"),
  };
}

/** Kyiv's UTC offset, in minutes, at a given instant. */
function kyivOffsetMinutes(instantMs: number): number {
  const wall = kyivWallClock(new Date(instantMs));
  const asIfUtc = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
    wall.second,
  );
  return (asIfUtc - instantMs) / 60_000;
}

/**
 * Turn a Kyiv wall-clock reading into the UTC instant it names.
 *
 * The offset depends on the instant we are solving for, so this guesses once,
 * then corrects with the offset actually in force at the guessed instant —
 * which settles every case except the one hour that DST skips entirely.
 */
export function kyivToUtc(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
): Date {
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  const corrected = naive - kyivOffsetMinutes(naive) * 60_000;
  return new Date(naive - kyivOffsetMinutes(corrected) * 60_000);
}

/** Parse `YYYY-MM-DD` (+ optional `HH:MM`) as Kyiv local time. */
export function parseKyivDate(date: string, time = "00:00"): Date | undefined {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
  const clock = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!day || !clock) return undefined;
  const at = kyivToUtc(
    Number(day[1]),
    Number(day[2]),
    Number(day[3]),
    Number(clock[1]),
    Number(clock[2]),
  );
  return Number.isNaN(at.getTime()) ? undefined : at;
}

/** Minutes past Kyiv midnight — how "after 18:00" is actually compared. */
export function kyivMinutesOfDay(instant: Date): number {
  const wall = kyivWallClock(instant);
  return wall.hour * 60 + wall.minute;
}

/** `YYYY-MM-DD` in Kyiv. */
export function kyivDateKey(instant: Date): string {
  const { year, month, day } = kyivWallClock(instant);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${year}-${pad(month)}-${pad(day)}`;
}

const LOCALE = "en-GB";

const WEEKDAY = new Intl.DateTimeFormat(LOCALE, {
  timeZone: KYIV,
  weekday: "long",
});

const DAY_MONTH = new Intl.DateTimeFormat(LOCALE, {
  timeZone: KYIV,
  day: "numeric",
  month: "long",
});

/** Short enough for a button label: "Tue 15 Sep". */
const SHORT_DAY = new Intl.DateTimeFormat(LOCALE, {
  timeZone: KYIV,
  weekday: "short",
  day: "numeric",
  month: "short",
});

/** How a session start is shown to a student: "Wednesday, 17 September, 18:30". */
export function formatKyiv(instant: Date): string {
  const { hour, minute } = kyivWallClock(instant);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${WEEKDAY.format(instant)}, ${DAY_MONTH.format(instant)}, ${pad(hour)}:${pad(minute)}`;
}

/** The label a date button carries. */
export function formatKyivDayShort(instant: Date): string {
  return SHORT_DAY.format(instant);
}

/** "in 3 h 20 min" — how far away a session is, for the 24-hour rule. */
export function formatLeadTime(from: Date, to: Date): string {
  const minutes = Math.round((to.getTime() - from.getTime()) / 60_000);
  if (minutes < 0) return t.time.started;
  if (minutes < 60) return t.time.inMinutes(minutes);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return t.time.inHours(hours, rest);
  return t.time.inDays(Math.floor(hours / 24), hours % 24);
}

const WEEKDAY_INDEX = new Intl.DateTimeFormat("en-US", { timeZone: KYIV, weekday: "short" });
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** 0 for Monday … 6 for Sunday, in Kyiv. */
function kyivWeekdayIndex(instant: Date): number {
  return Math.max(0, DAYS.indexOf(WEEKDAY_INDEX.format(instant)));
}

/**
 * The Kyiv bounds of "this week" or "next week".
 *
 * Weeks run Monday to Sunday, and "this week" starts now rather than at
 * Monday's midnight — a student asking on Thursday means the days they can
 * still attend, not the ones that have gone.
 */
export function kyivWeekWindow(now: Date, which: "this" | "next"): { fromUtc: Date; toUtc: Date } {
  const wall = kyivWallClock(now);
  const weekday = kyivWeekdayIndex(now);
  const monday = kyivToUtc(wall.year, wall.month, wall.day);
  const mondayMs = monday.getTime() - weekday * DAY_MS;

  const startMs = which === "this" ? Math.max(now.getTime(), mondayMs) : mondayMs + 7 * DAY_MS;
  const endMs = (which === "this" ? mondayMs : mondayMs + 7 * DAY_MS) + 7 * DAY_MS;

  return { fromUtc: new Date(startMs), toUtc: new Date(endMs) };
}

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;
