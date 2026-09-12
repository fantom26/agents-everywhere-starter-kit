/**
 * The agent's tools.
 *
 * Three rules hold across every tool in this file:
 *
 * 1. **The caller is never an argument.** Each tool resolves the student from
 *    the Telegram actor id on the tool context. No parameter can name a
 *    student, so "book Andriy in for Wednesday" has nowhere to land.
 * 2. **No rule is re-implemented here.** These are thin adapters over
 *    `services.ts`, which is itself a thin adapter over `domain.ts`. A refusal
 *    is returned verbatim — reason, explanation, and facts — so the agent
 *    explains the real reason instead of inventing a plausible one.
 * 3. **Nothing here is reachable only by the model.** Every service these tools
 *    call is the same one the button UI calls, so the two doors cannot drift.
 *
 * Return values are read by the *model*. Factual cards are posted by the tool
 * itself (see components.tsx), and the tool then returns a short note telling
 * the model not to restate what the student can already see.
 */
import { defineChannelTool } from "@copilotkit/channels";
import type { ChannelToolContext, InteractionContext } from "@copilotkit/channels";
import { z } from "zod";
import { db } from "./db";
import { getProgress, type Role } from "./domain";
import * as services from "./services";
import type { Student } from "./identity";
import { parseKyivDate, kyivDateKey, DAY_MS } from "./time";
import {
  bookingConfirmation,
  bookingsCard,
  cancellationCard,
  linkedCard,
  progressCard,
  rescheduleCard,
  sessionDetailCard,
  sessionOptions,
} from "./components";

const ROLES = ["coach", "client", "listener"] as const;

/** Told to the model when the Telegram account is not on the roster yet. */
const NOT_LINKED =
  "This Telegram account is not linked to a student yet. Ask the student to send the phone number from the school roster, then call link_student_account. Do not answer any question about progress, bookings, or availability until that succeeds.";

type Caller = { student: Student; telegramUserId: string };

/**
 * Resolve the student behind the current turn.
 *
 * `actor.id` is the Telegram user id, stamped at ingress by the adapter — the
 * one identity in this system the model cannot influence.
 */
function caller(ctx: { actor?: { id?: string } }): Caller | undefined {
  const telegramUserId = ctx.actor?.id;
  if (!telegramUserId) return undefined;
  const student = services.resolveCaller(db(), telegramUserId);
  return student ? { student, telegramUserId } : undefined;
}

/** The Telegram user id for this turn, or "" when the actor is missing. */
function actorId(ctx: { actor?: { id?: string } }): string {
  return ctx.actor?.id ?? "";
}

/** Minutes past Kyiv midnight from an `HH:MM` string. */
function minuteOfDay(time?: string): number | undefined {
  if (!time) return undefined;
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!match) return undefined;
  return Number(match[1]) * 60 + Number(match[2]);
}

// ------------------------------------------------------------- identity

export const linkStudentAccount = defineChannelTool({
  name: "link_student_account",
  description:
    "Link this Telegram account to a student on the school roster, using a phone number the student typed. ONLY call this when another tool reports that the account is not linked, or when the student explicitly sends a phone number. A linked account stays linked — never ask a student who is already linked for their number again.",
  parameters: z.object({
    phone: z.string().describe("The phone number exactly as the student wrote it."),
  }),
  async handler({ phone }, ctx: ChannelToolContext) {
    const telegramUserId = ctx.actor?.id;
    if (!telegramUserId) return "Could not read the Telegram account id for this turn.";

    const result = services.linkByPhone(db(), telegramUserId, phone);
    if (!result.ok) return { linked: false, reason: result.reason, explanation: result.explanation };

    const progress = getProgress(db(), result.student.id);
    if (!result.alreadyLinked) {
      await ctx.thread.post(linkedCard(result.student.fullName, progress));
      return "Linked and posted a welcome card with the student's progress. Greet them by name in one short sentence and ask what they need — do not repeat the numbers on the card.";
    }
    return {
      linked: true,
      alreadyLinked: true,
      student: result.student.fullName,
      note: "This account was already linked. Just continue with what they asked.",
    };
  },
});

// ------------------------------------------------------------- reads

export const getMyProgress = defineChannelTool({
  name: "get_my_progress",
  description:
    "How many practices of each type the student has booked against the annual requirement. Call this whenever they ask what they still need, and before suggesting what to book.",
  parameters: z.object({}),
  async handler(_args, ctx: ChannelToolContext) {
    const result = services.progressFor(db(), actorId(ctx));
    if (!result.linked) return NOT_LINKED;
    await ctx.thread.post(progressCard(result.student.fullName, result.progress));
    return {
      posted: "A progress card is now on screen; do not restate the numbers.",
      progress: result.progress,
    };
  },
});

export const getMyBookings = defineChannelTool({
  name: "get_my_bookings",
  description:
    "The student's active upcoming bookings, with the booking id needed to cancel or reschedule. Call this before any cancellation or reschedule so you refer to a real booking.",
  parameters: z.object({}),
  async handler(_args, ctx: ChannelToolContext) {
    const now = new Date();
    const result = services.bookingsFor(db(), actorId(ctx), now);
    if (!result.linked) return NOT_LINKED;
    const { bookings } = result;
    await ctx.thread.post(bookingsCard(bookings, now));
    return {
      posted: "The bookings card is on screen; do not restate it.",
      bookings: bookings.map((booking) => ({
        bookingId: booking.id,
        sessionId: booking.sessionId,
        practice: booking.practiceTitle,
        startsAtUtc: booking.session.startsAt.toISOString(),
        role: booking.role,
        isExtra: booking.isExtra,
      })),
    };
  },
});

export const searchAvailablePractices = defineChannelTool({
  name: "search_available_practices",
  description:
    "Find sessions the student could book. Dates and times are Kyiv local. Only future sessions with free seats are returned, and a role filter only returns sessions where that role is still free — so every option you see is genuinely bookable. Never offer a session that did not come back from this tool.",
  parameters: z.object({
    practiceType: z
      .enum(["trios", "intermodule", "mentoring"])
      .optional()
      .describe("Leave empty to search every practice type."),
    dateFrom: z.string().optional().describe("Kyiv date, YYYY-MM-DD. Defaults to now."),
    dateTo: z.string().optional().describe("Kyiv date, YYYY-MM-DD, inclusive."),
    afterTime: z.string().optional().describe("Kyiv time of day, HH:MM, e.g. 18:00."),
    beforeTime: z.string().optional().describe("Kyiv time of day, HH:MM."),
    role: z
      .enum(ROLES)
      .optional()
      .describe("Only for group mentoring: return sessions where this role is free."),
    limit: z.number().int().min(1).max(10).default(5),
  }),
  async handler(args, ctx: ChannelToolContext) {
    const now = new Date();
    const result = services.findSlots(
      db(),
      actorId(ctx),
      {
        practiceTypeCode: args.practiceType,
        fromUtc: args.dateFrom ? parseKyivDate(args.dateFrom) : undefined,
        // An inclusive end date means the whole of that Kyiv day.
        toUtc: args.dateTo
          ? new Date((parseKyivDate(args.dateTo)?.getTime() ?? 0) + DAY_MS)
          : undefined,
        afterKyivMinute: minuteOfDay(args.afterTime),
        beforeKyivMinute: minuteOfDay(args.beforeTime),
        role: args.role as Role | undefined,
        limit: args.limit,
      },
      now,
    );
    if (!result.linked) return NOT_LINKED;
    const found = result.slots;

    await ctx.thread.post(sessionOptions(found, now));

    return {
      posted:
        "The options are on screen with booking buttons. Summarise in one short sentence and ask which one they want — do not list them again.",
      count: found.length,
      sessions: found.map((option) => ({
        sessionId: option.session.id,
        practice: option.type.title,
        startsAtUtc: option.session.startsAt.toISOString(),
        trainer: option.session.trainer,
        freeSeats: option.free,
        capacity: option.capacity,
        freeRoles: option.roles.filter((role) => role.free > 0).map((role) => role.role),
      })),
    };
  },
});

export const getPracticeDetails = defineChannelTool({
  name: "get_practice_details",
  description:
    "Everything about one session, including whether THIS student could book it right now and, if not, exactly why. Call this when the student asks about a specific session or asks why they cannot book something.",
  parameters: z.object({
    sessionId: z.number().int().describe("From search_available_practices or get_my_bookings."),
    role: z.enum(ROLES).optional().describe("Check bookability for this mentoring role."),
  }),
  async handler({ sessionId, role }, ctx: ChannelToolContext) {
    const now = new Date();
    // `sessionDetail` runs every booking rule without writing anything, so "why
    // can't I book this?" is answered by the same code that would refuse it.
    const detail = services.sessionDetail(
      db(),
      actorId(ctx),
      sessionId,
      role as Role | undefined,
      now,
    );
    if (!detail.linked) return NOT_LINKED;

    const found = detail.found;
    if (!found || !detail.bookable) {
      return { found: false, explanation: `There is no session with id ${sessionId}.` };
    }
    const check = detail.bookable;
    await ctx.thread.post(
      sessionDetailCard(found, now, {
        ok: check.ok,
        explanation: check.ok ? undefined : check.explanation,
      }),
    );

    return {
      posted: "The detail card is on screen.",
      sessionId,
      practice: found.type.title,
      startsAtUtc: found.session.startsAt.toISOString(),
      trainer: found.session.trainer,
      freeSeats: found.free,
      capacity: found.capacity,
      roles: found.roles,
      bookable: check.ok,
      ...(check.ok
        ? { wouldBeExtraBooking: check.isExtra }
        : { refusal: check.reason, explanation: check.explanation, facts: check.facts }),
    };
  },
});

// ------------------------------------------------------------- writes

/** Shared by the tool and the inline booking buttons, so both obey one path. */
async function performBooking(
  ctx: { thread: ChannelToolContext["thread"]; actor?: { id?: string } },
  input: { sessionId: number; role?: Role },
) {
  const now = new Date();
  const booked = services.book(db(), actorId(ctx), input, now);
  if (!booked.linked) return NOT_LINKED;
  const result = booked.outcome;

  if (!result.ok) {
    return {
      booked: false,
      refusal: result.reason,
      explanation: result.explanation,
      facts: result.facts,
      note: "Explain this refusal to the student in their own language, using the facts above. Do not book anything else without asking. If the reason is quota_reached_too_early, tell them when the session becomes bookable.",
    };
  }

  await ctx.thread.post(
    bookingConfirmation(result.availability, {
      bookingId: result.bookingId,
      role: input.role ?? null,
      isExtra: result.isExtra,
      now,
    }),
  );

  return {
    booked: true,
    bookingId: result.bookingId,
    isExtra: result.isExtra,
    note: result.isExtra
      ? "Booked as an extra beyond the annual requirement, allowed because the session starts within 24 hours. The confirmation card is on screen — confirm in one sentence and mention it was an extra booking."
      : "Booked. The confirmation card is on screen — confirm in one short sentence and do not repeat the details.",
  };
}

export const bookPracticeTool = defineChannelTool({
  name: "book_practice",
  description:
    "Book the student into one session. This validates capacity, duplicate bookings, the annual quota, the 24-hour rule for extra bookings, and mentoring role availability. It is the only way to create a booking. If it refuses, relay the reason — never work around it.",
  parameters: z.object({
    sessionId: z.number().int().describe("From search_available_practices."),
    role: z
      .enum(ROLES)
      .optional()
      .describe("Required for group mentoring. Ask the student which role they want."),
  }),
  async handler({ sessionId, role }, ctx: ChannelToolContext) {
    return performBooking(ctx, { sessionId, role: role as Role | undefined });
  },
});

export const cancelBookingTool = defineChannelTool({
  name: "cancel_booking",
  description:
    "Cancel one of the student's active bookings. This frees the seat and updates their progress. Confirm which booking they mean before calling this.",
  parameters: z.object({
    bookingId: z.number().int().describe("From get_my_bookings."),
  }),
  async handler({ bookingId }, ctx: ChannelToolContext) {
    const cancelled = services.cancel(db(), actorId(ctx), bookingId);
    if (!cancelled.linked) return NOT_LINKED;
    const result = cancelled.outcome;
    if (!result.ok) {
      return { cancelled: false, refusal: result.reason, explanation: result.explanation };
    }
    await ctx.thread.post(cancellationCard(result.booking));
    return {
      cancelled: true,
      note: "Cancelled; the card is on screen. Mention in one sentence that the seat is free again and their progress went down by one.",
    };
  },
});

export const rescheduleBookingTool = defineChannelTool({
  name: "reschedule_booking",
  description:
    "Move an existing booking to a different session of the SAME practice type, in one step. If the new session cannot be booked, the original booking is kept — nothing is lost. Use this instead of cancelling and rebooking.",
  parameters: z.object({
    bookingId: z.number().int().describe("From get_my_bookings."),
    newSessionId: z.number().int().describe("From search_available_practices."),
    role: z
      .enum(ROLES)
      .optional()
      .describe("Only for group mentoring; defaults to the role they already hold."),
  }),
  async handler({ bookingId, newSessionId, role }, ctx: ChannelToolContext) {
    const moved = services.reschedule(
      db(),
      actorId(ctx),
      { bookingId, newSessionId, role: role as Role | undefined },
      new Date(),
    );
    if (!moved.linked) return NOT_LINKED;
    const result = moved.outcome;

    if (!result.ok) {
      return {
        rescheduled: false,
        refusal: result.reason,
        explanation: result.explanation,
        facts: result.facts,
        note: "The original booking was kept. Say so explicitly, then explain why the move failed.",
      };
    }

    await ctx.thread.post(
      rescheduleCard(
        result.cancelled,
        result.booked.availability,
        (role as Role | undefined) ?? result.cancelled.role,
      ),
    );
    return {
      rescheduled: true,
      newBookingId: result.booked.bookingId,
      note: "Moved; the card is on screen. Confirm in one short sentence.",
    };
  },
});

export const listPracticeTypesTool = defineChannelTool({
  name: "list_practice_types",
  description:
    "The catalogue of practice types: their names, capacity, annual requirement, and the roles they use. Call this when the student asks what practices exist or what a type involves.",
  parameters: z.object({}),
  async handler() {
    return services.practiceTypes(db()).map((type) => ({
      code: type.code,
      title: type.title,
      capacity: type.capacity,
      requiredPerYear: type.requiredPerYear,
      roles: type.roles,
    }));
  },
});

export const practiceTools = [
  linkStudentAccount,
  getMyProgress,
  getMyBookings,
  searchAvailablePractices,
  getPracticeDetails,
  bookPracticeTool,
  cancelBookingTool,
  rescheduleBookingTool,
  listPracticeTypesTool,
];

/**
 * Injected every run so the model knows the caller is already identified.
 *
 * Without this, the only trace of a completed link is the conversation history,
 * which is in-memory and dies with the process — so after a restart the agent
 * would ask a student who linked last week for their phone number again. It is
 * narrative only: the tools still resolve the student from the Telegram actor
 * id, so nothing the model reads here can point a booking at someone else.
 */
export function callerContext(student: Student) {
  return {
    description: "Who you are talking to",
    value: `This Telegram account is already linked to ${student.fullName}. Never ask them for a phone number, and never call link_student_account for them.`,
  };
}

/** Injected every run so the agent can resolve "next week" without guessing. */
export function todayContext(now = new Date()) {
  return {
    description: "Today",
    value: `Today in Kyiv is ${kyivDateKey(now)}. All dates and times you pass to tools, and everything you tell the student, are Kyiv local time (Europe/Kyiv).`,
  };
}
