/**
 * The application services — the one layer both front doors call.
 *
 * A student can reach this system two ways: by tapping buttons, or by telling
 * the agent what they want. Both arrive here, and neither is allowed its own
 * copy of a rule. Every function in this file does exactly two things:
 *
 *   1. resolve the caller from the Telegram user id stamped at ingress, and
 *   2. hand the request to `domain.ts` and return what it said, unchanged.
 *
 * That is the whole point. `domain.ts` keeps every booking rule; this file adds
 * identity and nothing else. If a capacity check, a quota comparison, or a role
 * count ever appears below, it is in the wrong file.
 *
 * There is no Telegram here and no model here: no JSX, no `thread`, no prompt.
 * A service returns data, and the caller decides whether it becomes a card, a
 * tool result, or a test assertion.
 */
import type { Db } from "../db";
import {
  availability,
  bookPractice,
  cancelBooking,
  checkBookable,
  getBookings,
  getProgress,
  listPracticeTypes,
  rescheduleBooking,
  searchSessions,
  type Availability,
  type BookOutcome,
  type BookingView,
  type CancelOutcome,
  type PracticeType,
  type Progress,
  type RescheduleOutcome,
  type Role,
  type SearchFilters,
} from "./domain";
import { findStudentByTelegramId, linkStudent, type LinkOutcome, type Student } from "./identity";
import { calendar } from "./calendar";

/**
 * Every service answers "who is asking?" before anything else, so every result
 * carries the same two-state shape: either the Telegram account is linked to a
 * student, or there is nothing to say until it is.
 */
export type Unlinked = { linked: false };

const UNLINKED: Unlinked = { linked: false };

export type Linked<T> = { linked: true; student: Student } & T;
export type Result<T> = Unlinked | Linked<T>;

/**
 * The student behind a Telegram account, or undefined.
 *
 * This is the only identity lookup in the system that callers should use. The
 * Telegram user id is stamped by the adapter at ingress and is the one identity
 * neither the model nor a button payload can influence.
 */
export function resolveCaller(db: Db, telegramUserId: string): Student | undefined {
  return findStudentByTelegramId(db, telegramUserId);
}

/** Convenience for the many handlers that only need "linked or not". */
export function isLinked(db: Db, telegramUserId: string): boolean {
  return resolveCaller(db, telegramUserId) !== undefined;
}

// ------------------------------------------------------------- linking

export type ContactLinkRefusal = "contact_not_own";

export type LinkResult =
  | LinkOutcome
  | { ok: false; reason: ContactLinkRefusal; explanation: string };

/**
 * Link from a shared Telegram contact.
 *
 * Telegram lets anyone forward somebody else's contact card, so a shared
 * contact is only proof of a phone number when the contact *is* the sender.
 * That check belongs here rather than in the Telegram handler: it is a rule
 * about who may claim a roster row, and it is worth a test that needs no bot.
 */
export function linkByContact(
  db: Db,
  telegramUserId: string,
  contact: { phoneNumber: string; userId?: number | string | null },
): LinkResult {
  const sharedBy = contact.userId === null || contact.userId === undefined
    ? undefined
    : String(contact.userId);
  if (sharedBy !== telegramUserId) {
    return {
      ok: false,
      reason: "contact_not_own",
      explanation:
        "That contact card belongs to somebody else. Share your own number — the button on the keyboard sends it directly.",
    };
  }
  return linkStudent(db, telegramUserId, contact.phoneNumber);
}

/** Link from a phone number the student typed. The fallback path. */
export function linkByPhone(db: Db, telegramUserId: string, rawPhone: string): LinkResult {
  return linkStudent(db, telegramUserId, rawPhone);
}

// ------------------------------------------------------------- reads

export function progressFor(db: Db, telegramUserId: string): Result<{ progress: Progress[] }> {
  const student = resolveCaller(db, telegramUserId);
  if (!student) return UNLINKED;
  return { linked: true, student, progress: getProgress(db, student.id) };
}

export function bookingsFor(
  db: Db,
  telegramUserId: string,
  now = new Date(),
): Result<{ bookings: BookingView[] }> {
  const student = resolveCaller(db, telegramUserId);
  if (!student) return UNLINKED;
  return { linked: true, student, bookings: getBookings(db, student.id, { now }) };
}

export function findSlots(
  db: Db,
  telegramUserId: string,
  filters: SearchFilters,
  now = new Date(),
): Result<{ slots: Availability[] }> {
  const student = resolveCaller(db, telegramUserId);
  if (!student) return UNLINKED;
  return { linked: true, student, slots: searchSessions(db, filters, now) };
}

export type SessionDetail = {
  found: Availability | undefined;
  /** The full booking check, run without writing — "could *this* student book it?" */
  bookable: ReturnType<typeof checkBookable> | undefined;
};

export function sessionDetail(
  db: Db,
  telegramUserId: string,
  sessionId: number,
  role?: Role,
  now = new Date(),
): Result<SessionDetail> {
  const student = resolveCaller(db, telegramUserId);
  if (!student) return UNLINKED;

  const found = availability(db, sessionId);
  if (!found) return { linked: true, student, found: undefined, bookable: undefined };

  return {
    linked: true,
    student,
    found,
    bookable: checkBookable(db, { studentId: student.id, sessionId, role }, now),
  };
}

/** The catalogue. No caller needed — it is the same for everyone. */
export function practiceTypes(db: Db): PracticeType[] {
  return listPracticeTypes(db);
}

// ------------------------------------------------------------- writes

export function book(
  db: Db,
  telegramUserId: string,
  input: { sessionId: number; role?: Role | null },
  now = new Date(),
): Result<{ outcome: BookOutcome }> {
  const student = resolveCaller(db, telegramUserId);
  if (!student) return UNLINKED;

  const outcome = bookPractice(
    db,
    { studentId: student.id, sessionId: input.sessionId, role: input.role ?? null },
    now,
  );

  // After the commit, never inside it: a calendar that is slow, rate limited or
  // unreachable must not be able to turn a booked seat into an error. Both
  // doors reach this line, which is the whole reason the layer exists.
  if (outcome.ok) calendar().booked(db, student.id, outcome.bookingId);

  return { linked: true, student, outcome };
}

export function cancel(
  db: Db,
  telegramUserId: string,
  bookingId: number,
  now = new Date(),
): Result<{ outcome: CancelOutcome }> {
  const student = resolveCaller(db, telegramUserId);
  if (!student) return UNLINKED;

  const outcome = cancelBooking(db, { studentId: student.id, bookingId }, now);
  if (outcome.ok) calendar().cancelled(db, student.id, bookingId);

  return { linked: true, student, outcome };
}

export function reschedule(
  db: Db,
  telegramUserId: string,
  input: { bookingId: number; newSessionId: number; role?: Role },
  now = new Date(),
): Result<{ outcome: RescheduleOutcome }> {
  const student = resolveCaller(db, telegramUserId);
  if (!student) return UNLINKED;

  const outcome = rescheduleBooking(
    db,
    {
      studentId: student.id,
      bookingId: input.bookingId,
      newSessionId: input.newSessionId,
      role: input.role,
    },
    now,
  );

  // A move is a cancellation and a booking, and the calendar sees it as both.
  if (outcome.ok) {
    calendar().cancelled(db, student.id, input.bookingId);
    calendar().booked(db, student.id, outcome.booked.bookingId);
  }

  return { linked: true, student, outcome };
}
