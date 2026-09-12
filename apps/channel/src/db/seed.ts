/**
 * Demo data.
 *
 * Sessions are generated relative to the moment you seed, so the 24-hour rule
 * and the one-hour reminder are always demonstrable without editing dates. The
 * roster stands in for the school's existing student list — the one real
 * external dependency this project assumes it would inherit.
 *
 * Run directly:  npm run seed --workspace channel
 */
import { pathToFileURL } from "node:url";
import type { Db } from "./client";
import { openDb } from "./client";
import { normalizePhone } from "../services/identity";
import { HOUR_MS, DAY_MS, kyivToUtc, kyivWallClock } from "../time";

export const PRACTICE_TYPES = [
  {
    code: "trios",
    title: "Trio practice",
    capacity: 6,
    requiredPerYear: 4,
    roles: [] as { role: string; seats: number }[],
  },
  {
    code: "intermodule",
    title: "Intermodule meeting",
    capacity: 10,
    requiredPerYear: 6,
    roles: [],
  },
  {
    code: "mentoring",
    title: "Group mentoring",
    capacity: 12,
    requiredPerYear: 3,
    roles: [
      { role: "coach", seats: 1 },
      { role: "client", seats: 1 },
      { role: "listener", seats: 10 },
    ],
  },
] as const;

const STUDENTS = [
  { name: "Олена Ковальчук", phone: "+380501112233" },
  { name: "Андрій Мельник", phone: "+380671234567" },
  { name: "Ірина Шевченко", phone: "+380931112244" },
  { name: "Дмитро Бондаренко", phone: "+380995556677" },
  { name: "Наталія Ткаченко", phone: "+380638889900" },
];

const TRAINERS = ["Марина Гнатюк", "Сергій Литвин", "Оксана Романюк"];

/** Next occurrence of a Kyiv wall-clock hour, at least `minLeadMs` from now. */
function upcomingKyiv(from: Date, dayOffset: number, hour: number, minute = 0): Date {
  const base = new Date(from.getTime() + dayOffset * DAY_MS);
  const wall = kyivWallClock(base);
  return kyivToUtc(wall.year, wall.month, wall.day, hour, minute);
}

export type SeedResult = {
  students: number;
  sessions: number;
  soonSessionId: number;
  fullSessionId: number;
  mentoringSessionId: number;
};

export function seedDatabase(db: Db, now = new Date()): SeedResult {
  // Re-seeding refreshes the demo sessions, and it used to unlink every student
  // with them — which is why the bot kept asking for a phone number it had
  // already been given. The roster is keyed by phone, so the links survive by
  // being carried across the rebuild by phone.
  const links = db
    .prepare(
      `SELECT phone, telegram_user_id, linked_at FROM students WHERE telegram_user_id IS NOT NULL`,
    )
    .all() as { phone: string; telegram_user_id: string; linked_at: string | null }[];

  db.exec(
    `DELETE FROM bookings; DELETE FROM sessions;
     DELETE FROM practice_roles; DELETE FROM practice_types; DELETE FROM students;`,
  );

  const insertType = db.prepare(
    `INSERT INTO practice_types (code, title, capacity, required_per_year, role_based)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const insertRole = db.prepare(
    `INSERT INTO practice_roles (practice_type_code, role, seats) VALUES (?, ?, ?)`,
  );
  for (const type of PRACTICE_TYPES) {
    insertType.run(
      type.code,
      type.title,
      type.capacity,
      type.requiredPerYear,
      type.roles.length > 0 ? 1 : 0,
    );
    for (const role of type.roles) insertRole.run(type.code, role.role, role.seats);
  }

  const insertStudent = db.prepare(
    `INSERT INTO students (full_name, phone) VALUES (?, ?)`,
  );
  const studentIds = STUDENTS.map(
    (student) => Number(insertStudent.run(student.name, student.phone).lastInsertRowid),
  );

  const insertSession = db.prepare(
    `INSERT INTO sessions (practice_type_code, starts_at, trainer, zoom_url)
     VALUES (?, ?, ?, ?)`,
  );
  let zoomCounter = 0;
  const addSession = (code: string, startsAt: Date, trainer: string) => {
    zoomCounter += 1;
    return Number(
      insertSession.run(
        code,
        startsAt.toISOString(),
        trainer,
        `https://zoom.us/j/98${String(700000 + zoomCounter)}`,
      ).lastInsertRowid,
    );
  };

  // Starts in three hours: inside the 24-hour window, so a student who has met
  // their quota can still take a seat, and the reminder fires during the demo.
  // Rounded down to a whole minute so it reads like a scheduled slot.
  const soon = new Date(Math.floor((now.getTime() + 3 * HOUR_MS) / 60_000) * 60_000);
  const soonSessionId = addSession("intermodule", soon, TRAINERS[0]);

  // A spread of ordinary sessions over the next two weeks. There are more
  // sessions of each type than the annual requirement, so a student can reach
  // their quota and still have somewhere to be refused.
  const sessionIds: number[] = [soonSessionId];
  for (let day = 1; day <= 14; day += 1) {
    if (day % 2 === 1) {
      sessionIds.push(
        addSession("intermodule", upcomingKyiv(now, day, 18, 30), TRAINERS[day % 3]),
      );
    }
    if (day % 3 === 0) {
      sessionIds.push(addSession("trios", upcomingKyiv(now, day, 19, 0), TRAINERS[day % 3]));
    }
    if (day % 4 === 0) {
      sessionIds.push(
        addSession("mentoring", upcomingKyiv(now, day, 17, 0), TRAINERS[(day + 1) % 3]),
      );
    }
  }

  // A morning session, so "after 18:00" has something to filter out.
  sessionIds.push(addSession("intermodule", upcomingKyiv(now, 2, 10, 0), TRAINERS[1]));

  // One session that is already full, so "why can't I book this?" has a real answer.
  const fullSessionId = addSession("trios", upcomingKyiv(now, 5, 18, 0), TRAINERS[2]);

  // One mentoring session whose coach seat is already taken.
  const mentoringSessionId = addSession("mentoring", upcomingKyiv(now, 3, 18, 0), TRAINERS[0]);

  const insertBooking = db.prepare(
    `INSERT INTO bookings (session_id, student_id, role, status, is_extra, created_at)
     VALUES (?, ?, ?, 'active', 0, ?)`,
  );
  const stamp = now.toISOString();

  // Classmates who occupy the pre-booked seats. They are deliberately separate
  // from the five named students, so whoever links their Telegram account for
  // the demo starts at zero progress with nothing already booked.
  let classmates = 0;
  const classmate = () => {
    classmates += 1;
    return Number(
      insertStudent.run(`Student ${classmates}`, `+38050000${String(1000 + classmates)}`)
        .lastInsertRowid,
    );
  };

  // Fill one trios session to its capacity of six, so "why can't I book this?"
  // has a real answer.
  const trios = PRACTICE_TYPES.find((type) => type.code === "trios")!;
  for (let i = 0; i < trios.capacity; i += 1) {
    insertBooking.run(fullSessionId, classmate(), null, stamp);
  }

  // Take the coach seat on one mentoring session, leaving client and listeners.
  insertBooking.run(mentoringSessionId, classmate(), "coach", stamp);

  // Put the Telegram links back, matched by phone. A number that has since left
  // the roster simply finds no row and is dropped.
  const relink = db.prepare(
    `UPDATE students SET telegram_user_id = ?, linked_at = ? WHERE phone = ?`,
  );
  const byPhone = new Map(
    (db.prepare(`SELECT id, phone FROM students`).all() as { id: number; phone: string }[]).map(
      (row) => [normalizePhone(String(row.phone)), String(row.phone)],
    ),
  );
  for (const link of links) {
    const phone = byPhone.get(normalizePhone(String(link.phone)));
    if (phone) relink.run(link.telegram_user_id, link.linked_at, phone);
  }

  return {
    students: studentIds.length + classmates,
    sessions: sessionIds.length + 3,
    soonSessionId,
    fullSessionId,
    mentoringSessionId,
  };
}

// Running this file directly seeds the on-disk database.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const db = openDb();
  const result = seedDatabase(db);
  console.log(
    `  ✓ Seeded ${result.students} students and ${result.sessions} sessions.\n` +
      `    Session ${result.soonSessionId} starts in 3 hours (24-hour rule + reminder demo).\n` +
      `    Session ${result.fullSessionId} is full. Session ${result.mentoringSessionId} has its coach seat taken.`,
  );
  db.close();
}
