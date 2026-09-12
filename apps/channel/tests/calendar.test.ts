/**
 * Calendar sync, against a fake Google.
 *
 * The assertion that matters is the last one: a calendar that throws must cost
 * the student nothing. Everything else about this integration is a convenience;
 * the seat is the product.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { openDb, type Db } from "../src/db";
import { seedDatabase } from "../src/db/seed";
import { searchSessions, getBookings } from "../src/services/domain";
import * as services from "../src/services";
import {
  googleCalendar,
  noopCalendar,
  saveGoogleGrant,
  setCalendar,
  SESSION_MINUTES,
} from "../src/services/calendar";

const NOW = new Date("2026-09-12T09:00:00.000Z");
const TG = "424242";
const ME = 1;

let db: Db;

/** A Google that records instead of calling one. */
function fakeGoogle(behaviour: { fail?: boolean } = {}) {
  const calls: { method: string; url: string; body?: unknown }[] = [];
  let events = 0;

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ method, url, body: init?.body });

    if (behaviour.fail) return new Response("nope", { status: 503 });

    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      return Response.json({ access_token: "access-token", expires_in: 3600 });
    }
    if (method === "POST") {
      events += 1;
      return Response.json({ id: `event-${events}` });
    }
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;

  const errors: unknown[] = [];
  const calendar = googleCalendar({
    clientId: "client",
    clientSecret: "secret",
    fetchImpl,
    onError: (error) => errors.push(error),
  });

  return { calendar, calls, errors };
}

/** The sync is deliberately not awaited, so let its microtasks land. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const firstFree = () => searchSessions(db, { practiceTypeCode: "intermodule", limit: 2 }, NOW);

beforeEach(() => {
  db = openDb(":memory:");
  seedDatabase(db, NOW);
  services.linkByPhone(db, TG, "+380501112233");
});

afterEach(() => {
  setCalendar(noopCalendar);
});

describe("calendar sync", () => {
  it("does nothing at all when no student has connected Google", async () => {
    const google = fakeGoogle();
    setCalendar(google.calendar);

    services.book(db, TG, { sessionId: firstFree()[0].session.id }, NOW);
    await settle();

    assert.equal(google.calls.length, 0, "an unconnected student must not reach Google");
    assert.equal(getBookings(db, ME, { now: NOW }).length, 1, "and is still booked");
  });

  it("creates one event for a booking, with the session's own details", async () => {
    const google = fakeGoogle();
    setCalendar(google.calendar);
    saveGoogleGrant(db, ME, { refreshToken: "refresh", email: "student@example.com" }, NOW);

    const target = firstFree()[0];
    services.book(db, TG, { sessionId: target.session.id }, NOW);
    await settle();

    const insert = google.calls.find((call) => call.method === "POST" && call.url.includes("events"));
    assert.ok(insert, "a connected student's booking becomes an event");

    const body = JSON.parse(String(insert.body)) as {
      summary: string;
      location: string;
      start: { dateTime: string; timeZone: string };
      end: { dateTime: string };
    };
    assert.equal(body.summary, "Intermodule meeting");
    assert.equal(body.location, target.session.zoomUrl, "the Zoom link has to travel with it");
    assert.equal(body.start.dateTime, target.session.startsAt.toISOString());
    assert.equal(body.start.timeZone, "Europe/Kyiv");
    assert.equal(
      new Date(body.end.dateTime).getTime() - target.session.startsAt.getTime(),
      SESSION_MINUTES * 60_000,
    );

    // The event id is kept so the booking can withdraw it later.
    const stored = db
      .prepare(`SELECT google_event_id FROM bookings WHERE student_id = ?`)
      .get(ME) as { google_event_id: string | null };
    assert.equal(stored.google_event_id, "event-1");
  });

  it("deletes that event when the booking is cancelled", async () => {
    const google = fakeGoogle();
    setCalendar(google.calendar);
    saveGoogleGrant(db, ME, { refreshToken: "refresh" }, NOW);

    services.book(db, TG, { sessionId: firstFree()[0].session.id }, NOW);
    await settle();
    const booking = getBookings(db, ME, { now: NOW })[0];

    services.cancel(db, TG, booking.id, NOW);
    await settle();

    const remove = google.calls.find((call) => call.method === "DELETE");
    assert.ok(remove, "a cancelled seat must take its event with it");
    assert.match(remove.url, /event-1$/);
  });

  it("moves the event with a reschedule: one out, one in", async () => {
    const google = fakeGoogle();
    setCalendar(google.calendar);
    saveGoogleGrant(db, ME, { refreshToken: "refresh" }, NOW);

    const [from, to] = firstFree();
    services.book(db, TG, { sessionId: from.session.id }, NOW);
    await settle();
    const booking = getBookings(db, ME, { now: NOW })[0];

    services.reschedule(db, TG, { bookingId: booking.id, newSessionId: to.session.id }, NOW);
    await settle();

    assert.equal(google.calls.filter((call) => call.method === "DELETE").length, 1);
    assert.equal(
      google.calls.filter((call) => call.method === "POST" && call.url.includes("events")).length,
      2,
      "the original insert plus the one for the new session",
    );
  });

  it("costs the student nothing when Google is unreachable", async () => {
    const google = fakeGoogle({ fail: true });
    setCalendar(google.calendar);
    saveGoogleGrant(db, ME, { refreshToken: "refresh" }, NOW);

    const result = services.book(db, TG, { sessionId: firstFree()[0].session.id }, NOW);
    await settle();

    assert.ok(result.linked && result.outcome.ok, "the booking must still succeed");
    assert.equal(getBookings(db, ME, { now: NOW }).length, 1, "and the seat must be real");
    assert.equal(google.errors.length, 1, "the failure is reported, not swallowed silently");
  });

  it("reuses one access token across bookings", async () => {
    const google = fakeGoogle();
    setCalendar(google.calendar);
    saveGoogleGrant(db, ME, { refreshToken: "refresh" }, NOW);

    const [one, two] = firstFree();
    services.book(db, TG, { sessionId: one.session.id }, NOW);
    await settle();
    services.book(db, TG, { sessionId: two.session.id }, NOW);
    await settle();

    const refreshes = google.calls.filter((call) => call.url.includes("oauth2.googleapis.com"));
    assert.equal(refreshes.length, 1, "the hour-long token should not be fetched twice");
  });

  it("reports whether a student has connected", () => {
    const google = fakeGoogle();
    assert.equal(google.calendar.connected(db, ME), false);
    saveGoogleGrant(db, ME, { refreshToken: "refresh" }, NOW);
    assert.equal(google.calendar.connected(db, ME), true);
    assert.equal(noopCalendar.connected(db, ME), false, "the no-op is never connected");
  });
});

describe("the consent round trip", () => {
  const env = { ...process.env };

  afterEach(() => {
    process.env.GOOGLE_CLIENT_ID = env.GOOGLE_CLIENT_ID;
    process.env.GOOGLE_CLIENT_SECRET = env.GOOGLE_CLIENT_SECRET;
    process.env.PUBLIC_BASE_URL = env.PUBLIC_BASE_URL;
  });

  const configure = () => {
    process.env.GOOGLE_CLIENT_ID = "client-id";
    process.env.GOOGLE_CLIENT_SECRET = "client-secret";
    process.env.PUBLIC_BASE_URL = "https://example.test";
  };

  const unconfigure = () => {
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    delete process.env.PUBLIC_BASE_URL;
  };

  it("offers no link at all when Google is not configured", async () => {
    unconfigure();
    const { connectUrl, oauthConfigured } = await import("../src/services/google-oauth");
    assert.equal(oauthConfigured(), false);
    assert.equal(connectUrl(TG), undefined);
  });

  it("asks for offline access, or the grant would last an hour", async () => {
    configure();
    const { connectUrl } = await import("../src/services/google-oauth");

    const url = new URL(connectUrl(TG)!);
    assert.equal(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
    assert.equal(url.searchParams.get("access_type"), "offline");
    assert.equal(url.searchParams.get("prompt"), "consent");
    assert.equal(
      url.searchParams.get("redirect_uri"),
      "https://example.test/oauth/google/callback",
    );
    assert.match(url.searchParams.get("scope") ?? "", /calendar\.events$/);
  });

  it("never puts the Telegram id in the link", async () => {
    configure();
    const { connectUrl } = await import("../src/services/google-oauth");

    const url = connectUrl(TG)!;
    assert.ok(!url.includes(TG), `the state must be opaque:\n${url}`);
    const state = new URL(url).searchParams.get("state");
    assert.ok(state && state.length >= 16, "and unguessable");
  });

  it("mints a fresh state per tap", async () => {
    configure();
    const { connectUrl } = await import("../src/services/google-oauth");
    const first = new URL(connectUrl(TG)!).searchParams.get("state");
    const second = new URL(connectUrl(TG)!).searchParams.get("state");
    assert.notEqual(first, second);
  });
});
