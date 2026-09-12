/** The read-only tools: progress, bookings, availability, and the catalogue. */
import { defineChannelTool } from "@copilotkit/channels";
import type { ChannelToolContext } from "@copilotkit/channels";
import { z } from "zod";
import { db } from "../../db";
import type { Role } from "../../services/domain";
import * as services from "../../services";
import { parseKyivDate, DAY_MS } from "../../time";
import {
  bookingsCard,
  progressCard,
  sessionDetailCard,
  sessionOptions,
} from "../../bot/messages/components";
import { ROLES, NOT_LINKED, actorId, minuteOfDay } from "./shared";

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
