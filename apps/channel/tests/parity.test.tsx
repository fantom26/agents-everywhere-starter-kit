/**
 * One set of rules, two front doors.
 *
 * This is the file that has to fail if the button UI and the agent ever start
 * disagreeing. Each scenario is run twice against the same database — once
 * through the agent's tool, once through a button tap — by two students in
 * identical situations. The assertion is not "both refused" but "both refused
 * for the same reason, said the same thing to the student, and left the same
 * rows behind".
 *
 * The tools resolve the database lazily through the process-wide singleton, so
 * point it at a throwaway file before anything imports it — the same trick
 * `demo.tsx` uses.
 */
import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PRACTICE_DB_PATH = join(mkdtempSync(join(tmpdir(), "practice-parity-")), "parity.db");

const { renderToIR } = await import("@copilotkit/channels");
const { renderTelegram } = await import("@copilotkit/channels/telegram");
const { db } = await import("../src/db");
const { seedDatabase } = await import("../src/db/seed");
const { linkStudent } = await import("../src/services/identity");
const { getBookings, getProgress, searchSessions } = await import("../src/services/domain");
const { route, refusalText } = await import("../src/bot/handlers/router");
const { cb } = await import("../src/bot/callbacks");
const { bookPracticeTool, cancelBookingTool, rescheduleBookingTool } = await import("../src/agent/tools");
const { HOUR_MS, DAY_MS } = await import("../src/time");

type Role = "coach" | "client" | "listener";

const NOW = new Date("2026-09-12T09:00:00.000Z");

/** Two students in the same position: one uses the agent, one uses buttons. */
const AI = { tg: "1000001", phone: "+380501112233", id: 1 };
const BUTTONS = { tg: "1000002", phone: "+380671234567", id: 2 };

const database = db();
let seed: ReturnType<typeof seedDatabase>;

beforeEach(() => {
  seed = seedDatabase(database, NOW);
  linkStudent(database, AI.tg, AI.phone);
  linkStudent(database, BUTTONS.tg, BUTTONS.phone);
});

/** A tool context whose actor is the given Telegram user. Cards are discarded. */
function toolCtx(telegramUserId: string) {
  return {
    thread: {
      async post() {
        return { id: "ref" };
      },
      async runAgent() {},
    },
    actor: { id: telegramUserId, kind: "human" as const },
    user: null,
    platform: "telegram",
  } as never;
}

const screenText = (card: unknown) => renderTelegram(renderToIR(card as never)).text;

type ToolRefusal = { booked?: boolean; refusal?: string; facts?: Record<string, unknown> };

/** Book through the agent's tool. */
const bookViaAi = (sessionId: number, role?: Role) =>
  bookPracticeTool.handler({ sessionId, role }, toolCtx(AI.tg)) as Promise<ToolRefusal>;

/** Book through a button tap. */
const bookViaButtons = (sessionId: number, role?: Role) =>
  route(database, BUTTONS.tg, cb.book(sessionId, role), NOW);

const bookingsOf = (studentId: number) => getBookings(database, studentId, { now: NOW });

/**
 * Run one booking through both doors and insist they agree.
 *
 * A refusal must carry the same machine reason on the AI side and the same
 * sentence on the button side — the button UI formats the refusal itself, from
 * the same `reason` and `facts`, so this catches a screen inventing its own
 * explanation.
 */
async function bothBook(sessionId: number, role?: Role) {
  const viaAi = await bookViaAi(sessionId, role);
  const viaButtons = bookViaButtons(sessionId, role);
  const text = screenText(viaButtons.card);

  if (viaAi.booked === false) {
    assert.ok(viaAi.refusal, "the tool must report a machine-readable reason");
    const expected = refusalText(viaAi.refusal as never, viaAi.facts ?? {});
    assert.equal(
      text.includes(expected.split(".")[0]),
      true,
      `the button UI should explain "${viaAi.refusal}" the same way.\n  tool: ${expected}\n  card: ${text}`,
    );
  }

  assert.equal(
    bookingsOf(AI.id).length,
    bookingsOf(BUTTONS.id).length,
    `the two doors left different numbers of bookings for "${viaAi.refusal ?? "success"}"`,
  );

  return { viaAi, text };
}

describe("both doors, one rulebook", () => {
  it("books an open session the same way", async () => {
    const target = searchSessions(database, { practiceTypeCode: "intermodule", limit: 1 }, NOW)[0];
    const { viaAi, text } = await bothBook(target.session.id);

    assert.equal(viaAi.booked, true);
    assert.match(text, /Booked/);
    assert.equal(bookingsOf(AI.id).length, 1);
    assert.equal(bookingsOf(BUTTONS.id).length, 1);
  });

  it("refuses a full session on both", async () => {
    const { viaAi } = await bothBook(seed.fullSessionId);
    assert.equal(viaAi.refusal, "session_full");
    assert.equal(bookingsOf(AI.id).length, 0);
  });

  it("refuses a duplicate on both", async () => {
    const target = searchSessions(database, { practiceTypeCode: "intermodule", limit: 1 }, NOW)[0];
    await bothBook(target.session.id);
    const { viaAi } = await bothBook(target.session.id);
    assert.equal(viaAi.refusal, "already_booked");
  });

  it("refuses a taken mentoring role on both", async () => {
    const { viaAi } = await bothBook(seed.mentoringSessionId, "coach");
    assert.equal(viaAi.refusal, "role_taken");
  });

  it("requires a role for group mentoring on both", async () => {
    const { viaAi } = await bothBook(seed.mentoringSessionId);
    assert.equal(viaAi.refusal, "role_required");
  });

  it("applies the quota and the 24-hour rule identically", async () => {
    // Fill the annual requirement for both students, avoiding the session that
    // starts within the window — that one is the point of the second half.
    const required = getProgress(database, AI.id).find((entry) => entry.code === "intermodule")!
      .required;
    const open = searchSessions(database, { practiceTypeCode: "intermodule", limit: 20 }, NOW)
      .filter((slot) => slot.session.id !== seed.soonSessionId)
      .slice(0, required);
    assert.equal(open.length, required, "fixture needs enough intermodule sessions");
    for (const slot of open) await bothBook(slot.session.id);

    // Beyond the requirement and more than 24 hours out: refused on both.
    const faraway = searchSessions(database, { practiceTypeCode: "intermodule", limit: 20 }, NOW)
      .find(
        (slot) =>
          slot.session.startsAt.getTime() - NOW.getTime() > DAY_MS &&
          !open.some((booked) => booked.session.id === slot.session.id),
      );
    assert.ok(faraway, "fixture needs a spare session more than a day out");

    const refused = await bothBook(faraway.session.id);
    assert.equal(refused.viaAi.refusal, "quota_reached_too_early");
    assert.match(refused.text, /24 hours/, "the card must say why, not just no");
    assert.match(refused.text, /from /, "and when it becomes bookable");

    // Inside the window, the same student is allowed the same spare seat.
    const allowed = await bothBook(seed.soonSessionId);
    assert.equal(allowed.viaAi.booked, true);
    assert.match(allowed.text, /beyond/i, "an extra booking should say so");
  });

  it("cancels the same way and returns the seat to progress", async () => {
    const target = searchSessions(database, { practiceTypeCode: "intermodule", limit: 1 }, NOW)[0];
    await bothBook(target.session.id);

    const before = getProgress(database, AI.id).find((entry) => entry.code === "intermodule")!.booked;

    await cancelBookingTool.handler({ bookingId: bookingsOf(AI.id)[0].id }, toolCtx(AI.tg));
    route(database, BUTTONS.tg, cb.cancelDo(bookingsOf(BUTTONS.id)[0].id), NOW);

    assert.equal(bookingsOf(AI.id).length, 0);
    assert.equal(bookingsOf(BUTTONS.id).length, 0);
    assert.equal(
      getProgress(database, AI.id).find((entry) => entry.code === "intermodule")!.booked,
      before - 1,
    );
    assert.deepEqual(
      getProgress(database, AI.id).map((entry) => entry.booked),
      getProgress(database, BUTTONS.id).map((entry) => entry.booked),
      "progress must move identically on both paths",
    );
  });

  it("keeps the original seat when a reschedule fails, on both", async () => {
    const trio = searchSessions(database, { practiceTypeCode: "trios", limit: 1 }, NOW)[0];
    await bothBook(trio.session.id);

    const aiBooking = bookingsOf(AI.id)[0];
    const buttonBooking = bookingsOf(BUTTONS.id)[0];

    const viaAi = (await rescheduleBookingTool.handler(
      { bookingId: aiBooking.id, newSessionId: seed.fullSessionId },
      toolCtx(AI.tg),
    )) as { rescheduled?: boolean; refusal?: string };
    const viaButtons = route(
      database,
      BUTTONS.tg,
      cb.rescheduleDo(buttonBooking.id, seed.fullSessionId),
      NOW,
    );

    assert.equal(viaAi.rescheduled, false);
    assert.equal(viaAi.refusal, "session_full");
    assert.match(screenText(viaButtons.card), /full/i);

    // The point of the rule: a failed move costs nothing.
    assert.equal(bookingsOf(AI.id)[0].sessionId, trio.session.id);
    assert.equal(bookingsOf(BUTTONS.id)[0].sessionId, trio.session.id);
  });

  it("never lets one Telegram account act for another student", async () => {
    const target = searchSessions(database, { practiceTypeCode: "intermodule", limit: 1 }, NOW)[0];
    await bookViaAi(target.session.id);

    // The AI student now holds a booking. Nothing the button door can send
    // names a student, so the only booking the other account can touch is its
    // own — a cancel aimed at someone else's booking id finds nothing.
    const theirs = bookingsOf(AI.id)[0];
    const rendered = route(database, BUTTONS.tg, cb.cancelDo(theirs.id), NOW);

    assert.match(screenText(rendered.card), /cannot find that booking/i);
    assert.equal(bookingsOf(AI.id).length, 1, "their booking must survive");
  });
});
