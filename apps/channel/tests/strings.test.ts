/**
 * The copy collection.
 *
 * Translation is a post-competition job, and the thing that makes it a one-file
 * change is that no screen holds a literal of its own. These tests are the
 * cheap guard on that promise: every practice the database knows about has a
 * title here, and every refusal the domain can return has a sentence.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db";
import { seedDatabase, PRACTICE_TYPES } from "../src/db/seed";
import { listPracticeTypes, type Refusal } from "../src/services/domain";
import { t, practiceTitle, roleName } from "../src/bot/messages/strings";

const NOW = new Date("2026-09-12T09:00:00.000Z");

/** Every refusal `domain.ts` can produce. Add one there, add a sentence here. */
const REFUSALS: Refusal[] = [
  "session_not_found",
  "session_in_past",
  "already_booked",
  "session_full",
  "role_required",
  "role_not_applicable",
  "unknown_role",
  "role_taken",
  "quota_reached_too_early",
  "booking_not_found",
  "different_practice_type",
];

describe("strings", () => {
  it("has a title for every practice type in the database", () => {
    const db = openDb(":memory:");
    seedDatabase(db, NOW);

    for (const type of listPracticeTypes(db)) {
      assert.ok(
        t.practice[type.code],
        `no translated title for "${type.code}" — it would fall back to the database's`,
      );
      assert.equal(practiceTitle(type.code, type.title), t.practice[type.code]);
    }
    assert.equal(PRACTICE_TYPES.length, Object.keys(t.practice).length);
  });

  it("falls back to the database title for a practice nobody translated", () => {
    assert.equal(practiceTitle("brand-new", "Brand new practice"), "Brand new practice");
  });

  it("names every role", () => {
    for (const role of ["coach", "client", "listener"] as const) {
      assert.ok(roleName(role).length > 0);
    }
  });

  it("explains every refusal the domain can return", () => {
    for (const reason of REFUSALS) {
      const sentence = t.refusal(reason, { taken: 6, capacity: 6, booked: 6, required: 6 });
      assert.ok(sentence.length > 0, `no sentence for ${reason}`);
      assert.notEqual(
        sentence,
        t.errors.generic,
        `${reason} falls through to the generic error instead of explaining itself`,
      );
    }
  });

  it("puts the numbers a student needs into the refusal, from facts alone", () => {
    const full = t.refusal("session_full", { taken: 6, capacity: 6 });
    assert.match(full, /6/, "a capacity refusal is useless without the numbers");

    const quota = t.refusal(
      "quota_reached_too_early",
      { booked: 4, required: 4 },
      { bookableFrom: "Friday, 18 September, 17:00" },
    );
    assert.match(quota, /4/);
    assert.match(quota, /Friday, 18 September, 17:00/);
  });
});
