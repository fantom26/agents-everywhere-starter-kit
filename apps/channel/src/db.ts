/**
 * The practice database.
 *
 * `node:sqlite` ships with Node, so the relational store adds no dependency and
 * no service to run — the npm scripts pass `--experimental-sqlite`, which turns
 * it on under Node 22 and is a no-op under Node 24.
 *
 * Rules that SQLite can enforce are enforced *here*, not in the agent and not
 * even in the TypeScript above it: a student cannot hold two active bookings
 * for one session, and a mentoring session cannot have two coaches or two
 * clients. Those are partial unique indexes — the database rejects the write
 * regardless of what any caller believes.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type Db = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS students (
  id                INTEGER PRIMARY KEY,
  full_name         TEXT    NOT NULL,
  phone             TEXT    NOT NULL UNIQUE,
  telegram_user_id  TEXT    UNIQUE,
  linked_at         TEXT
);

CREATE TABLE IF NOT EXISTS practice_types (
  code              TEXT    PRIMARY KEY,
  title             TEXT    NOT NULL,
  capacity          INTEGER NOT NULL,
  required_per_year INTEGER NOT NULL,
  role_based        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS practice_roles (
  practice_type_code TEXT    NOT NULL REFERENCES practice_types(code),
  role               TEXT    NOT NULL,
  seats              INTEGER NOT NULL,
  PRIMARY KEY (practice_type_code, role)
);

CREATE TABLE IF NOT EXISTS sessions (
  id                 INTEGER PRIMARY KEY,
  practice_type_code TEXT    NOT NULL REFERENCES practice_types(code),
  starts_at          TEXT    NOT NULL,
  trainer            TEXT    NOT NULL,
  zoom_url           TEXT    NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS bookings (
  id           INTEGER PRIMARY KEY,
  session_id   INTEGER NOT NULL REFERENCES sessions(id),
  student_id   INTEGER NOT NULL REFERENCES students(id),
  role         TEXT,
  status       TEXT    NOT NULL CHECK (status IN ('active','cancelled')),
  is_extra     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT    NOT NULL,
  cancelled_at TEXT,
  reminded_at  TEXT
);

-- One active booking per student per session. This is what makes a duplicate
-- booking impossible rather than merely unlikely.
CREATE UNIQUE INDEX IF NOT EXISTS bookings_one_active_per_student
  ON bookings(session_id, student_id) WHERE status = 'active';

-- Exactly one coach and one client per group-mentoring session. Listeners have
-- ten seats, so they are bounded by the capacity check instead.
CREATE UNIQUE INDEX IF NOT EXISTS bookings_singleton_roles
  ON bookings(session_id, role)
  WHERE status = 'active' AND role IN ('coach', 'client');

CREATE INDEX IF NOT EXISTS bookings_by_student ON bookings(student_id, status);
CREATE INDEX IF NOT EXISTS sessions_by_start   ON sessions(starts_at);
`;

/**
 * Columns added after the first database existed.
 *
 * `CREATE TABLE IF NOT EXISTS` does nothing to a table that is already there,
 * so a checkout with a `practice.db` from last week would be missing these and
 * fail at the first query. Adding them one at a time, guarded, means an old
 * database and a fresh one end up identical without a migration framework.
 */
const ADDED_COLUMNS: { table: string; column: string; type: string }[] = [
  // Google Calendar: the student's grant, and the event a booking created.
  { table: "students", column: "google_refresh_token", type: "TEXT" },
  { table: "students", column: "google_email", type: "TEXT" },
  { table: "students", column: "google_connected_at", type: "TEXT" },
  { table: "bookings", column: "google_event_id", type: "TEXT" },
];

function addMissingColumns(db: Db): void {
  for (const { table, column, type } of ADDED_COLUMNS) {
    const existing = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (existing.some((row) => String(row.name) === column)) continue;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

export function openDb(path = dbPath()): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  addMissingColumns(db);
  return db;
}

let singleton: Db | undefined;

/** The process-wide database. Tests open their own with `openDb(":memory:")`. */
export function db(): Db {
  singleton ??= openDb();
  return singleton;
}

export function dbPath(): string {
  return process.env.PRACTICE_DB_PATH
    ? resolve(process.env.PRACTICE_DB_PATH)
    : resolve(process.cwd(), "data/practice.db");
}

/**
 * Run `fn` inside an immediate transaction.
 *
 * `BEGIN IMMEDIATE` takes the write lock up front, so the capacity count and
 * the insert that depends on it cannot be interleaved with another booking.
 * Returning a failure result still commits nothing of consequence; throwing
 * rolls back — which is how `reschedule_booking` keeps the old seat when the
 * new one turns out to be unbookable.
 */
export function transact<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** Thrown inside `transact` to roll back deliberately with a typed reason. */
export class Rollback<T> extends Error {
  constructor(readonly result: T) {
    super("rollback");
  }
}
