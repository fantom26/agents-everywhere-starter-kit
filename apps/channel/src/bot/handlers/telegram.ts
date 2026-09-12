/**
 * The Telegram-specific glue: button taps in, cards out.
 *
 * Two things this product needs are not in the Channels vocabulary, so both go
 * through the adapter's own grammY bot — the same escape hatch `reminders.ts`
 * already uses to message a student an hour before a session:
 *
 * 1. **`request_contact`.** Telegram can hand over a *verified* phone number
 *    with one tap, but only through a reply keyboard, which the Channels JSX
 *    vocabulary does not express. The contact update it produces is not a text
 *    message, so the Channels adapter ignores it entirely and we listen for it
 *    ourselves.
 * 2. **Callback routing.** `channel.onInteraction(id, fn)` matches ids by exact
 *    string equality, which cannot express `b:17`. Reading `callback_query`
 *    directly lets every payload be parsed instead of pre-registered, and that
 *    is what makes the button UI stateless — see `callbacks.ts`.
 * 3. **`/start`.** `channel.onThreadStarted` never fires on Telegram: the
 *    adapter's own `message:text` middleware is registered before its
 *    `bot.command("start")` and returns on `/start` without calling `next()`,
 *    so the handler that would emit the event is unreachable. A student who
 *    pressed START therefore got silence. `/start` is answered here instead.
 *
 * Ordering matters: these handlers are attached before the adapter starts, so
 * they run first. A payload we recognise is *not* passed on (`next()` is not
 * called), which keeps the adapter from acking the same callback query twice.
 * Anything else — an old `ck:` id from a card the agent posted — falls through
 * untouched.
 *
 * Everything below is structurally typed against the slice of grammY it uses,
 * so the tests drive it with a fake bot and no network.
 */
import { renderToIR } from "@copilotkit/channels";
import { renderTelegram } from "@copilotkit/channels/telegram";
import type { Db } from "../../db";
import { route, linkOrMenu } from "./router";
import { linkedCard, linkPrompt } from "../messages/components";
import * as services from "../../services";
import { t } from "../messages/strings";

type ChatId = number | string;

/** The slice of grammY's `Bot` this file needs. */
export type BotLike = {
  api: {
    sendMessage(chatId: ChatId, text: string, other?: Record<string, unknown>): Promise<unknown>;
    editMessageText(
      chatId: ChatId,
      messageId: number,
      text: string,
      other?: Record<string, unknown>,
    ): Promise<unknown>;
  };
  on(filter: string, handler: (ctx: BotContext, next: NextFn) => Promise<void>): unknown;
  command(name: string, handler: (ctx: BotContext, next: NextFn) => Promise<void>): unknown;
};

export type NextFn = () => Promise<void>;

/** The slice of a grammY update context this file reads. */
export type BotContext = {
  chat?: { id: ChatId; type?: string };
  from?: { id: ChatId };
  message?: {
    message_id?: number;
    contact?: { phone_number: string; user_id?: number };
  };
  callbackQuery?: {
    id: string;
    data?: string;
    message?: { message_id: number };
  };
  answerCallbackQuery?: (options?: { text?: string; show_alert?: boolean }) => Promise<unknown>;
  api: BotLike["api"];
};

type Card = Parameters<typeof renderToIR>[0];

/** A rendered card, in the shape Telegram's sendMessage wants. */
export function toTelegram(card: Card): { text: string; other: Record<string, unknown> } {
  const payload = renderTelegram(renderToIR(card));
  const keyboard = payload.inlineKeyboard?.flat().length ? payload.inlineKeyboard : undefined;
  return {
    text: payload.text,
    other: {
      parse_mode: payload.parseMode,
      ...(keyboard
        ? {
            reply_markup: {
              inline_keyboard: keyboard.map((row) =>
                row.map((button) =>
                  button.url
                    ? { text: button.text, url: button.url }
                    : { text: button.text, callback_data: button.callbackData ?? "noop" },
                ),
              ),
            },
          }
        : {}),
    },
  };
}

export async function sendCard(bot: BotLike, chatId: ChatId, card: Card): Promise<void> {
  const { text, other } = toTelegram(card);
  await bot.api.sendMessage(chatId, text, other);
}

/**
 * Ask for the phone number with Telegram's own contact button.
 *
 * The keyboard is the only part of this the SDK cannot render, so the card and
 * the keyboard go out together: the card explains, the keyboard collects.
 */
export async function askForContact(bot: BotLike, chatId: ChatId): Promise<void> {
  const { text, other } = toTelegram(linkPrompt());
  await bot.api.sendMessage(chatId, text, {
    ...other,
    reply_markup: {
      keyboard: [[{ text: t.link.shareButton, request_contact: true }]],
      resize_keyboard: true,
      // Deliberately *not* `one_time_keyboard`: until the student has checked
      // in, sharing the number is the only thing they can do, so the button
      // stays in front of them. Checking in removes it (`remove_keyboard`).
    },
  });
}

/**
 * Attach the handlers to the adapter's bot.
 *
 * Call this once, at import time, before the runtime starts the adapter — that
 * is what puts these ahead of the adapter's own middleware.
 */
export function attachTelegramHandlers(bot: BotLike, db: Db): void {
  // The first screen. An unlinked student gets the contact keyboard and nothing
  // else; a linked one gets the menu straight away. `next()` is deliberately not
  // called: the adapter's `/start` path is dead anyway (see the file header).
  bot.command("start", async (ctx, next) => {
    const from = ctx.from?.id;
    const chatId = ctx.chat?.id;
    // One student per chat is the whole identity model, so a phone number is
    // never asked for in a group. Only bail when we positively know it is one.
    const group = ctx.chat?.type !== undefined && ctx.chat.type !== "private";
    if (from === undefined || chatId === undefined || group) {
      await next();
      return;
    }

    if (services.isLinked(db, String(from))) {
      await sendCard(bot, chatId, linkOrMenu(db, String(from)));
      return;
    }
    await askForContact(bot, chatId);
  });

  bot.on("message:contact", async (ctx, next) => {
    const contact = ctx.message?.contact;
    const from = ctx.from?.id;
    const chatId = ctx.chat?.id;
    if (!contact || from === undefined || chatId === undefined) {
      await next();
      return;
    }

    const result = services.linkByContact(db, String(from), {
      phoneNumber: contact.phone_number,
      userId: contact.user_id,
    });

    if (!result.ok) {
      await bot.api.sendMessage(chatId, t.link.refusal[result.reason] ?? t.errors.generic, {
        reply_markup: { remove_keyboard: true },
      });
      // The number was wrong, not the method: offer the button again.
      await askForContact(bot, chatId);
      return;
    }

    // Drop the reply keyboard first, then show where they stand and the menu.
    const progress = services.progressFor(db, String(from));
    const welcome = toTelegram(linkedCard(result.student.fullName, progress.linked ? progress.progress : []));
    await bot.api.sendMessage(chatId, welcome.text, {
      ...welcome.other,
      reply_markup: { remove_keyboard: true },
    });
    await sendCard(bot, chatId, linkOrMenu(db, String(from)));
  });

  bot.on("callback_query:data", async (ctx, next) => {
    const data = ctx.callbackQuery?.data;
    const from = ctx.from?.id;
    const chatId = ctx.chat?.id;

    // Not one of ours — most likely a `ck:` id from a card the agent posted.
    // Hand it back to the adapter rather than acking it here.
    if (!isOurs(data) || from === undefined || chatId === undefined) {
      await next();
      return;
    }

    // Telegram spins the button until the query is answered, and gives about
    // three seconds. Ack before doing any work.
    await ctx.answerCallbackQuery?.().catch(() => {});

    // Until the student has checked in, every button leads back to the one
    // thing they can do. `route` refuses an unlinked caller too — it just has
    // no way to send the reply keyboard, which is the part that unblocks them.
    if (!services.isLinked(db, String(from))) {
      await askForContact(bot, chatId);
      return;
    }

    const rendered = route(db, String(from), data);
    const { text, other } = toTelegram(rendered.card);
    const messageId = ctx.callbackQuery?.message?.message_id;

    if (rendered.mode === "edit" && messageId !== undefined) {
      try {
        await ctx.api.editMessageText(chatId, messageId, text, other);
        return;
      } catch {
        // "message is not modified", a message too old to edit, or a card that
        // was posted by something else. Falling through to a new message is
        // always correct, if untidy.
      }
    }
    await bot.api.sendMessage(chatId, text, other);
  });
}

/** Our payloads are the ones `callbacks.ts` can read. */
function isOurs(data: string | undefined): data is string {
  if (!data) return false;
  if (data.startsWith("ck:")) return false;
  return true;
}
