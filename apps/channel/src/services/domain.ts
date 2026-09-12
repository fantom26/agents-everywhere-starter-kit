/**
 * The booking rules.
 *
 * This file is the whole point of the project: every decision about whether a
 * student may take a seat is made here, in ordinary TypeScript against SQLite,
 * and never by the model. The agent chooses *which* of these functions to call
 * and how to explain the answer; it cannot talk any of them into a different
 * result, because the only thing it can do is pass arguments.
 *
 * Failures are values, not exceptions: every rejection carries a machine
 * `reason` plus the facts behind it, so the agent can explain precisely why a
 * booking was refused instead of guessing.
 */
import type { Db } from "../db";
import { Rollback, transact } from "../db";
import { DAY_MS, kyivMinutesOfDay } from "../time";

export type Role = "coach" | "client" | "listener";

export type PracticeType = {
  code: string;
  title: string;
  capacity: number;
  requiredPerYear: number;
  roleBased: boolean;
  roles: { role: Role; seats: number }[];
};

export type SessionRow = {
  id: number;
  practiceTypeCode: string;
  startsAt: Date;
  trainer: string;
  zoomUrl: string;
};

export type RoleAvailability = {
  role: Role;
  seats: number;
  taken: number;
  free: number;
};

export type Availability = {
  session: SessionRow;
  type: PracticeType;
  taken: number;
  capacity: number;
  free: number;
  roles: RoleAvailability[];
};

export type BookingRow = {
  id: number;
  sessionId: number;
  studentId: number;
  role: Role | null;
  status: "active" | "cancelled";
  isExtra: boolean;
  createdAt: string;
};

export type Refusal =
  | "session_not_found"
  | "session_in_past"
  | "already_booked"
  | "session_full"
  | "role_required"
  | "role_not_applicable"
  | "unknown_role"
  | "role_taken"
  | "quota_reached_too_early"
  | "booking_not_found"
  | "different_practice_type";

export type BookOutcome =
  | { ok: true; bookingId: number; isExtra: boolean; availability: Availability }
  | { ok: false; reason: Refusal; explanation: string; facts: Record<string, unknown> };

const refuse = (
  reason: Refusal,
  explanation: string,
  facts: Record<string, unknown> = {},
): BookOutcome => ({ ok: false, reason, explanation, facts });

/** A booking made after the annual requirement is met is only legal this close to the start. */
export const EXTRA_BOOKING_WINDOW_MS = DAY_MS;

// ---------------------------------------------------------------- reads

export function listPracticeTypes(db: Db): PracticeType[] {
  const types = db
    .prepare(
      `SELECT code, title, capacity, required_per_year, role_based
         FROM practice_types ORDER BY title`,
    )
    .all() as Record<string, string | number>[];
  const roles = db
    .prepare(`SELECT practice_type_code, role, seats FROM practice_roles`)
    .all() as Record<string, string | number>[];
  return types.map((row) => ({
    code: String(row.code),
    title: String(row.title),
    capacity: Number(row.capacity),
    requiredPerYear: Number(row.required_per_year),
    roleBased: Number(row.role_based) === 1,
    roles: roles
      .filter((r) => r.practice_type_code === row.code)
      .map((r) => ({ role: String(r.role) as Role, seats: Number(r.seats) })),
  }));
}

export function getPracticeType(db: Db, code: string): PracticeType | undefined {
  return listPracticeTypes(db).find((type) => type.code === code);
}

export function getSession(db: Db, sessionId: number): SessionRow | undefined {
  const row = db
    .prepare(
      `SELECT id, practice_type_code, starts_at, trainer, zoom_url
         FROM sessions WHERE id = ?`,
    )
    .get(sessionId) as Record<string, string | number> | undefined;
  if (!row) return undefined;
  return {
    id: Number(row.id),
    practiceTypeCode: String(row.practice_type_code),
    startsAt: new Date(String(row.starts_at)),
    trainer: String(row.trainer),
    zoomUrl: String(row.zoom_url),
  };
}

/** Seats taken right now, overall and per role. Never cached — always counted. */
export function availability(db: Db, sessionId: number): Availability | undefined {
  const session = getSession(db, sessionId);
  if (!session) return undefined;
  const type = getPracticeType(db, session.practiceTypeCode);
  if (!type) return undefined;

  const taken = Number(
    (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM bookings WHERE session_id = ? AND status = 'active'`,
        )
        .get(sessionId) as { n: number }
    ).n,
  );

  const perRole = db
    .prepare(
      `SELECT role, COUNT(*) AS n FROM bookings
        WHERE session_id = ? AND status = 'active' AND role IS NOT NULL
        GROUP BY role`,
    )
    .all(sessionId) as { role: string; n: number }[];

  const roles = type.roles.map(({ role, seats }) => {
    const used = Number(perRole.find((r) => r.role === role)?.n ?? 0);
    return { role, seats, taken: used, free: Math.max(0, seats - used) };
  });

  return {
    session,
    type,
    taken,
    capacity: type.capacity,
    free: Math.max(0, type.capacity - taken),
    roles,
  };
}

export type Progress = {
  code: string;
  title: string;
  required: number;
  booked: number;
  remaining: number;
  extra: number;
  complete: boolean;
};

/**
 * Progress per practice type.
 *
 * The MVP has no attendance system, so an active booking *is* progress — which
 * is exactly why cancelling one has to give the seat back to the quota, and it
 * does: the count is a live query over active bookings, not a stored counter
 * that could drift.
 */
export function getProgress(db: Db, studentId: number): Progress[] {
  const counts = db
    .prepare(
      `SELECT s.practice_type_code AS code,
              COUNT(*) AS booked,
              SUM(b.is_extra) AS extra
         FROM bookings b
         JOIN sessions s ON s.id = b.session_id
        WHERE b.student_id = ? AND b.status = 'active'
        GROUP BY s.practice_type_code`,
    )
    .all(studentId) as { code: string; booked: number; extra: number | null }[];

  return listPracticeTypes(db).map((type) => {
    const row = counts.find((c) => c.code === type.code);
    const booked = Number(row?.booked ?? 0);
    const extra = Number(row?.extra ?? 0);
    return {
      code: type.code,
      title: type.title,
      required: type.requiredPerYear,
      booked,
      remaining: Math.max(0, type.requiredPerYear - booked),
      extra,
      complete: booked >= type.requiredPerYear,
    };
  });
}

export type BookingView = BookingRow & {
  session: SessionRow;
  practiceTitle: string;
};

export function getBookings(
  db: Db,
  studentId: number,
  opts: { includePast?: boolean; now?: Date } = {},
): BookingView[] {
  const now = opts.now ?? new Date();
  const rows = db
    .prepare(
      `SELECT b.id, b.session_id, b.student_id, b.role, b.status, b.is_extra, b.created_at
         FROM bookings b
         JOIN sessions s ON s.id = b.session_id
        WHERE b.student_id = ? AND b.status = 'active'
        ORDER BY s.starts_at`,
    )
    .all(studentId) as Record<string, string | number | null>[];

  const views: BookingView[] = [];
  for (const row of rows) {
    const session = getSession(db, Number(row.session_id));
    if (!session) continue;
    if (!opts.includePast && session.startsAt.getTime() <= now.getTime()) continue;
    const type = getPracticeType(db, session.practiceTypeCode);
    views.push({
      id: Number(row.id),
      sessionId: Number(row.session_id),
      studentId: Number(row.student_id),
      role: (row.role as Role | null) ?? null,
      status: "active",
      isExtra: Number(row.is_extra) === 1,
      createdAt: String(row.created_at),
      session,
      practiceTitle: type?.title ?? session.practiceTypeCode,
    });
  }
  return views;
}

export type SearchFilters = {
  practiceTypeCode?: string;
  fromUtc?: Date;
  toUtc?: Date;
  /** Minutes past Kyiv midnight; "after 18:00" is 1080. */
  afterKyivMinute?: number;
  beforeKyivMinute?: number;
  onlyWithFreeSeats?: boolean;
  role?: Role;
  limit?: number;
};

/**
 * Search sessions the student could plausibly attend.
 *
 * Past sessions are excluded unconditionally — the agent is never handed a
 * session it could then offer, which is half of "the agent must never invent
 * availability". The other half is that every seat count here is counted, not
 * remembered.
 */
export function searchSessions(
  db: Db,
  filters: SearchFilters = {},
  now = new Date(),
): Availability[] {
  const from = filters.fromUtc && filters.fromUtc > now ? filters.fromUtc : now;
  const where = ["starts_at > ?"];
  const params: string[] = [from.toISOString()];
  if (filters.toUtc) {
    where.push("starts_at <= ?");
    params.push(filters.toUtc.toISOString());
  }
  if (filters.practiceTypeCode) {
    where.push("practice_type_code = ?");
    params.push(filters.practiceTypeCode);
  }
  const rows = db
    .prepare(`SELECT id FROM sessions WHERE ${where.join(" AND ")} ORDER BY starts_at`)
    .all(...params) as { id: number }[];

  const found = rows
    .map((row) => availability(db, Number(row.id)))
    .filter((a): a is Availability => a !== undefined)
    .filter((a) => {
      const minute = kyivMinutesOfDay(a.session.startsAt);
      if (filters.afterKyivMinute !== undefined && minute < filters.afterKyivMinute) return false;
      if (filters.beforeKyivMinute !== undefined && minute > filters.beforeKyivMinute) return false;
      if (filters.onlyWithFreeSeats !== false && a.free <= 0) return false;
      if (filters.role) {
        const role = a.roles.find((r) => r.role === filters.role);
        if (!role || role.free <= 0) return false;
      }
      return true;
    });

  return found.slice(0, filters.limit ?? 10);
}

// ---------------------------------------------------------------- rules

/**
 * Every check a booking must pass, in order, without writing anything.
 *
 * `book_practice` runs this inside the write transaction; `get_practice_details`
 * runs it speculatively so the agent can answer "why can't I book this?"
 * with the real reason rather than a plausible-sounding one.
 */
export function checkBookable(
  db: Db,
  input: {
    studentId: number;
    sessionId: number;
    role?: Role | null;
    /**
     * Set when the student is moving a seat they already hold.
     *
     * The quota rule exists to stop a student who is already done from taking
     * *additional* seats early. A move is net-zero — they give one back and take
     * one — so it has nothing to say, and applying it anyway would strand any
     * student sitting at or above their requirement: their own released seat
     * would be counted against them.
     */
    isMove?: boolean;
  },
  now = new Date(),
): { ok: true; isExtra: boolean; availability: Availability } | Extract<BookOutcome, { ok: false }> {
  const avail = availability(db, input.sessionId);
  if (!avail) return refuse("session_not_found", `There is no session with id ${input.sessionId}.`);

  const { session, type } = avail;
  const startsInMs = session.startsAt.getTime() - now.getTime();
  if (startsInMs <= 0) {
    return refuse("session_in_past", "That session has already started.", {
      sessionId: session.id,
      startsAt: session.startsAt.toISOString(),
    });
  }

  // Reschedule releases the old seat before re-checking, so an active booking
  // found here is always a genuine duplicate.
  const duplicate = db
    .prepare(
      `SELECT id FROM bookings
        WHERE session_id = ? AND student_id = ? AND status = 'active'`,
    )
    .get(input.sessionId, input.studentId) as { id: number } | undefined;
  if (duplicate) {
    return refuse("already_booked", "The student already holds an active booking for this session.", {
      bookingId: Number(duplicate.id),
    });
  }

  // Role validity, before role availability: asking for a coach seat at an
  // intermodule meeting is a different mistake from asking for a taken one.
  const role = input.role ?? null;
  if (type.roleBased && !role) {
    return refuse("role_required", `${type.title} is booked by role. Ask the student which role they want.`, {
      availableRoles: avail.roles.filter((r) => r.free > 0).map((r) => r.role),
    });
  }
  if (!type.roleBased && role) {
    return refuse("role_not_applicable", `${type.title} has no roles; book it without one.`, {});
  }
  if (role) {
    const seat = avail.roles.find((r) => r.role === role);
    if (!seat) {
      return refuse("unknown_role", `${type.title} has no role "${role}".`, {
        validRoles: avail.roles.map((r) => r.role),
      });
    }
    if (seat.free <= 0) {
      return refuse("role_taken", `The ${role} seat for this session is already taken.`, {
        role,
        seats: seat.seats,
        taken: seat.taken,
        freeRoles: avail.roles.filter((r) => r.free > 0).map((r) => r.role),
      });
    }
  }

  if (avail.taken >= type.capacity) {
    return refuse("session_full", `This session is full (${avail.taken}/${type.capacity}).`, {
      taken: avail.taken,
      capacity: type.capacity,
    });
  }

  // The quota / 24-hour rule. A student who still needs this practice takes a
  // seat freely. A student who is already done may only take a seat that would
  // otherwise go empty — which is what "within 24 hours" is standing in for.
  const booked = Number(
    (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM bookings b
             JOIN sessions s ON s.id = b.session_id
            WHERE b.student_id = ? AND b.status = 'active'
              AND s.practice_type_code = ?`,
        )
        .get(input.studentId, type.code) as { n: number }
    ).n,
  );

  const quotaMet = booked >= type.requiredPerYear;
  if (quotaMet && !input.isMove && startsInMs > EXTRA_BOOKING_WINDOW_MS) {
    return refuse(
      "quota_reached_too_early",
      `The student has already met the annual requirement for ${type.title} (${booked}/${type.requiredPerYear}). An extra booking is only allowed within 24 hours of the start, so that required seats stay available for students who still need them. This session starts later than that.`,
      {
        booked,
        required: type.requiredPerYear,
        startsAt: session.startsAt.toISOString(),
        hoursUntilStart: Math.round(startsInMs / 3_600_000),
        bookableFrom: new Date(session.startsAt.getTime() - EXTRA_BOOKING_WINDOW_MS).toISOString(),
      },
    );
  }

  return { ok: true, isExtra: quotaMet, availability: avail };
}

export function bookPractice(
  db: Db,
  input: { studentId: number; sessionId: number; role?: Role | null },
  now = new Date(),
): BookOutcome {
  try {
    return transact(db, () => {
      const check = checkBookable(db, input, now);
      if (!check.ok) throw new Rollback(check);
      const info = db
        .prepare(
          `INSERT INTO bookings (session_id, student_id, role, status, is_extra, created_at)
           VALUES (?, ?, ?, 'active', ?, ?)`,
        )
        .run(
          input.sessionId,
          input.studentId,
          input.role ?? null,
          check.isExtra ? 1 : 0,
          now.toISOString(),
        );
      const bookingId = Number(info.lastInsertRowid);
      const after = availability(db, input.sessionId);
      return {
        ok: true as const,
        bookingId,
        isExtra: check.isExtra,
        availability: after ?? check.availability,
      };
    });
  } catch (error) {
    if (error instanceof Rollback) return error.result as BookOutcome;
    // A unique-index violation means someone took the seat between the check
    // and the insert. Report it as the refusal it is, not as a crash.
    const message = error instanceof Error ? error.message : String(error);
    if (/UNIQUE constraint failed/i.test(message)) {
      return /role/i.test(message)
        ? refuse("role_taken", "That role was taken moments ago by someone else.", {})
        : refuse("already_booked", "A booking for this session already exists.", {});
    }
    throw error;
  }
}

export type CancelOutcome =
  | { ok: true; booking: BookingView }
  | { ok: false; reason: Refusal; explanation: string; facts: Record<string, unknown> };

export function cancelBooking(
  db: Db,
  input: { studentId: number; bookingId: number },
  now = new Date(),
): CancelOutcome {
  const booking = getBookings(db, input.studentId, { includePast: true }).find(
    (b) => b.id === input.bookingId,
  );
  if (!booking) {
    return {
      ok: false,
      reason: "booking_not_found",
      explanation: "This student has no active booking with that id.",
      facts: { bookingId: input.bookingId },
    };
  }
  db.prepare(
    `UPDATE bookings SET status = 'cancelled', cancelled_at = ? WHERE id = ? AND student_id = ?`,
  ).run(now.toISOString(), input.bookingId, input.studentId);
  return { ok: true, booking };
}

export type RescheduleOutcome =
  | { ok: true; cancelled: BookingView; booked: Extract<BookOutcome, { ok: true }> }
  | { ok: false; reason: Refusal; explanation: string; facts: Record<string, unknown> };

/**
 * Move a booking to another session of the same practice type.
 *
 * Both halves happen in one transaction, and the new seat is evaluated with the
 * old booking already released — otherwise a student at their quota limit could
 * never move a booking, because their own seat would count against them. If the
 * new seat is unbookable for any reason, the whole thing rolls back and the
 * student keeps the seat they had.
 */
export function rescheduleBooking(
  db: Db,
  input: { studentId: number; bookingId: number; newSessionId: number; role?: Role | null },
  now = new Date(),
): RescheduleOutcome {
  try {
    return transact(db, () => {
      const current = getBookings(db, input.studentId, { includePast: true }).find(
        (b) => b.id === input.bookingId,
      );
      if (!current) {
        throw new Rollback({
          ok: false as const,
          reason: "booking_not_found" as const,
          explanation: "This student has no active booking with that id.",
          facts: { bookingId: input.bookingId },
        });
      }
      const target = getSession(db, input.newSessionId);
      if (!target) {
        throw new Rollback({
          ok: false as const,
          reason: "session_not_found" as const,
          explanation: `There is no session with id ${input.newSessionId}.`,
          facts: { sessionId: input.newSessionId },
        });
      }
      if (target.practiceTypeCode !== current.session.practiceTypeCode) {
        throw new Rollback({
          ok: false as const,
          reason: "different_practice_type" as const,
          explanation:
            "Rescheduling moves a booking within one practice type. Moving to a different practice means cancelling this booking and making a new one, which changes the student's progress in both types.",
          facts: {
            from: current.session.practiceTypeCode,
            to: target.practiceTypeCode,
          },
        });
      }

      db.prepare(
        `UPDATE bookings SET status = 'cancelled', cancelled_at = ? WHERE id = ? AND student_id = ?`,
      ).run(now.toISOString(), input.bookingId, input.studentId);

      const role = input.role ?? current.role;
      const check = checkBookable(
        db,
        { studentId: input.studentId, sessionId: input.newSessionId, role, isMove: true },
        now,
      );
      if (!check.ok) throw new Rollback(check);

      // A move carries its original standing across. Recomputing it would turn
      // a required booking into an "extra" one purely because the student has
      // since reached their quota, quietly changing what their progress means.
      const info = db
        .prepare(
          `INSERT INTO bookings (session_id, student_id, role, status, is_extra, created_at)
           VALUES (?, ?, ?, 'active', ?, ?)`,
        )
        .run(
          input.newSessionId,
          input.studentId,
          role ?? null,
          current.isExtra ? 1 : 0,
          now.toISOString(),
        );

      const after = availability(db, input.newSessionId);
      return {
        ok: true as const,
        cancelled: current,
        booked: {
          ok: true as const,
          bookingId: Number(info.lastInsertRowid),
          isExtra: current.isExtra,
          availability: after ?? check.availability,
        },
      };
    });
  } catch (error) {
    if (error instanceof Rollback) return error.result as RescheduleOutcome;
    throw error;
  }
}

/** Bookings that start inside the reminder window and have not been reminded yet. */
export function bookingsDueForReminder(
  db: Db,
  windowStart: Date,
  windowEnd: Date,
): (BookingView & { telegramUserId: string })[] {
  const rows = db
    .prepare(
      `SELECT b.id, st.telegram_user_id
         FROM bookings b
         JOIN sessions s  ON s.id = b.session_id
         JOIN students st ON st.id = b.student_id
        WHERE b.status = 'active'
          AND b.reminded_at IS NULL
          AND st.telegram_user_id IS NOT NULL
          AND s.starts_at > ?
          AND s.starts_at <= ?`,
    )
    .all(windowStart.toISOString(), windowEnd.toISOString()) as {
    id: number;
    telegram_user_id: string;
  }[];

  return rows
    .map((row) => {
      const studentId = Number(
        (
          db.prepare(`SELECT student_id FROM bookings WHERE id = ?`).get(row.id) as {
            student_id: number;
          }
        ).student_id,
      );
      const booking = getBookings(db, studentId, { includePast: true }).find(
        (b) => b.id === Number(row.id),
      );
      return booking
        ? { ...booking, telegramUserId: String(row.telegram_user_id) }
        : undefined;
    })
    .filter((b): b is BookingView & { telegramUserId: string } => b !== undefined);
}

export function markReminded(db: Db, bookingId: number, now = new Date()): void {
  db.prepare(`UPDATE bookings SET reminded_at = ? WHERE id = ?`).run(
    now.toISOString(),
    bookingId,
  );
}
