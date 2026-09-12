/** The write tools: booking, cancelling, and moving a booking in one step. */
import { defineChannelTool } from "@copilotkit/channels";
import type { ChannelToolContext } from "@copilotkit/channels";
import { z } from "zod";
import { db } from "../../db";
import type { Role } from "../../services/domain";
import * as services from "../../services";
import {
  bookingConfirmation,
  cancellationCard,
  rescheduleCard,
} from "../../bot/messages/components";
import { ROLES, NOT_LINKED, actorId } from "./shared";

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
