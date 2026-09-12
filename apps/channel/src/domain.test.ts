/**
 * The booking rules, tested where they actually live.
 *
 * These run against a real in-memory SQLite database and never touch the model,
 * Telegram, or the network — which is the point: the rules hold whatever the
 * agent decides to say.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { openDb, type Db } from "./db";
import { seedDatabase } from "./seed";
import {
  availability,
  bookPractice,
  bookingsDueForReminder,
  cancelBooking,
  checkBookable,
  getBookings,
  getProgress,
  markReminded,
  rescheduleBooking,
  searchSessions,
} from "./domain";
import { HOUR_MS, DAY_MS, kyivMinutesOfDay } from "./time";
import { linkStudent, normalizePhone } from "./identity";

const NOW = new Date("2026-09-12T09:00:00.000Z");

let db: Db;
let seed: ReturnType<typeof seedDatabase>;

/** The student the tests act as; seeded students hold the pre-existing bookings. */
const ME = 1;

beforeEach(() => {
  db = openDb(":memory:");
  seed = seedDatabase(db, NOW);
});

const sessionsOf = (code: string) =>
  searchSessions(db, { practiceTypeCode: code, onlyWithFreeSeats: false, limit: 50 }, NOW);

/** One of the classmates already holding a seat on a seeded session. */
const occupantOf = (sessionId: number) =>
  Number(
    (
      db
        .prepare(
          `SELECT student_id FROM bookings WHERE session_id = ? AND status = 'active' LIMIT 1`,
        )
        .get(sessionId) as { student_id: number }
    ).student_id,
  );

/** Add a throwaway student, for filling seats that the roster cannot fill. */
let fillerCount = 0;
const filler = () => {
  fillerCount += 1;
  return Number(
    db
      .prepare(`INSERT INTO students (full_name, phone) VALUES (?, ?) RETURNING id`)
      .get(`Filler ${fillerCount}`, `+38099000${String(1000 + fillerCount)}`)!.id,
  );
};

describe("capacity", () => {
  it("refuses a session that is already full", () => {
    const full = availability(db, seed.fullSessionId);
    assert.equal(full?.free, 0, "fixture must start full");
    const result = bookPractice(db, { studentId: ME, sessionId: seed.fullSessionId }, NOW);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "session_full");
    assert.equal(result.facts.capacity, 6);
  });

  it("counts a cancelled booking as a freed seat", () => {
    const classmate = occupantOf(seed.fullSessionId);
    const held = getBookings(db, classmate, { includePast: true, now: NOW }).find(
      (b) => b.sessionId === seed.fullSessionId,
    );
    assert.ok(held, "a classmate must hold a seat on the full session");
    cancelBooking(db, { studentId: classmate, bookingId: held.id }, NOW);
    assert.equal(availability(db, seed.fullSessionId)!.free, 1);
    assert.equal(bookPractice(db, { studentId: ME, sessionId: seed.fullSessionId }, NOW).ok, true);
  });
});

describe("duplicate bookings", () => {
  it("refuses a second active booking for the same session", () => {
    const session = sessionsOf("intermodule")[1];
    assert.equal(bookPractice(db, { studentId: ME, sessionId: session.session.id }, NOW).ok, true);
    const second = bookPractice(db, { studentId: ME, sessionId: session.session.id }, NOW);
    assert.equal(second.ok, false);
    if (!second.ok) assert.equal(second.reason, "already_booked");
  });

  it("allows rebooking after a cancellation", () => {
    const session = sessionsOf("intermodule")[1].session;
    const first = bookPractice(db, { studentId: ME, sessionId: session.id }, NOW);
    assert.ok(first.ok);
    cancelBooking(db, { studentId: ME, bookingId: first.bookingId }, NOW);
    assert.equal(bookPractice(db, { studentId: ME, sessionId: session.id }, NOW).ok, true);
  });
});

describe("group mentoring roles", () => {
  it("requires a role and reports which ones are free", () => {
    const result = bookPractice(db, { studentId: ME, sessionId: seed.mentoringSessionId }, NOW);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "role_required");
    assert.deepEqual(result.facts.availableRoles, ["client", "listener"]);
  });

  it("refuses a role that is already taken", () => {
    const result = bookPractice(
      db,
      { studentId: ME, sessionId: seed.mentoringSessionId, role: "coach" },
      NOW,
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "role_taken");
    assert.deepEqual(result.facts.freeRoles, ["client", "listener"]);
  });

  it("does not offer a taken role as available", () => {
    const roles = availability(db, seed.mentoringSessionId)!.roles;
    assert.equal(roles.find((r) => r.role === "coach")!.free, 0);
    assert.equal(roles.find((r) => r.role === "client")!.free, 1);
    assert.equal(roles.find((r) => r.role === "listener")!.free, 10);
  });

  it("lets exactly one student hold the client seat", () => {
    const first = bookPractice(
      db,
      { studentId: ME, sessionId: seed.mentoringSessionId, role: "client" },
      NOW,
    );
    assert.equal(first.ok, true);
    const second = bookPractice(
      db,
      { studentId: 3, sessionId: seed.mentoringSessionId, role: "client" },
      NOW,
    );
    assert.equal(second.ok, false);
    if (!second.ok) assert.equal(second.reason, "role_taken");
  });

  it("refuses a role on a practice type that has none", () => {
    const session = sessionsOf("intermodule")[1].session;
    const result = bookPractice(
      db,
      { studentId: ME, sessionId: session.id, role: "coach" },
      NOW,
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "role_not_applicable");
  });
});

describe("quota and the 24-hour rule", () => {
  /** Book the student up to their annual requirement for intermodule meetings. */
  const fillQuota = () => {
    const required = getProgress(db, ME).find((p) => p.code === "intermodule")!.required;
    const open = sessionsOf("intermodule").filter(
      (a) => a.session.id !== seed.soonSessionId && a.free > 0,
    );
    for (let i = 0; i < required; i += 1) {
      const result = bookPractice(db, { studentId: ME, sessionId: open[i].session.id }, NOW);
      assert.ok(result.ok, `fixture booking ${i} failed`);
    }
    return required;
  };

  it("allows booking freely while the requirement is unmet", () => {
    const result = bookPractice(db, { studentId: ME, sessionId: sessionsOf("intermodule")[1].session.id }, NOW);
    assert.ok(result.ok);
    assert.equal(result.isExtra, false);
  });

  it("refuses an extra booking more than 24 hours out", () => {
    const required = fillQuota();
    assert.equal(getProgress(db, ME).find((p) => p.code === "intermodule")!.booked, required);

    const mine = new Set(getBookings(db, ME, { now: NOW }).map((b) => b.sessionId));
    const faraway = sessionsOf("intermodule").find(
      (a) =>
        !mine.has(a.session.id) &&
        a.session.startsAt.getTime() - NOW.getTime() > DAY_MS &&
        a.free > 0,
    );
    assert.ok(faraway, "fixture needs an unbooked session more than a day out");
    const result = bookPractice(db, { studentId: ME, sessionId: faraway.session.id }, NOW);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "quota_reached_too_early");
    assert.equal(result.facts.required, required);
    assert.ok(typeof result.facts.bookableFrom === "string");
  });

  it("allows an extra booking inside 24 hours when a seat is free", () => {
    fillQuota();
    const soon = availability(db, seed.soonSessionId)!;
    assert.ok(soon.session.startsAt.getTime() - NOW.getTime() < DAY_MS);
    assert.ok(soon.free > 0);

    const result = bookPractice(db, { studentId: ME, sessionId: seed.soonSessionId }, NOW);
    assert.ok(result.ok, "an extra booking inside the window must be allowed");
    assert.equal(result.isExtra, true);
    assert.equal(getProgress(db, ME).find((p) => p.code === "intermodule")!.extra, 1);
  });

  it("still refuses an extra booking inside 24 hours when the session is full", () => {
    fillQuota();
    while (availability(db, seed.soonSessionId)!.free > 0) {
      assert.ok(bookPractice(db, { studentId: filler(), sessionId: seed.soonSessionId }, NOW).ok);
    }
    // Inside the window, but there is no empty seat for the rule to hand over.
    const result = bookPractice(db, { studentId: ME, sessionId: seed.soonSessionId }, NOW);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "session_full");
  });

  it("frees the quota again when a booking is cancelled", () => {
    fillQuota();
    const mine = getBookings(db, ME, { now: NOW }).filter((b) => b.practiceTitle.includes("Міжмодульні"));
    cancelBooking(db, { studentId: ME, bookingId: mine[0].id }, NOW);
    const progress = getProgress(db, ME).find((p) => p.code === "intermodule")!;
    assert.equal(progress.remaining, 1);
    const faraway = sessionsOf("intermodule").find(
      (a) => a.session.startsAt.getTime() - NOW.getTime() > DAY_MS && a.free > 0,
    )!;
    assert.equal(bookPractice(db, { studentId: ME, sessionId: faraway.session.id }, NOW).ok, true);
  });
});

describe("past sessions", () => {
  it("refuses a session that has already started", () => {
    const past = NOW.getTime() - HOUR_MS;
    const id = Number(
      db
        .prepare(
          `INSERT INTO sessions (practice_type_code, starts_at, trainer, zoom_url)
           VALUES ('intermodule', ?, 'Past', 'https://zoom.us/j/past') RETURNING id`,
        )
        .get(new Date(past).toISOString())!.id,
    );
    const result = bookPractice(db, { studentId: ME, sessionId: id }, NOW);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "session_in_past");
  });

  it("never returns a past session from a search", () => {
    const all = searchSessions(db, { onlyWithFreeSeats: false, limit: 100 }, NOW);
    for (const found of all) assert.ok(found.session.startsAt > NOW);
  });
});

describe("search", () => {
  it("filters to sessions starting after a Kyiv wall-clock time", () => {
    const evening = searchSessions(db, { afterKyivMinute: 18 * 60, limit: 100 }, NOW);
    assert.ok(evening.length > 0);
    for (const found of evening) {
      assert.ok(kyivMinutesOfDay(found.session.startsAt) >= 18 * 60);
    }
    const all = searchSessions(db, { limit: 100 }, NOW);
    assert.ok(all.length > evening.length, "fixture needs a morning session to exclude");
  });

  it("hides full sessions by default", () => {
    const ids = searchSessions(db, { limit: 100 }, NOW).map((a) => a.session.id);
    assert.ok(!ids.includes(seed.fullSessionId));
  });

  it("filters by a free role", () => {
    const asCoach = searchSessions(db, { role: "coach", limit: 100 }, NOW).map((a) => a.session.id);
    assert.ok(!asCoach.includes(seed.mentoringSessionId), "coach seat is taken there");
    const asClient = searchSessions(db, { role: "client", limit: 100 }, NOW).map((a) => a.session.id);
    assert.ok(asClient.includes(seed.mentoringSessionId));
  });

  it("respects a date window", () => {
    const to = new Date(NOW.getTime() + 2 * DAY_MS);
    for (const found of searchSessions(db, { toUtc: to, limit: 100 }, NOW)) {
      assert.ok(found.session.startsAt <= to);
    }
  });
});

describe("reschedule", () => {
  it("moves a booking within one practice type", () => {
    const open = sessionsOf("intermodule").filter((a) => a.free > 0);
    const first = bookPractice(db, { studentId: ME, sessionId: open[1].session.id }, NOW);
    assert.ok(first.ok);
    const result = rescheduleBooking(
      db,
      { studentId: ME, bookingId: first.bookingId, newSessionId: open[2].session.id },
      NOW,
    );
    assert.ok(result.ok);
    const active = getBookings(db, ME, { now: NOW });
    assert.equal(active.length, 1);
    assert.equal(active[0].sessionId, open[2].session.id);
  });

  it("refuses a move to a different practice type", () => {
    const from = sessionsOf("intermodule").filter((a) => a.free > 0)[1].session.id;
    const to = sessionsOf("trios").filter((a) => a.free > 0)[0].session.id;
    const booking = bookPractice(db, { studentId: ME, sessionId: from }, NOW);
    assert.ok(booking.ok);
    const result = rescheduleBooking(
      db,
      { studentId: ME, bookingId: booking.bookingId, newSessionId: to },
      NOW,
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "different_practice_type");
  });

  it("keeps the original booking when the new session is full", () => {
    const from = sessionsOf("trios").filter((a) => a.free > 0)[0].session.id;
    const booking = bookPractice(db, { studentId: ME, sessionId: from }, NOW);
    assert.ok(booking.ok);

    const result = rescheduleBooking(
      db,
      { studentId: ME, bookingId: booking.bookingId, newSessionId: seed.fullSessionId },
      NOW,
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "session_full");

    // The rollback is the whole point: a failed move must not cost the seat.
    const active = getBookings(db, ME, { now: NOW });
    assert.equal(active.length, 1);
    assert.equal(active[0].id, booking.bookingId);
    assert.equal(active[0].sessionId, from);
  });

  it("moves a booking even when the student is over their requirement", () => {
    // Six required bookings plus one extra taken inside the 24-hour window.
    const required = getProgress(db, ME).find((p) => p.code === "intermodule")!.required;
    const open = sessionsOf("intermodule").filter(
      (a) => a.session.id !== seed.soonSessionId && a.free > 0,
    );
    const first = [];
    for (let i = 0; i < required; i += 1) {
      const result = bookPractice(db, { studentId: ME, sessionId: open[i].session.id }, NOW);
      assert.ok(result.ok);
      first.push(result.bookingId);
    }
    const extra = bookPractice(db, { studentId: ME, sessionId: seed.soonSessionId }, NOW);
    assert.ok(extra.ok);
    assert.equal(extra.isExtra, true);

    // A far-out session they do not hold. Booking it outright must be refused…
    const spare = open[required];
    assert.ok(spare);
    const asNew = bookPractice(db, { studentId: ME, sessionId: spare.session.id }, NOW);
    assert.equal(asNew.ok, false);
    if (!asNew.ok) assert.equal(asNew.reason, "quota_reached_too_early");

    // …but moving a seat they already hold onto it must succeed, because the
    // number of seats they hold does not change.
    const moved = rescheduleBooking(
      db,
      { studentId: ME, bookingId: first[0], newSessionId: spare.session.id },
      NOW,
    );
    assert.ok(moved.ok, `move should succeed, got ${JSON.stringify(moved)}`);
    assert.equal(moved.booked.isExtra, false, "a required booking stays required after a move");
    assert.equal(
      getProgress(db, ME).find((p) => p.code === "intermodule")!.booked,
      required + 1,
    );
  });

  it("keeps an extra booking marked as extra when it is moved", () => {
    const required = getProgress(db, ME).find((p) => p.code === "intermodule")!.required;
    const open = sessionsOf("intermodule").filter(
      (a) => a.session.id !== seed.soonSessionId && a.free > 0,
    );
    for (let i = 0; i < required; i += 1) {
      assert.ok(bookPractice(db, { studentId: ME, sessionId: open[i].session.id }, NOW).ok);
    }
    const extra = bookPractice(db, { studentId: ME, sessionId: seed.soonSessionId }, NOW);
    assert.ok(extra.ok);

    const moved = rescheduleBooking(
      db,
      { studentId: ME, bookingId: extra.bookingId, newSessionId: open[required].session.id },
      NOW,
    );
    assert.ok(moved.ok);
    assert.equal(moved.booked.isExtra, true);
    assert.equal(getProgress(db, ME).find((p) => p.code === "intermodule")!.extra, 1);
  });

  it("does not count the released seat against the student's own quota", () => {
    const required = getProgress(db, ME).find((p) => p.code === "intermodule")!.required;
    const open = sessionsOf("intermodule").filter(
      (a) => a.session.id !== seed.soonSessionId && a.free > 0,
    );
    const booked = [];
    for (let i = 0; i < required; i += 1) {
      const result = bookPractice(db, { studentId: ME, sessionId: open[i].session.id }, NOW);
      assert.ok(result.ok);
      booked.push(result.bookingId);
    }
    // At the quota limit, moving an existing booking to another far-out session
    // must still work — the student is not adding a seat, only moving one.
    const spare = open[required];
    assert.ok(spare, "fixture needs one more open session than the requirement");
    const result = rescheduleBooking(
      db,
      { studentId: ME, bookingId: booked[0], newSessionId: spare.session.id },
      NOW,
    );
    assert.ok(result.ok, `reschedule at quota should succeed, got ${JSON.stringify(result)}`);
    assert.equal(getProgress(db, ME).find((p) => p.code === "intermodule")!.booked, required);
  });
});

describe("progress", () => {
  it("starts at zero and tracks active bookings", () => {
    const before = getProgress(db, ME).find((p) => p.code === "trios")!;
    assert.equal(before.booked, 0);
    assert.equal(before.remaining, before.required);

    const session = sessionsOf("trios").filter((a) => a.free > 0)[0].session.id;
    const booking = bookPractice(db, { studentId: ME, sessionId: session }, NOW);
    assert.ok(booking.ok);

    const after = getProgress(db, ME).find((p) => p.code === "trios")!;
    assert.equal(after.booked, 1);
    assert.equal(after.remaining, before.required - 1);

    cancelBooking(db, { studentId: ME, bookingId: booking.bookingId }, NOW);
    assert.equal(getProgress(db, ME).find((p) => p.code === "trios")!.booked, 0);
  });
});

describe("checkBookable as an explanation", () => {
  it("gives the same refusal without writing anything", () => {
    const before = availability(db, seed.fullSessionId)!.taken;
    const check = checkBookable(db, { studentId: ME, sessionId: seed.fullSessionId }, NOW);
    assert.equal(check.ok, false);
    if (!check.ok) assert.equal(check.reason, "session_full");
    assert.equal(availability(db, seed.fullSessionId)!.taken, before);
  });
});

describe("reminders", () => {
  it("finds a linked student's booking inside the window exactly once", () => {
    linkStudent(db, "555001", "+380501112233");
    const booking = bookPractice(db, { studentId: ME, sessionId: seed.soonSessionId }, NOW);
    assert.ok(booking.ok);

    const start = availability(db, seed.soonSessionId)!.session.startsAt;
    const from = new Date(start.getTime() - 65 * 60_000);
    const to = new Date(start.getTime() - 55 * 60_000);
    // Reminder check running an hour before the session.
    const due = bookingsDueForReminder(db, new Date(to.getTime()), new Date(from.getTime() + 70 * 60_000));
    const mine = due.find((d) => d.id === booking.bookingId);
    assert.ok(mine, "a booking an hour out must be due");
    assert.equal(mine.telegramUserId, "555001");

    markReminded(db, mine.id, NOW);
    const second = bookingsDueForReminder(
      db,
      new Date(to.getTime()),
      new Date(from.getTime() + 70 * 60_000),
    );
    assert.ok(!second.some((d) => d.id === booking.bookingId), "must not remind twice");
  });

  it("ignores bookings whose student has not linked Telegram", () => {
    const booking = bookPractice(db, { studentId: ME, sessionId: seed.soonSessionId }, NOW);
    assert.ok(booking.ok);
    const start = availability(db, seed.soonSessionId)!.session.startsAt;
    const due = bookingsDueForReminder(
      db,
      new Date(start.getTime() - 2 * HOUR_MS),
      new Date(start.getTime()),
    );
    assert.ok(!due.some((d) => d.id === booking.bookingId));
  });

  it("ignores a cancelled booking", () => {
    linkStudent(db, "555002", "+380501112233");
    const booking = bookPractice(db, { studentId: ME, sessionId: seed.soonSessionId }, NOW);
    assert.ok(booking.ok);
    cancelBooking(db, { studentId: ME, bookingId: booking.bookingId }, NOW);
    const start = availability(db, seed.soonSessionId)!.session.startsAt;
    const due = bookingsDueForReminder(
      db,
      new Date(start.getTime() - 2 * HOUR_MS),
      new Date(start.getTime()),
    );
    assert.equal(due.length, 0);
  });
});

describe("identity", () => {
  it("normalizes the phone formats students actually type", () => {
    const canonical = normalizePhone("+380501112233");
    for (const written of ["0501112233", "380501112233", "+38 (050) 111-22-33", "50 111 22 33"]) {
      assert.equal(normalizePhone(written), canonical, written);
    }
  });

  it("links a roster student and is idempotent", () => {
    const first = linkStudent(db, "9001", "0501112233");
    assert.ok(first.ok);
    assert.equal(first.student.fullName, "Олена Ковальчук");
    assert.equal(first.alreadyLinked, false);
    const again = linkStudent(db, "9001", "+380501112233");
    assert.ok(again.ok);
    assert.equal(again.alreadyLinked, true);
  });

  it("refuses a number that is not on the roster", () => {
    const result = linkStudent(db, "9002", "+380000000000");
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "no_such_phone");
  });

  it("refuses to move a linked number to another Telegram account", () => {
    assert.ok(linkStudent(db, "9003", "0501112233").ok);
    const stolen = linkStudent(db, "9004", "0501112233");
    assert.equal(stolen.ok, false);
    if (!stolen.ok) assert.equal(stolen.reason, "phone_taken");
  });
});
