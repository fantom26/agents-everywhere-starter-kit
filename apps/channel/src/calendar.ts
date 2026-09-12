/**
 * Google Calendar, one way and forward only.
 *
 * A booking a student cannot see in their calendar is a booking they will miss,
 * so a confirmed seat becomes an event and a cancelled one takes the event with
 * it. Everything here hangs off `services.ts`, which is the argument for having
 * that layer at all: one hook, and both the buttons and the agent get it.
 *
 * Three rules hold:
 *
 * 1. **A calendar failure never fails a booking.** The sync runs after SQLite
 *    has committed, and it is not awaited: Google being slow, rate limited or
 *    unreachable cannot turn a booked seat into an error a student sees.
 * 2. **No booking rule lives here.** This file reads rows and writes events. It
 *    decides nothing about whether a seat may be taken.
 * 3. **Unconfigured is a supported state.** With no `GOOGLE_CLIENT_ID` the
 *    no-op implementation is used and nothing changes — the same way the
 *    product runs with no model key.
 */
import type { Db } from "./db";
import { practiceTitle } from "./strings";

/**
 * How long a practice runs, for the calendar block only.
 *
 * Sessions have a start and no end — the school's own schedule does not record
 * one, and no booking rule depends on it. This is presentation: a calendar
 * needs *some* block, and 90 minutes is what these practices run.
 */
export const SESSION_MINUTES = 90;

export interface CalendarSync {
  /** A seat was taken. Add the event and remember its id against the booking. */
  booked(db: Db, studentId: number, bookingId: number): void;
  /** A seat was given back. Remove whatever event that booking created. */
  cancelled(db: Db, studentId: number, bookingId: number): void;
  /** Is this student's calendar connected? Drives whether we offer the button. */
  connected(db: Db, studentId: number): boolean;
  /** Is a Google client configured at all? */
  readonly configured: boolean;
}

/** What the calendar needs to know about a booking. One query, no domain types. */
type BookingFacts = {
  bookingId: number;
  eventId: string | null;
  startsAt: Date;
  trainer: string;
  zoomUrl: string;
  practiceCode: string;
  practiceTitle: string;
};

function bookingFacts(db: Db, studentId: number, bookingId: number): BookingFacts | undefined {
  const row = db
    .prepare(
      `SELECT b.id, b.google_event_id, s.starts_at, s.trainer, s.zoom_url,
              p.code AS practice_code, p.title AS practice_title
         FROM bookings b
         JOIN sessions s        ON s.id = b.session_id
         JOIN practice_types p  ON p.code = s.practice_type_code
        WHERE b.id = ? AND b.student_id = ?`,
    )
    .get(bookingId, studentId) as Record<string, string | number | null> | undefined;
  if (!row) return undefined;

  return {
    bookingId: Number(row.id),
    eventId: row.google_event_id === null ? null : String(row.google_event_id),
    startsAt: new Date(String(row.starts_at)),
    trainer: String(row.trainer),
    zoomUrl: String(row.zoom_url),
    practiceCode: String(row.practice_code),
    practiceTitle: String(row.practice_title),
  };
}

function refreshTokenOf(db: Db, studentId: number): string | undefined {
  const row = db
    .prepare(`SELECT google_refresh_token FROM students WHERE id = ?`)
    .get(studentId) as { google_refresh_token: string | null } | undefined;
  const token = row?.google_refresh_token;
  return token ? String(token) : undefined;
}

/** Store a student's grant. Called once, when they come back from Google. */
export function saveGoogleGrant(
  db: Db,
  studentId: number,
  grant: { refreshToken: string; email?: string },
  now = new Date(),
): void {
  db.prepare(
    `UPDATE students
        SET google_refresh_token = ?, google_email = ?, google_connected_at = ?
      WHERE id = ?`,
  ).run(grant.refreshToken, grant.email ?? null, now.toISOString(), studentId);
}

export function forgetGoogleGrant(db: Db, studentId: number): void {
  db.prepare(
    `UPDATE students
        SET google_refresh_token = NULL, google_email = NULL, google_connected_at = NULL
      WHERE id = ?`,
  ).run(studentId);
}

// ------------------------------------------------------------- the no-op

/** What runs when no Google client is configured: nothing, quietly. */
export const noopCalendar: CalendarSync = {
  booked() {},
  cancelled() {},
  connected() {
    return false;
  },
  configured: false,
};

// ------------------------------------------------------------- Google

export type GoogleConfig = {
  clientId: string;
  clientSecret: string;
  /** Injected in tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  onError?: (error: unknown) => void;
};

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const EVENTS_URL = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

/** The scope the consent screen asks for: create and delete our own events. */
export const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events";

export function googleCalendar(config: GoogleConfig): CalendarSync {
  const fetchImpl = config.fetchImpl ?? fetch;
  const report = config.onError ?? ((error: unknown) => console.error("  calendar:", error));

  // Access tokens last an hour; refresh tokens are the durable half. Keeping
  // the short-lived one in memory saves a round trip per booking and means only
  // the refresh token is ever written down.
  const accessTokens = new Map<string, { token: string; expiresAt: number }>();

  async function accessToken(refreshToken: string): Promise<string> {
    const cached = accessTokens.get(refreshToken);
    if (cached && cached.expiresAt > Date.now() + 30_000) return cached.token;

    const response = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    });
    if (!response.ok) {
      throw new Error(`Google token refresh failed: HTTP ${response.status}`);
    }
    const body = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new Error("Google returned no access token.");

    accessTokens.set(refreshToken, {
      token: body.access_token,
      expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
    });
    return body.access_token;
  }

  async function insertEvent(token: string, facts: BookingFacts): Promise<string | undefined> {
    const end = new Date(facts.startsAt.getTime() + SESSION_MINUTES * 60_000);
    const response = await fetchImpl(EVENTS_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        summary: practiceTitle(facts.practiceCode, facts.practiceTitle),
        description: `Trainer: ${facts.trainer}\n${facts.zoomUrl}`,
        location: facts.zoomUrl,
        // The instant is unambiguous in UTC; the zone is what the event is
        // *displayed* in, which for this school is always Kyiv.
        start: { dateTime: facts.startsAt.toISOString(), timeZone: "Europe/Kyiv" },
        end: { dateTime: end.toISOString(), timeZone: "Europe/Kyiv" },
      }),
    });
    if (!response.ok) throw new Error(`Google event insert failed: HTTP ${response.status}`);
    const body = (await response.json()) as { id?: string };
    return body.id;
  }

  async function deleteEvent(token: string, eventId: string): Promise<void> {
    const response = await fetchImpl(`${EVENTS_URL}/${encodeURIComponent(eventId)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    // 410 means it is already gone, which is the outcome we wanted anyway.
    if (!response.ok && response.status !== 404 && response.status !== 410) {
      throw new Error(`Google event delete failed: HTTP ${response.status}`);
    }
  }

  return {
    configured: true,

    connected(db, studentId) {
      return refreshTokenOf(db, studentId) !== undefined;
    },

    booked(db, studentId, bookingId) {
      const refreshToken = refreshTokenOf(db, studentId);
      const facts = bookingFacts(db, studentId, bookingId);
      if (!refreshToken || !facts) return;

      // Deliberately not awaited: the seat is already booked and committed.
      void (async () => {
        try {
          const eventId = await insertEvent(await accessToken(refreshToken), facts);
          if (eventId) {
            db.prepare(`UPDATE bookings SET google_event_id = ? WHERE id = ?`).run(
              eventId,
              bookingId,
            );
          }
        } catch (error) {
          report(error);
        }
      })();
    },

    cancelled(db, studentId, bookingId) {
      const refreshToken = refreshTokenOf(db, studentId);
      const facts = bookingFacts(db, studentId, bookingId);
      // No event was ever created — nothing to withdraw.
      if (!refreshToken || !facts?.eventId) return;

      const eventId = facts.eventId;
      void (async () => {
        try {
          await deleteEvent(await accessToken(refreshToken), eventId);
          db.prepare(`UPDATE bookings SET google_event_id = NULL WHERE id = ?`).run(bookingId);
        } catch (error) {
          report(error);
        }
      })();
    },
  };
}

// ------------------------------------------------------- the active instance

let active: CalendarSync = noopCalendar;

/** The calendar the services write through. */
export function calendar(): CalendarSync {
  return active;
}

/** Install a calendar. Called at startup, and by the tests with a fake. */
export function setCalendar(next: CalendarSync): void {
  active = next;
}

/** Build the calendar the environment asks for. */
export function calendarFromEnv(): CalendarSync {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return noopCalendar;
  return googleCalendar({ clientId, clientSecret });
}
