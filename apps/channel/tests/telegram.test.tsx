/**
 * The Telegram surface, without Telegram.
 *
 * `renderTelegram` is the same function the adapter uses on the way out, so
 * rendering a card through it here proves what a student would actually receive
 * — HTML text plus an inline keyboard — with no bot token and no network. The
 * reminder tests drive the scheduler against a fake bot for the same reason.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { renderToIR } from "@copilotkit/channels";
import { renderTelegram } from "@copilotkit/channels/telegram";
import { openDb, type Db } from "../src/db";
import { decode } from "../src/bot/callbacks";
import { seedDatabase } from "../src/db/seed";
import { availability, bookPractice, getBookings, cancelBooking } from "../src/services/domain";
import { linkStudent } from "../src/services/identity";
import { sendDueReminders, type ReminderBot } from "../src/services/reminders";
import {
  attachTelegramHandlers,
  type BotContext,
  type BotLike,
  type NextFn,
} from "../src/bot/handlers/telegram";
import {
  bookingConfirmation,
  bookingsCard,
  progressCard,
  reminderCard,
  sessionOptions,
  linkPrompt,
} from "../src/bot/messages/components";
import { getProgress, searchSessions } from "../src/services/domain";
import { HOUR_MS } from "../src/time";

const NOW = new Date("2026-09-12T09:00:00.000Z");
const ME = 1;

let db: Db;
let seed: ReturnType<typeof seedDatabase>;

beforeEach(() => {
  db = openDb(":memory:");
  seed = seedDatabase(db, NOW);
});

/** Captures what would have gone to Telegram. */
function fakeBot(behaviour: { fail?: boolean } = {}) {
  const sent: { chatId: string; text: string; other?: Record<string, unknown> }[] = [];
  const bot: ReminderBot = {
    api: {
      async sendMessage(chatId, text, other) {
        if (behaviour.fail) throw new Error("Telegram: bot was blocked by the user");
        sent.push({ chatId: String(chatId), text, other });
        return { message_id: sent.length };
      },
    },
  };
  return { bot, sent };
}

describe("Telegram rendering", () => {
  it("renders a booking confirmation as Telegram HTML with the real session data", () => {
    const booked = bookPractice(db, { studentId: ME, sessionId: seed.soonSessionId }, NOW);
    assert.ok(booked.ok);
    const found = availability(db, seed.soonSessionId)!;

    const payload = renderTelegram(
      renderToIR(
        bookingConfirmation(found, {
          bookingId: booked.bookingId,
          role: null,
          isExtra: booked.isExtra,
          now: NOW,
        }),
      ),
    );

    assert.equal(payload.parseMode, "HTML");
    assert.match(payload.text, /Booked/);
    assert.match(payload.text, /Intermodule meeting/);
    assert.ok(
      payload.text.includes(found.session.zoomUrl),
      "the confirmation must carry the session's own Zoom link",
    );
    assert.ok(
      payload.text.includes(found.session.trainer),
      "the confirmation must name the real trainer",
    );
  });

  it("renders search results with one inline-keyboard button per option", () => {
    const found = searchSessions(db, { practiceTypeCode: "intermodule", limit: 3 }, NOW);
    assert.equal(found.length, 3);

    const payload = renderTelegram(renderToIR(sessionOptions(found, NOW)));
    const buttons = (payload.inlineKeyboard ?? []).flat();

    // One button per session, plus the Back button every screen carries.
    const booking = buttons.filter((button) => {
      const action = decode(button.callbackData);
      return action?.kind === "book" || action?.kind === "session";
    });
    assert.equal(booking.length, 3, "each offered session needs a booking button");
    assert.ok(
      buttons.some((button) => decode(button.callbackData)?.kind === "menu"),
      "a search card needs a way back",
    );

    for (const button of buttons) {
      assert.ok(button.callbackData, "a booking button must carry callback data");
      assert.ok(
        Buffer.byteLength(button.callbackData) <= 64,
        `callback_data must fit Telegram's 64-byte limit, got ${button.callbackData.length}`,
      );
      assert.ok(button.text.length <= 64, "button label must fit Telegram's limit");
    }
  });

  it("renders an empty search as an explanation, offering no session to book", () => {
    const payload = renderTelegram(renderToIR(sessionOptions([], NOW)));
    assert.match(payload.text, /No free sessions/);

    // A way back is fine — a button that claims to book something is not.
    const buttons = (payload.inlineKeyboard ?? []).flat();
    assert.ok(
      buttons.every((button) => {
        const action = decode(button.callbackData);
        return action?.kind !== "book" && action?.kind !== "session";
      }),
      "an empty search must not offer a session",
    );
  });

  it("never offers a taken mentoring role in a rendered card", () => {
    const found = availability(db, seed.mentoringSessionId)!;
    const payload = renderTelegram(renderToIR(sessionOptions([found], NOW)));
    // The coach seat is taken in the fixture, so the card must not advertise it.
    assert.match(payload.text, /Client/);
    assert.ok(!/Coach/.test(payload.text), `coach must not be offered:\n${payload.text}`);
  });

  it("keeps every card inside Telegram's 4096-character message limit", () => {
    const progress = getProgress(db, ME);
    const many = searchSessions(db, { limit: 10 }, NOW);
    for (const [name, node] of [
      ["welcome", linkPrompt()],
      ["progress", progressCard("Олена Ковальчук", progress)],
      ["options", sessionOptions(many, NOW)],
      ["bookings", bookingsCard(getBookings(db, ME, { now: NOW }), NOW)],
    ] as const) {
      const payload = renderTelegram(renderToIR(node));
      assert.ok(
        payload.text.length <= 4096,
        `${name} card is ${payload.text.length} characters`,
      );
    }
  });

  it("puts a Zoom link button on the reminder", () => {
    const booked = bookPractice(db, { studentId: ME, sessionId: seed.soonSessionId }, NOW);
    assert.ok(booked.ok);
    const booking = getBookings(db, ME, { now: NOW })[0];

    const payload = renderTelegram(renderToIR(reminderCard(booking)));
    const button = (payload.inlineKeyboard ?? []).flat()[0];
    assert.ok(button, "the reminder needs a join button");
    assert.equal(button.url, booking.session.zoomUrl);
  });
});

describe("reminder scheduler", () => {
  /** Book the soon session and link Telegram, then look an hour before it starts. */
  const arrange = () => {
    linkStudent(db, "777001", "+380501112233");
    const booked = bookPractice(db, { studentId: ME, sessionId: seed.soonSessionId }, NOW);
    assert.ok(booked.ok);
    const start = availability(db, seed.soonSessionId)!.session.startsAt;
    return { bookingId: booked.bookingId, anHourBefore: new Date(start.getTime() - HOUR_MS) };
  };

  it("sends one reminder an hour before, to the linked chat", async () => {
    const { anHourBefore } = arrange();
    const { bot, sent } = fakeBot();

    const count = await sendDueReminders({ db, bot }, anHourBefore);

    assert.equal(count, 1);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].chatId, "777001");
    assert.match(sent[0].text, /Practice in an hour/);
    assert.match(sent[0].text, /Intermodule meeting/);
  });

  it("does not send the same reminder twice", async () => {
    const { anHourBefore } = arrange();
    const { bot, sent } = fakeBot();

    await sendDueReminders({ db, bot }, anHourBefore);
    await sendDueReminders({ db, bot }, new Date(anHourBefore.getTime() + 60_000));

    assert.equal(sent.length, 1);
  });

  it("sends nothing three hours out", async () => {
    arrange();
    const { bot, sent } = fakeBot();
    await sendDueReminders({ db, bot }, NOW);
    assert.equal(sent.length, 0);
  });

  it("sends nothing for a cancelled booking", async () => {
    const { bookingId, anHourBefore } = arrange();
    cancelBooking(db, { studentId: ME, bookingId }, NOW);
    const { bot, sent } = fakeBot();
    await sendDueReminders({ db, bot }, anHourBefore);
    assert.equal(sent.length, 0);
  });

  it("retries on the next tick when Telegram rejects the send", async () => {
    const { anHourBefore } = arrange();

    // A blocked bot must not consume the reminder.
    const failing = fakeBot({ fail: true });
    const errors: unknown[] = [];
    const sentCount = await sendDueReminders(
      { db, bot: failing.bot, onError: (error) => errors.push(error) },
      anHourBefore,
    );
    assert.equal(sentCount, 0);
    assert.equal(errors.length, 1);

    // The same booking is still due, and goes out once the send succeeds.
    const working = fakeBot();
    await sendDueReminders({ db, bot: working.bot }, anHourBefore);
    assert.equal(working.sent.length, 1);
  });
});

/**
 * The grammY bot, faked.
 *
 * `attachTelegramHandlers` registers by filter string, so the fake keeps the
 * handlers in a map and the tests fire one by name — which is as close to a real
 * update as this gets without a token.
 */
function fakeChannelBot() {
  const sent: { chatId: string; text: string; other?: Record<string, unknown> }[] = [];
  const handlers = new Map<string, (ctx: BotContext, next: NextFn) => Promise<void>>();
  const bot: BotLike = {
    api: {
      async sendMessage(chatId, text, other) {
        sent.push({ chatId: String(chatId), text, other });
        return { message_id: sent.length };
      },
      async editMessageText() {
        return {};
      },
    },
    on(filter, handler) {
      handlers.set(filter, handler);
    },
    command(name, handler) {
      handlers.set(`command:${name}`, handler);
    },
  };

  /** Fire one update at the handler registered for `filter`. */
  const fire = async (filter: string, ctx: Partial<BotContext>) => {
    const handler = handlers.get(filter);
    assert.ok(handler, `no handler registered for ${filter}`);
    await handler({ api: bot.api, ...ctx } as BotContext, async () => {});
  };

  return { bot, sent, fire };
}

/** The reply keyboard on a sent message, if it carries one. */
function replyKeyboard(other?: Record<string, unknown>) {
  const markup = other?.reply_markup as
    | { keyboard?: { text: string; request_contact?: boolean }[][] }
    | undefined;
  return (markup?.keyboard ?? []).flat();
}

describe("checking in", () => {
  const TG = 424242;

  it("answers /start with the contact button — the adapter's own handler never runs", async () => {
    const { bot, sent, fire } = fakeChannelBot();
    attachTelegramHandlers(bot, db);

    await fire("command:start", { chat: { id: TG }, from: { id: TG } });

    assert.equal(sent.length, 1);
    const [share] = replyKeyboard(sent[0].other);
    assert.ok(share, `/start must offer the contact button:\n${JSON.stringify(sent[0])}`);
    assert.equal(share.request_contact, true);
    assert.match(sent[0].text, /phone number/);
  });

  it("opens the menu on /start once the student is linked, with no keyboard left over", async () => {
    linkStudent(db, String(TG), "+380501112233");
    const { bot, sent, fire } = fakeChannelBot();
    attachTelegramHandlers(bot, db);

    await fire("command:start", { chat: { id: TG }, from: { id: TG } });

    assert.equal(sent.length, 1);
    assert.equal(replyKeyboard(sent[0].other).length, 0);
    assert.ok(!/phone/i.test(sent[0].text), `a linked student is not asked again:\n${sent[0].text}`);
  });

  it("sends the contact button back, not a screen, when an unlinked account taps a button", async () => {
    const { bot, sent, fire } = fakeChannelBot();
    attachTelegramHandlers(bot, db);

    await fire("callback_query:data", {
      chat: { id: TG },
      from: { id: TG },
      callbackQuery: { id: "1", data: "m", message: { message_id: 7 } },
      answerCallbackQuery: async () => ({}),
    });

    assert.equal(sent.length, 1);
    assert.ok(replyKeyboard(sent[0].other).some((button) => button.request_contact));
  });

  it("links a shared contact, clears the keyboard, and lands on the menu", async () => {
    const { bot, sent, fire } = fakeChannelBot();
    attachTelegramHandlers(bot, db);

    await fire("message:contact", {
      chat: { id: TG },
      from: { id: TG },
      message: { contact: { phone_number: "+380501112233", user_id: TG } },
    });

    assert.equal(sent.length, 2, "a welcome and the menu");
    assert.deepEqual(sent[0].other?.reply_markup, { remove_keyboard: true });
    assert.match(sent[0].text, /Олена Ковальчук/);
  });

  it("offers the button again when the shared number is not on the roster", async () => {
    const { bot, sent, fire } = fakeChannelBot();
    attachTelegramHandlers(bot, db);

    await fire("message:contact", {
      chat: { id: TG },
      from: { id: TG },
      message: { contact: { phone_number: "+380500000000", user_id: TG } },
    });

    assert.equal(sent.length, 2, "the refusal, then the button again");
    assert.match(sent[0].text, /not on the student roster/);
    assert.ok(replyKeyboard(sent[1].other).some((button) => button.request_contact));
  });
});
