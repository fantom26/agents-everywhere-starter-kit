/**
 * Who is talking to the bot.
 *
 * The school already has a roster keyed by phone number, so the first thing a
 * student does is prove which row is theirs. After that, `telegram_user_id` is
 * the identity: every tool resolves the caller from the Telegram actor id and
 * nothing downstream ever takes a student id from the model. That is what stops
 * "book Andriy in for Wednesday" from working.
 */
import type { Db } from "../db";

export type Student = {
  id: number;
  fullName: string;
  phone: string;
  telegramUserId: string | null;
};

/** Reduce a typed phone number to digits so formatting differences stop mattering. */
export function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D+/g, "");
  // Ukrainian numbers arrive as +380…, 380…, 0…, or with spaces and dashes.
  if (digits.length === 10 && digits.startsWith("0")) return `380${digits.slice(1)}`;
  if (digits.length === 12 && digits.startsWith("380")) return digits;
  if (digits.length === 9) return `380${digits}`;
  return digits;
}

function toStudent(row: Record<string, string | number | null> | undefined): Student | undefined {
  if (!row) return undefined;
  return {
    id: Number(row.id),
    fullName: String(row.full_name),
    phone: String(row.phone),
    telegramUserId: row.telegram_user_id === null ? null : String(row.telegram_user_id),
  };
}

export function findStudentByTelegramId(db: Db, telegramUserId: string): Student | undefined {
  return toStudent(
    db
      .prepare(
        `SELECT id, full_name, phone, telegram_user_id FROM students WHERE telegram_user_id = ?`,
      )
      .get(telegramUserId) as Record<string, string | number | null> | undefined,
  );
}

export type LinkRefusal = "no_such_phone" | "phone_taken" | "telegram_already_linked";

export type LinkOutcome =
  | { ok: true; student: Student; alreadyLinked: boolean }
  | { ok: false; reason: LinkRefusal; explanation: string };

/**
 * Attach a Telegram account to a roster row.
 *
 * Two refusals, both of them one-way doors on purpose. A phone already claimed
 * by a different Telegram account is refused rather than reassigned — otherwise
 * anyone who knows a classmate's number could take over their progress. And a
 * Telegram account already linked to one student cannot be pointed at another:
 * `telegram_user_id` is UNIQUE, so the alternative is not a second link but a
 * raw constraint violation.
 */
export function linkStudent(db: Db, telegramUserId: string, rawPhone: string): LinkOutcome {
  const phone = normalizePhone(rawPhone);
  const existing = findStudentByTelegramId(db, telegramUserId);
  if (existing) {
    if (normalizePhone(existing.phone) === phone) {
      return { ok: true, student: existing, alreadyLinked: true };
    }
    return {
      ok: false,
      reason: "telegram_already_linked",
      explanation:
        "This Telegram account is already linked to a different student on the roster. The coordinator has to unlink it first.",
    };
  }

  const rows = db
    .prepare(`SELECT id, full_name, phone, telegram_user_id FROM students`)
    .all() as Record<string, string | number | null>[];
  const match = rows.find((row) => normalizePhone(String(row.phone)) === phone);
  if (!match) {
    return {
      ok: false,
      reason: "no_such_phone",
      explanation:
        "That phone number is not on the student roster. Ask the student to check it, or to contact the coordinator if they believe they should be on the list.",
    };
  }
  const claimedBy = match.telegram_user_id === null ? null : String(match.telegram_user_id);
  if (claimedBy && claimedBy !== telegramUserId) {
    return {
      ok: false,
      reason: "phone_taken",
      explanation:
        "That phone number is already linked to a different Telegram account. The coordinator has to unlink it first.",
    };
  }

  db.prepare(
    `UPDATE students SET telegram_user_id = ?, linked_at = ? WHERE id = ?`,
  ).run(telegramUserId, new Date().toISOString(), Number(match.id));

  const student = toStudent({ ...match, telegram_user_id: telegramUserId });
  return { ok: true, student: student!, alreadyLinked: false };
}
