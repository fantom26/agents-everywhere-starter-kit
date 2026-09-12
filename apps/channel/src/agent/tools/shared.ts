/**
 * What every tool in this directory shares.
 *
 * Three rules hold across all of them:
 *
 * 1. **The caller is never an argument.** Each tool resolves the student from
 *    the Telegram actor id on the tool context. No parameter can name a
 *    student, so "book Andriy in for Wednesday" has nowhere to land.
 * 2. **No rule is re-implemented here.** These are thin adapters over
 *    `services/index.ts`, which is itself a thin adapter over
 *    `services/domain.ts`. A refusal is returned verbatim — reason,
 *    explanation, and facts — so the agent explains the real reason instead of
 *    inventing a plausible one.
 * 3. **Nothing here is reachable only by the model.** Every service these tools
 *    call is the same one the button UI calls, so the two doors cannot drift.
 *
 * Return values are read by the *model*. Factual cards are posted by the tool
 * itself (see bot/messages/components.tsx), and the tool then returns a short
 * note telling the model not to restate what the student can already see.
 */
export const ROLES = ["coach", "client", "listener"] as const;

/** Told to the model when the Telegram account is not on the roster yet. */
export const NOT_LINKED =
  "This Telegram account is not linked to a student yet. Ask the student to send the phone number from the school roster, then call link_student_account. Do not answer any question about progress, bookings, or availability until that succeeds.";

/** The Telegram user id for this turn, or "" when the actor is missing. */
export function actorId(ctx: { actor?: { id?: string } }): string {
  return ctx.actor?.id ?? "";
}

/** Minutes past Kyiv midnight from an `HH:MM` string. */
export function minuteOfDay(time?: string): number | undefined {
  if (!time) return undefined;
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!match) return undefined;
  return Number(match[1]) * 60 + Number(match[2]);
}
