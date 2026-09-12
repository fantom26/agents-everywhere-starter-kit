/**
 * The button product, end to end, without Telegram.
 *
 * `route` takes a database, a Telegram user id and a payload — so the entire
 * no-AI experience can be walked here exactly as a student would tap it, and
 * every screen is rendered through the real Telegram renderer to prove what
 * they would actually see.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { renderToIR } from "@copilotkit/channels";
import { renderTelegram } from "@copilotkit/channels/telegram";
import { openDb, type Db } from "./db";
import { seedDatabase } from "./seed";
import { linkStudent } from "./identity";
import { availability, getBookings, getProgress, searchSessions } from "./domain";
import { route, linkOrMenu, type Rendered } from "./router";
import { cb, decode, type Action } from "./callbacks";

const NOW = new Date("2026-09-12T09:00:00.000Z");
const TG = "424242";
const ME = 1;

let db: Db;
let seed: ReturnType<typeof seedDatabase>;

beforeEach(() => {
  db = openDb(":memory:");
  seed = seedDatabase(db, NOW);
  linkStudent(db, TG, "+380501112233");
});

/** The inline keyboard as Telegram receives it: rows of buttons. */
function rowsOf(rendered: Rendered) {
  return renderTelegram(renderToIR(rendered.card as never)).inlineKeyboard ?? [];
}

/** What Telegram would show for a screen. */
function shown(card: Rendered["card"] | Rendered) {
  const node = "card" in (card as Rendered) ? (card as Rendered).card : card;
  const payload = renderTelegram(renderToIR(node as never));
  return {
    text: payload.text,
    buttons: (payload.inlineKeyboard ?? []).flat(),
  };
}

/** The payloads a screen offers, decoded. */
const actions = (rendered: Rendered) =>
  shown(rendered).buttons.map((button) => decode(button.callbackData));

const tap = (payload: string, now = NOW) => route(db, TG, payload, now);

describe("navigating with buttons", () => {
  it("opens the menu for a linked student and never asks for a phone", () => {
    const { text, buttons } = shown(linkOrMenu(db, TG));
    assert.match(text, /Practice Agent/);
    assert.ok(!/phone/i.test(text), `the menu must not ask for a phone:\n${text}`);
    assert.deepEqual(
      buttons.map((button) => decode(button.callbackData)?.kind),
      ["find", "progress", "bookings", "info"],
    );
  });

  it("sends an unlinked account to the link prompt whatever it taps", () => {
    for (const payload of [cb.menu(), cb.progress(), cb.book(seed.soonSessionId)]) {
      const rendered = route(db, "999999", payload, NOW);
      assert.match(shown(rendered).text, /share/i);
    }
    // and nothing was booked by the attempt
    assert.equal(getBookings(db, ME, { now: NOW }).length, 0);
  });

  it("walks find → type → period → a bookable session", () => {
    assert.ok(actions(tap(cb.find())).some((action) => action?.kind === "findPeriod"));

    const period = tap(cb.findPeriod("inter"));
    assert.deepEqual(
      actions(period).filter((a) => a?.kind === "findSlots").length,
      3,
      "this week, next week, pick a date",
    );

    const slots = tap(cb.findSlots("inter", "n"));
    const offered = actions(slots).filter((a) => a?.kind === "book" || a?.kind === "session");
    assert.ok(offered.length > 0, "next week should have intermodule sessions");
  });

  it("books a session and says so, and the booking is real", () => {
    const target = searchSessions(db, { practiceTypeCode: "intermodule", limit: 1 }, NOW)[0];
    const rendered = tap(cb.book(target.session.id));

    assert.equal(rendered.mode, "send", "a confirmation is worth keeping in the chat");
    assert.match(shown(rendered).text, /Booked/);
    assert.equal(getBookings(db, ME, { now: NOW }).length, 1);
  });

  it("refuses a full session with the reason, and books nothing", () => {
    const rendered = tap(cb.book(seed.fullSessionId));
    assert.match(shown(rendered).text, /full/i);
    assert.ok(rendered.toast, "a refusal should also flash a toast");
    assert.equal(getBookings(db, ME, { now: NOW }).length, 0);
  });

  it("refuses a duplicate booking on the second tap", () => {
    const target = searchSessions(db, { practiceTypeCode: "intermodule", limit: 1 }, NOW)[0];
    tap(cb.book(target.session.id));
    const again = tap(cb.book(target.session.id));

    assert.match(shown(again).text, /already/i);
    assert.equal(getBookings(db, ME, { now: NOW }).length, 1, "still exactly one seat");
  });

  it("falls back to the menu when a payload cannot be read", () => {
    const rendered = tap("b:not-a-session");
    assert.match(shown(rendered).text, /Practice Agent/);
    assert.ok(rendered.toast, "the student should be told the button was stale");
  });
});

describe("group mentoring roles", () => {
  it("shows a taken role as text and offers only the free ones", () => {
    const rendered = tap(cb.session(seed.mentoringSessionId));
    const { text, buttons } = shown(rendered);

    // The fixture's coach seat is taken.
    assert.match(text, /Coach/, "the student should still see that a coach role exists");
    assert.match(text, /occupied/i);

    const offers = buttons
      .map((button) => decode(button.callbackData))
      .filter((action): action is Extract<Action, { kind: "book" }> => action?.kind === "book");
    assert.ok(offers.length > 0, "free roles must be tappable");
    assert.ok(
      offers.every((offer) => offer.role !== "coach"),
      "a taken role must never be a button",
    );
  });

  it("refuses a role that was taken between the card and the tap", () => {
    const rendered = tap(cb.book(seed.mentoringSessionId, "coach"));
    assert.match(shown(rendered).text, /taken/i);
    assert.equal(getBookings(db, ME, { now: NOW }).length, 0);
  });

  it("books a free role and records it", () => {
    tap(cb.book(seed.mentoringSessionId, "client"));
    const booking = getBookings(db, ME, { now: NOW })[0];
    assert.equal(booking.role, "client");
  });
});

describe("cancelling", () => {
  it("asks before it cancels", () => {
    const target = searchSessions(db, { practiceTypeCode: "intermodule", limit: 1 }, NOW)[0];
    tap(cb.book(target.session.id));
    const booking = getBookings(db, ME, { now: NOW })[0];

    const confirm = tap(cb.cancelAsk(booking.id));
    assert.match(shown(confirm).text, /Cancel this booking\?/i);
    assert.equal(getBookings(db, ME, { now: NOW }).length, 1, "asking must not cancel");

    const done = tap(cb.cancelDo(booking.id));
    assert.match(shown(done).text, /cancelled/i);
    assert.equal(getBookings(db, ME, { now: NOW }).length, 0);
  });

  it("gives the seat back to the student's progress", () => {
    const target = searchSessions(db, { practiceTypeCode: "intermodule", limit: 1 }, NOW)[0];
    const before = getProgress(db, ME).find((entry) => entry.code === "intermodule")!.booked;

    tap(cb.book(target.session.id));
    const booking = getBookings(db, ME, { now: NOW })[0];
    assert.equal(
      getProgress(db, ME).find((entry) => entry.code === "intermodule")!.booked,
      before + 1,
    );

    tap(cb.cancelDo(booking.id));
    assert.equal(
      getProgress(db, ME).find((entry) => entry.code === "intermodule")!.booked,
      before,
    );
  });
});

describe("rescheduling", () => {
  const booked = () => {
    const target = searchSessions(db, { practiceTypeCode: "intermodule", limit: 1 }, NOW)[0];
    tap(cb.book(target.session.id));
    return getBookings(db, ME, { now: NOW })[0];
  };

  it("never offers the session the student is already on", () => {
    const booking = booked();
    const rendered = tap(cb.reschedulePeriod(booking.id, "n"));
    const offered = actions(rendered).filter((a) => a?.kind === "rescheduleDo");
    assert.ok(offered.length > 0, "there should be somewhere to move to");
    assert.ok(
      !shown(rendered).buttons.some(
        (button) => button.callbackData === `"${cb.rescheduleDo(booking.id, booking.sessionId)}"`,
      ),
      "the current session must not be an option",
    );
  });

  it("moves the booking and keeps one seat", () => {
    const booking = booked();
    const target = searchSessions(db, { practiceTypeCode: "intermodule", limit: 5 }, NOW).find(
      (slot) => slot.session.id !== booking.sessionId,
    )!;

    const rendered = tap(cb.rescheduleDo(booking.id, target.session.id));
    assert.match(shown(rendered).text, /Moved/i);

    const after = getBookings(db, ME, { now: NOW });
    assert.equal(after.length, 1);
    assert.equal(after[0].sessionId, target.session.id);
  });

  it("keeps the original seat when the target is full", () => {
    // Book a trio, then try to move it onto the trio session that is full.
    const trio = searchSessions(db, { practiceTypeCode: "trios", limit: 1 }, NOW)[0];
    tap(cb.book(trio.session.id));
    const booking = getBookings(db, ME, { now: NOW })[0];

    const rendered = tap(cb.rescheduleDo(booking.id, seed.fullSessionId));
    assert.match(shown(rendered).text, /full/i);

    const after = getBookings(db, ME, { now: NOW });
    assert.equal(after.length, 1);
    assert.equal(after[0].sessionId, trio.session.id, "the student keeps the seat they had");
  });
});

describe("what Telegram receives", () => {
  it("renders every screen inside Telegram's limits", () => {
    const screens: [string, Rendered][] = [
      ["menu", tap(cb.menu())],
      ["find", tap(cb.find())],
      ["period", tap(cb.findPeriod("all"))],
      ["slots", tap(cb.findSlots("all", "n"))],
      ["dates", tap(cb.findSlots("inter", "d"))],
      ["roles", tap(cb.session(seed.mentoringSessionId))],
      ["progress", tap(cb.progress())],
      ["bookings", tap(cb.bookings())],
      ["info", tap(cb.info())],
    ];

    for (const [name, rendered] of screens) {
      const { text, buttons } = shown(rendered);
      assert.ok(text.length <= 4096, `${name} is ${text.length} characters`);
      assert.ok(buttons.length <= 100, `${name} has ${buttons.length} buttons`);
      for (const button of buttons) {
        assert.ok(
          button.url || button.callbackData,
          `${name} has a button that does nothing: ${button.text}`,
        );
        if (button.callbackData) {
          assert.ok(
            Buffer.byteLength(button.callbackData) <= 64,
            `${name}: "${button.text}" would be dropped silently by Telegram`,
          );
          assert.ok(
            decode(button.callbackData),
            `${name}: "${button.text}" carries a payload the router cannot read`,
          );
        }
      }
    }
  });

  it("never puts so many buttons in one row that Telegram elides the labels", () => {
    // Telegram divides a row's width between its buttons. Seven in a row is
    // seven slivers reading "1....r", which is what this guards against: the
    // renderer packs one <Actions> block into rows of eight, so a screen must
    // emit a block per row.
    const screens: [string, Rendered][] = [
      ["menu", tap(cb.menu())],
      ["find", tap(cb.find())],
      ["period", tap(cb.findPeriod("all"))],
      ["slots", tap(cb.findSlots("all", "n"))],
      ["dates", tap(cb.findSlots("inter", "d"))],
      ["roles", tap(cb.session(seed.mentoringSessionId))],
      ["progress", tap(cb.progress())],
      ["bookings", tap(cb.bookings())],
      ["info", tap(cb.info())],
    ];

    for (const [name, rendered] of screens) {
      for (const row of rowsOf(rendered)) {
        assert.ok(row.length <= 3, `${name} has a row of ${row.length} buttons`);

        // A row shares its width, so the longest label in it is what gets cut.
        const widest = Math.max(...row.map((button) => button.text.length));
        assert.ok(
          widest * row.length <= 60,
          `${name}: ${row.length} buttons with a ${widest}-character label will not fit`,
        );
      }
    }
  });

  it("gives a session button a label that says which session it is", () => {
    const rendered = tap(cb.findSlots("inter", "n"));
    const labels = shown(rendered)
      .buttons.filter((button) => {
        const action = decode(button.callbackData);
        return action?.kind === "book" || action?.kind === "session";
      })
      .map((button) => button.text);

    assert.ok(labels.length > 0);
    for (const label of labels) {
      // "1 · Tue 15 Sep, 18:30" — a day and a time, because two sessions of one
      // practice often share a day.
      assert.match(label, /\d{2}:\d{2}/, `"${label}" does not say when`);
      assert.ok(label.length <= 30, `"${label}" is too long for a row`);
    }
  });

  it("offers a date picker built only from days that have sessions", () => {
    const rendered = tap(cb.findSlots("ment", "d"));
    const days = actions(rendered).filter((action) => action?.kind === "findOnDate");
    assert.ok(days.length > 0, "mentoring runs on some day in the fixture");

    for (const day of days) {
      if (day?.kind !== "findOnDate") continue;
      const onThatDay = tap(cb.findOnDate("ment", day.date));
      assert.ok(
        actions(onThatDay).some((a) => a?.kind === "book" || a?.kind === "session"),
        `${day.date} was offered but has nothing to book`,
      );
    }
  });

  it("keeps availability honest: a card never offers a session that is full", () => {
    const rendered = tap(cb.findSlots("trios", "n"));
    for (const action of actions(rendered)) {
      if (action?.kind !== "book" && action?.kind !== "session") continue;
      const sessionId = action.kind === "book" ? action.sessionId : action.sessionId;
      assert.ok(availability(db, sessionId)!.free > 0, `session ${sessionId} is full`);
    }
  });
});
