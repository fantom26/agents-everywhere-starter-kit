/**
 * The database, as the rest of the app sees it.
 *
 * `seed.ts` is deliberately not re-exported: it is a dev fixture with its own
 * entrypoint, and pulling it through this barrel would load the demo roster
 * into every process that opens a connection.
 */
export { type Db, openDb, db, dbPath, transact, Rollback } from "./client";
export { applySchema } from "./schema";
