/**
 * The button UI's router: a tap in, a screen out.
 *
 * This is the second front door onto the system, and it is deliberately the
 * *dumber* one. It decodes the payload, calls `services.ts`, and renders what
 * came back. It decides nothing: no capacity check, no quota arithmetic, no
 * "is this role free" — those are `domain.ts`'s, reached through the same
 * service functions the agent's tools call. If a rule ever appears in this
 * file, the two doors have started to drift and the parity tests will say so.
 *
 * `route` is pure with respect to Telegram: it takes a database, a Telegram
 * user id and a payload, and returns a card plus how to show it. That is what
 * lets the whole button product be tested without a bot token.
 */
import type { Db } from "./db";
import * as services from "./services";
import { decode, cb, codeFor, tokenFor, type Action, type Period, type TypeToken } from "./callbacks";
import {
  bookingConfirmation,
  bookingsCard,
  cancellationCard,
  linkPrompt,
  progressCard,
  refusalCard,
  rescheduleCard,
  sessionOptions,
} from "./components";
import {
  cancelConfirm,
  datePicker,
  infoScreen,
  mainMenu,
  periodPicker,
  reschedulePeriodPicker,
  rescheduleSlots,
  roleScreen,
  slotScreen,
  typePicker,
} from "./screens";
import { t, practiceTitle } from "./strings";
import { formatKyiv, kyivDateKey, kyivWeekWindow, parseKyivDate, DAY_MS } from "./time";
import type { Availability, BookingView, Refusal } from "./domain";

type Card = ReturnType<typeof mainMenu>;

export type Rendered = {
  card: Card;
  /**
   * `edit` replaces the message the button was on — navigation should not fill
   * the chat with dead menus. `send` posts a new message, which is what an
   * actual change deserves: a confirmation is worth keeping in the transcript.
   */
  mode: "edit" | "send";
  /** Optional Telegram toast, for a refusal that needs no whole screen. */
  toast?: string;
};

const nav = (card: Card): Rendered => ({ card, mode: "edit" });
const done = (card: Card, toast?: string): Rendered => ({ card, mode: "send", toast });

/** How many sessions one screen offers. Telegram allows more; a phone does not. */
const PAGE = 6;

/** The student-facing sentence for a domain refusal, with Kyiv times formatted. */
function refusalText(reason: Refusal, facts: Record<string, unknown>): string {
  const from = typeof facts.bookableFrom === "string" ? new Date(facts.bookableFrom) : undefined;
  return t.refusal(reason, facts, {
    bookableFrom: from && !Number.isNaN(from.getTime()) ? formatKyiv(from) : undefined,
  });
}

/** The date window a period token selects. `d` has no window of its own. */
function windowFor(period: Period, now: Date): { fromUtc?: Date; toUtc?: Date } {
  if (period === "w") return kyivWeekWindow(now, "this");
  if (period === "n") return kyivWeekWindow(now, "next");
  return {};
}

/** The distinct Kyiv days a set of sessions falls on, in order. */
function daysOf(slots: Availability[]): { key: string; at: Date }[] {
  const seen = new Map<string, Date>();
  for (const slot of slots) {
    const key = kyivDateKey(slot.session.startsAt);
    if (!seen.has(key)) seen.set(key, slot.session.startsAt);
  }
  return [...seen].map(([key, at]) => ({ key, at }));
}

function titleFor(db: Db, token: TypeToken): string {
  const code = codeFor(token);
  if (!code) return t.find.allTypes;
  const type = services.practiceTypes(db).find((candidate) => candidate.code === code);
  return type ? practiceTitle(type.code, type.title) : t.find.allTypes;
}

function findBooking(
  db: Db,
  telegramUserId: string,
  bookingId: number,
  now: Date,
): BookingView | undefined {
  const result = services.bookingsFor(db, telegramUserId, now);
  return result.linked ? result.bookings.find((booking) => booking.id === bookingId) : undefined;
}

/**
 * Route one tap.
 *
 * Every path starts by resolving the caller, so a button tapped by an unlinked
 * account lands on the link prompt rather than anywhere that could read another
 * student's data.
 */
export function route(
  db: Db,
  telegramUserId: string,
  payload: string | undefined,
  now = new Date(),
): Rendered {
  const action = decode(payload);
  if (!action) return { card: linkOrMenu(db, telegramUserId), mode: "edit", toast: t.errors.expired };

  const student = services.resolveCaller(db, telegramUserId);
  if (!student) return { card: linkPrompt(), mode: "send", toast: t.errors.notLinked };

  return handle(db, telegramUserId, action, now);
}

/** The menu for a linked student, the link prompt for anyone else. */
export function linkOrMenu(db: Db, telegramUserId: string): Card {
  const progress = services.progressFor(db, telegramUserId);
  if (!progress.linked) return linkPrompt();
  return mainMenu(progress.student.fullName, progress.progress);
}

function handle(db: Db, telegramUserId: string, action: Action, now: Date): Rendered {
  switch (action.kind) {
    case "noop":
      return nav(linkOrMenu(db, telegramUserId));

    case "menu":
      return nav(linkOrMenu(db, telegramUserId));

    case "info":
      return nav(infoScreen(services.practiceTypes(db)));

    case "progress": {
      const result = services.progressFor(db, telegramUserId);
      if (!result.linked) return { card: linkPrompt(), mode: "send" };
      return nav(progressCard(result.student.fullName, result.progress));
    }

    case "bookings": {
      const result = services.bookingsFor(db, telegramUserId, now);
      if (!result.linked) return { card: linkPrompt(), mode: "send" };
      return nav(bookingsCard(result.bookings, now));
    }

    case "find":
      return nav(typePicker(services.practiceTypes(db)));

    case "findPeriod":
      return nav(periodPicker(action.type, titleFor(db, action.type)));

    case "findSlots": {
      const filters = {
        practiceTypeCode: codeFor(action.type),
        ...windowFor(action.period, now),
        limit: action.period === "d" ? 50 : PAGE,
      };
      const result = services.findSlots(db, telegramUserId, filters, now);
      if (!result.linked) return { card: linkPrompt(), mode: "send" };

      // "Pick a date" reuses the same search and offers its days.
      if (action.period === "d") {
        return nav(datePicker(action.type, titleFor(db, action.type), daysOf(result.slots)));
      }
      return nav(sessionOptions(result.slots, now, { back: cb.findPeriod(action.type) }));
    }

    case "findOnDate": {
      const from = parseKyivDate(action.date);
      const result = services.findSlots(
        db,
        telegramUserId,
        {
          practiceTypeCode: codeFor(action.type),
          fromUtc: from,
          toUtc: from ? new Date(from.getTime() + DAY_MS) : undefined,
          limit: PAGE,
        },
        now,
      );
      if (!result.linked) return { card: linkPrompt(), mode: "send" };
      return nav(
        sessionOptions(result.slots, now, { back: cb.findSlots(action.type, "d") }),
      );
    }

    case "session": {
      const detail = services.sessionDetail(db, telegramUserId, action.sessionId, undefined, now);
      if (!detail.linked) return { card: linkPrompt(), mode: "send" };
      if (!detail.found) return nav(refusalCard(t.errors.sessionGone, cb.find()));

      const back = cb.findPeriod(tokenFor(detail.found.type.code));
      if (detail.found.type.roleBased) return nav(roleScreen(detail.found, back));

      const check = detail.bookable;
      return nav(
        slotScreen(
          detail.found,
          check && !check.ok ? refusalText(check.reason, check.facts) : undefined,
          back,
          now,
        ),
      );
    }

    case "book": {
      const result = services.book(
        db,
        telegramUserId,
        { sessionId: action.sessionId, role: action.role },
        now,
      );
      if (!result.linked) return { card: linkPrompt(), mode: "send" };

      if (!result.outcome.ok) {
        const message = refusalText(result.outcome.reason, result.outcome.facts);
        // A role that was taken between the card and the tap sends them back to
        // the roles, which are now re-read rather than remembered.
        const back =
          result.outcome.reason === "role_taken" || result.outcome.reason === "role_required"
            ? cb.session(action.sessionId)
            : cb.find();
        return done(refusalCard(message, back), message);
      }

      return done(
        bookingConfirmation(result.outcome.availability, {
          bookingId: result.outcome.bookingId,
          role: action.role ?? null,
          isExtra: result.outcome.isExtra,
          now,
        }),
      );
    }

    case "cancelAsk": {
      const booking = findBooking(db, telegramUserId, action.bookingId, now);
      if (!booking) return nav(refusalCard(t.errors.bookingGone, cb.bookings()));
      return nav(cancelConfirm(booking));
    }

    case "cancelDo": {
      const result = services.cancel(db, telegramUserId, action.bookingId, now);
      if (!result.linked) return { card: linkPrompt(), mode: "send" };
      if (!result.outcome.ok) {
        const message = refusalText(result.outcome.reason, result.outcome.facts);
        return done(refusalCard(message, cb.bookings()), message);
      }
      return done(cancellationCard(result.outcome.booking));
    }

    case "reschedule": {
      const booking = findBooking(db, telegramUserId, action.bookingId, now);
      if (!booking) return nav(refusalCard(t.errors.bookingGone, cb.bookings()));
      return nav(reschedulePeriodPicker(booking));
    }

    case "reschedulePeriod": {
      const booking = findBooking(db, telegramUserId, action.bookingId, now);
      if (!booking) return nav(refusalCard(t.errors.bookingGone, cb.bookings()));

      const result = services.findSlots(
        db,
        telegramUserId,
        {
          // A move stays inside one practice type — the domain refuses anything
          // else, so the picker never offers it.
          practiceTypeCode: booking.session.practiceTypeCode,
          ...windowFor(action.period, now),
          limit: PAGE,
        },
        now,
      );
      if (!result.linked) return { card: linkPrompt(), mode: "send" };

      const others = result.slots.filter((slot) => slot.session.id !== booking.sessionId);
      return nav(rescheduleSlots(booking, others));
    }

    case "rescheduleDo": {
      const booking = findBooking(db, telegramUserId, action.bookingId, now);
      const result = services.reschedule(
        db,
        telegramUserId,
        { bookingId: action.bookingId, newSessionId: action.sessionId },
        now,
      );
      if (!result.linked) return { card: linkPrompt(), mode: "send" };

      if (!result.outcome.ok) {
        const message = refusalText(result.outcome.reason, result.outcome.facts);
        return done(refusalCard(message, cb.reschedule(action.bookingId)), message);
      }
      return done(
        rescheduleCard(
          result.outcome.cancelled,
          result.outcome.booked.availability,
          booking?.role ?? null,
        ),
      );
    }
  }
}
