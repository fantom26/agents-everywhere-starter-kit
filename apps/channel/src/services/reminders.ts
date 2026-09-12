/**
 * The one-hour reminder.
 *
 * This is the part of the product that only works because the agent lives in
 * Telegram: nobody opens a booking website an hour before a session, but a
 * Telegram message arrives on its own. The same chat then carries the reply —
 * "cancel it, I can't make it" — with the booking already in context.
 *
 * The scheduler posts through the adapter's grammY bot rather than a `Thread`,
 * because a Thread only exists inside a handler and nothing is handling
 * anything an hour before a session. `renderTelegram` turns the same JSX card
 * the tools use into the Telegram payload, so a reminder looks like every other
 * message the bot sends.
 */
import { renderToIR } from "@copilotkit/channels";
import { renderTelegram } from "@copilotkit/channels/telegram";
import type { Db } from "../db";
import { bookingsDueForReminder, markReminded } from "./domain";
import { reminderCard } from "../bot/messages/components";
import { HOUR_MS } from "../time";

/**
 * Just the slice of grammY this needs. The real `adapter.bot` satisfies it, and
 * so does a fake in the tests — no network required to prove a reminder sends.
 */
export type ReminderBot = {
  api: {
    sendMessage(
      chatId: number | string,
      text: string,
      other?: Record<string, unknown>,
    ): Promise<unknown>;
  };
};

export type ReminderConfig = {
  db: Db;
  bot: ReminderBot;
  /** How long before the start to send. Default one hour. */
  leadMs?: number;
  /** How often to look. Default every minute. */
  intervalMs?: number;
  onError?: (error: unknown) => void;
};

/**
 * One pass of the scheduler.
 *
 * The window is the lead time plus one tick, so a session is caught even if a
 * tick is late; `reminded_at` is what keeps it from being caught twice.
 * Exported for the tests, which run it against a fake bot.
 */
export async function sendDueReminders(
  config: ReminderConfig,
  now = new Date(),
): Promise<number> {
  const lead = config.leadMs ?? HOUR_MS;
  const interval = config.intervalMs ?? 60_000;
  const windowStart = new Date(now.getTime() + lead - interval);
  const windowEnd = new Date(now.getTime() + lead);

  const due = bookingsDueForReminder(config.db, windowStart, windowEnd);
  let sent = 0;

  for (const booking of due) {
    try {
      // `renderToIR` lowers the JSX to the platform-neutral node list the
      // adapter's renderer expects — the same two steps a posted card goes
      // through inside a handler.
      const payload = renderTelegram(renderToIR(reminderCard(booking)));
      await config.bot.api.sendMessage(booking.telegramUserId, payload.text, {
        parse_mode: payload.parseMode,
        ...(payload.inlineKeyboard
          ? {
              reply_markup: {
                inline_keyboard: payload.inlineKeyboard.map((row) =>
                  row.map((button) =>
                    button.url
                      ? { text: button.text, url: button.url }
                      : { text: button.text, callback_data: button.callbackData ?? "noop" },
                  ),
                ),
              },
            }
          : {}),
      });
      // Marked only after Telegram accepted it, so a failed send is retried on
      // the next tick rather than silently skipped.
      markReminded(config.db, booking.id, now);
      sent += 1;
    } catch (error) {
      config.onError?.(error);
    }
  }

  return sent;
}

/** Start the scheduler. Returns a stop function for teardown. */
export function startReminderScheduler(config: ReminderConfig): () => void {
  const interval = config.intervalMs ?? 60_000;
  let running = false;

  const tick = async () => {
    if (running) return; // A slow pass must not overlap the next one.
    running = true;
    try {
      const sent = await sendDueReminders({ ...config, intervalMs: interval });
      if (sent > 0) console.log(`  → sent ${sent} practice reminder(s)`);
    } catch (error) {
      config.onError?.(error);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, interval);
  timer.unref?.();
  void tick();

  return () => clearInterval(timer);
}
