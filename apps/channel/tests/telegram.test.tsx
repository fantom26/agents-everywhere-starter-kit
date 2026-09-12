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
