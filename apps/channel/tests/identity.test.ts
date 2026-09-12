/**
 * Who a Telegram account is, and how it stays that way.
 *
 * The product's worst UX bug was asking for a phone number it already had, so
 * these tests are as much about *persistence* as about linking: the link has to
 * survive a fresh lookup, a re-seed, and anything the student types afterwards.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { openDb, type Db } from "../src/db";
import { seedDatabase } from "../src/db/seed";
import { normalizePhone } from "../src/services/identity";
import * as services from "../src/services";

const NOW = new Date("2026-09-12T09:00:00.000Z");
const ME = { tg: "555001", phone: "+380501112233", name: "Олена Ковальчук" };
const CLASSMATE = { tg: "555002", phone: "+380671234567" };

let db: Db;

beforeEach(() => {
  db = openDb(":memory:");
  seedDatabase(db, NOW);
});

describe("linking once", () => {
  it("identifies the student on every later interaction, with no phone number", () => {
    const linked = services.linkByPhone(db, ME.tg, ME.phone);
    assert.ok(linked.ok);

    // Every later turn resolves from the Telegram id alone.
    for (let turn = 0; turn < 3; turn += 1) {
      const student = services.resolveCaller(db, ME.tg);
      assert.equal(student?.fullName, ME.name);
    }
    assert.equal(services.isLinked(db, ME.tg), true);
    assert.equal(services.isLinked(db, "someone-else"), false);
  });

  it("is idempotent when the same number arrives again", () => {
    services.linkByPhone(db, ME.tg, ME.phone);
    const again = services.linkByPhone(db, ME.tg, "0501112233");
    assert.ok(again.ok);
    assert.equal(again.alreadyLinked, true);
  });

  it("survives a re-seed, so refreshing the demo data does not log everyone out", () => {
    services.linkByPhone(db, ME.tg, ME.phone);
    seedDatabase(db, NOW);

    const student = services.resolveCaller(db, ME.tg);
    assert.equal(student?.fullName, ME.name, "the link must be carried across by phone");
  });
});

describe("shared contacts", () => {
  it("accepts a contact the sender shared about themselves", () => {
    const result = services.linkByContact(db, ME.tg, {
      phoneNumber: ME.phone,
      userId: Number(ME.tg),
    });
    assert.ok(result.ok);
    assert.equal(result.student.fullName, ME.name);
  });

  it("refuses a forwarded contact card belonging to somebody else", () => {
    // Telegram lets anyone forward a classmate's contact. Without this check the
    // share button would be weaker than typing the number.
    const result = services.linkByContact(db, ME.tg, {
      phoneNumber: CLASSMATE.phone,
      userId: Number(CLASSMATE.tg),
    });

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "contact_not_own");
    assert.equal(services.isLinked(db, ME.tg), false, "nothing may be linked by this");
  });

  it("refuses a contact with no sender attached", () => {
    const result = services.linkByContact(db, ME.tg, { phoneNumber: ME.phone, userId: null });
    assert.equal(result.ok, false);
  });
});

describe("one account, one student", () => {
  it("refuses a number already claimed by another Telegram account", () => {
    assert.ok(services.linkByPhone(db, ME.tg, ME.phone).ok);

    const thief = services.linkByPhone(db, "999999", ME.phone);
    assert.equal(thief.ok, false);
    if (!thief.ok) assert.equal(thief.reason, "phone_taken");
    assert.equal(services.resolveCaller(db, ME.tg)?.fullName, ME.name, "the original stands");
  });

  it("refuses to point one linked account at a second student", () => {
    assert.ok(services.linkByPhone(db, ME.tg, ME.phone).ok);

    // `telegram_user_id` is UNIQUE, so the alternative to a clean refusal here
    // is a raw constraint violation surfacing as a crash.
    const moved = services.linkByPhone(db, ME.tg, CLASSMATE.phone);
    assert.equal(moved.ok, false);
    if (!moved.ok) assert.equal(moved.reason, "telegram_already_linked");
    assert.equal(services.resolveCaller(db, ME.tg)?.fullName, ME.name);
  });

  it("refuses a number that is not on the roster", () => {
    const result = services.linkByPhone(db, ME.tg, "+380000000000");
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "no_such_phone");
  });

  it("reads the formats students actually type", () => {
    for (const written of ["0501112233", "+38 (050) 111-22-33", "380501112233", "501112233"]) {
      assert.equal(normalizePhone(written), "380501112233", written);
    }
  });
});
