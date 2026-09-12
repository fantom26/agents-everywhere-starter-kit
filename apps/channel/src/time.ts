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

const WEEKDAY = new Intl.DateTimeFormat("uk-UA", {
  timeZone: KYIV,
  weekday: "long",
});

const DAY_MONTH = new Intl.DateTimeFormat("uk-UA", {
  timeZone: KYIV,
  day: "numeric",
  month: "long",
});

/** How a session start is shown to a student: "середа, 17 вересня, 18:30". */
export function formatKyiv(instant: Date): string {
  const { hour, minute } = kyivWallClock(instant);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${WEEKDAY.format(instant)}, ${DAY_MONTH.format(instant)}, ${pad(hour)}:${pad(minute)}`;
}

/** "за 3 год 20 хв" — how far away a session is, for the 24-hour rule. */
export function formatLeadTime(from: Date, to: Date): string {
  const minutes = Math.round((to.getTime() - from.getTime()) / 60_000);
  if (minutes < 0) return "вже почалася";
  if (minutes < 60) return `за ${minutes} хв`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest ? `за ${hours} год ${rest} хв` : `за ${hours} год`;
  return `за ${Math.floor(hours / 24)} дн ${hours % 24} год`;
}

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;
