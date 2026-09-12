/**
 * The callback grammar.
 *
 * This is the button UI's entire memory, so it gets tested like a protocol: it
 * round-trips, it fits in Telegram's 64 bytes, and it never throws on input it
 * does not recognise. The 64-byte check matters more than it looks — the
 * Telegram renderer drops an over-long button *silently*, so the failure a
 * student sees is a keyboard with a row missing and no error anywhere.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cb, decode, fitsTelegram, wireForm, codeFor, tokenFor } from "../src/bot/callbacks";

describe("callback grammar", () => {
  it("round-trips every screen", () => {
    const cases: [string, ReturnType<typeof decode>][] = [
      [cb.menu(), { kind: "menu" }],
      [cb.find(), { kind: "find" }],
      [cb.findPeriod("trios"), { kind: "findPeriod", type: "trios" }],
      [cb.findSlots("inter", "w"), { kind: "findSlots", type: "inter", period: "w" }],
      [cb.findSlots("all", "n"), { kind: "findSlots", type: "all", period: "n" }],
      [cb.findOnDate("ment", "2026-09-17"), { kind: "findOnDate", type: "ment", date: "2026-09-17" }],
      [cb.session(17), { kind: "session", sessionId: 17 }],
      [cb.book(17), { kind: "book", sessionId: 17 }],
      [cb.book(17, "listener"), { kind: "book", sessionId: 17, role: "listener" }],
      [cb.progress(), { kind: "progress" }],
      [cb.bookings(), { kind: "bookings" }],
      [cb.cancelAsk(9), { kind: "cancelAsk", bookingId: 9 }],
      [cb.cancelDo(9), { kind: "cancelDo", bookingId: 9 }],
      [cb.reschedule(9), { kind: "reschedule", bookingId: 9 }],
      [cb.reschedulePeriod(9, "n"), { kind: "reschedulePeriod", bookingId: 9, period: "n" }],
      [cb.rescheduleDo(9, 42), { kind: "rescheduleDo", bookingId: 9, sessionId: 42 }],
      [cb.info(), { kind: "info" }],
      [cb.noop(), { kind: "noop" }],
    ];

    for (const [payload, expected] of cases) {
      assert.deepEqual(decode(payload), expected, `raw form of ${payload}`);
      // The renderer JSON-encodes the value, so the quoted form is what
      // actually arrives from Telegram.
      assert.deepEqual(decode(wireForm(payload)), expected, `wire form of ${payload}`);
    }
  });

  it("keeps every payload inside Telegram's 64 bytes", () => {
    const longest = [
      cb.findOnDate("ment", "2026-12-31"),
      cb.book(999_999, "listener"),
      cb.rescheduleDo(999_999, 999_999),
    ];
    for (const payload of longest) {
      assert.ok(
        fitsTelegram(payload),
        `${payload} is ${Buffer.byteLength(wireForm(payload))} bytes — the button would vanish`,
      );
    }
  });

  it("returns undefined rather than throwing on anything else", () => {
    for (const payload of [
      undefined,
      "",
      "ck:9f2c1d",          // an agent-rendered button from an older card
      "b:",                 // no session id
      "b:abc",              // not a number
      "b:17:teacher",       // not a role
      "f:physics",          // not a practice type
      "f:trios:q",          // not a period
      "f:trios:d:17-09",    // not an ISO date
      "{",                  // not even a string
      '"',
    ]) {
      assert.equal(decode(payload), undefined, `should not decode: ${String(payload)}`);
    }
  });

  it("maps type tokens onto practice codes both ways", () => {
    assert.equal(codeFor("trios"), "trios");
    assert.equal(codeFor("inter"), "intermodule");
    assert.equal(codeFor("ment"), "mentoring");
    assert.equal(codeFor("all"), undefined, "'all' means no filter at all");

    assert.equal(tokenFor("intermodule"), "inter");
    assert.equal(tokenFor("mentoring"), "ment");
    assert.equal(tokenFor("something-new"), "all", "an unknown code falls back to everything");
  });
});
