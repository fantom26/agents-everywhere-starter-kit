/**
 * The practice database connection.
 *
 * `node:sqlite` ships with Node, so the relational store adds no dependency and
 * no service to run — the npm scripts pass `--experimental-sqlite`, which turns
 * it on under Node 22 and is a no-op under Node 24.
 *
 * The tables and the constraints they enforce live in `schema.ts`; this file
 * only opens connections and wraps writes in transactions.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { applySchema } from "./schema";

export type Db = DatabaseSync;

export function openDb(path = dbPath()): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  applySchema(db);
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
