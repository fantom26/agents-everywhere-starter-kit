/**
 * There is no `channel.start()`. Attaching the Channel to a CopilotRuntime and
 * creating the listener is what starts it — which is why teardown is wired
 * before the listener exists.
 *
 * This process owns three things: the Channel's Telegram connection, the
 * SQLite database, and the reminder scheduler. They share one process on
 * purpose — a reminder an hour before a session needs something long-running,
 * which is the same reason a Channel cannot live in a serverless handler.
 */
import { createServer } from "node:http";
import { CopilotKitIntelligence, CopilotRuntime } from "@copilotkit/runtime/v2";
import { createCopilotNodeListener } from "@copilotkit/runtime/v2/node";
import { channel, telegramAdapter } from "./channel";
import { required } from "./env";
import { db, dbPath } from "./db";
import { seedDatabase } from "./seed";
import { startReminderScheduler } from "./reminders";
import { calendarFromEnv, setCalendar } from "./calendar";
import { handleOAuthRequest, oauthConfigured } from "./google-oauth";

const intelligence = new CopilotKitIntelligence({
  apiKey: required("INTELLIGENCE_API_KEY"),
  // Hosted Intelligence supplies both defaults. Override both together only for
  // self-hosted — they are separate hosts, so never derive one from the other.
  apiUrl: process.env.INTELLIGENCE_API_URL,
  wsUrl: process.env.INTELLIGENCE_GATEWAY_WS_URL,
});

const runtime = new CopilotRuntime({
  agents: {}, // required even though the Channel supplies the agent
  intelligence,
  channels: [channel],
});

// An empty database means a fresh clone. Seed it rather than starting a bot
// that answers every question with "there are no sessions".
const database = db();
const seeded = database.prepare(`SELECT COUNT(*) AS n FROM sessions`).get() as { n: number };
if (Number(seeded.n) === 0) {
  const result = seedDatabase(database);
  console.log(`  ✓ Seeded ${result.sessions} sessions and ${result.students} students.`);
}

let teardown: (() => Promise<void>) | undefined;
const shutdown = async () => {
  await teardown?.();
  process.exit(0);
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

// Google Calendar, when it is configured. Unconfigured is a supported state:
// the no-op writes nothing and the menu entry does not appear.
setCalendar(calendarFromEnv());

const listener = createCopilotNodeListener({ runtime, basePath: "/api/copilotkit" });
const channels = listener.channels;

// The consent round trip rides on the server the runtime needs anyway — a
// Channel owns a long-lived process, so there is no second service here and no
// separate backend for the button UI. OAuth paths are claimed first; everything
// else goes to the listener untouched.
const server = createServer((req, res) => {
  void handleOAuthRequest(req, res, database).then((handled) => {
    if (!handled) listener(req, res);
  });
});

const stopReminders = startReminderScheduler({
  db: database,
  bot: telegramAdapter.bot,
  onError: (error) => console.error("  reminder scheduler:", error),
});

teardown = async () => {
  stopReminders();
  await channels.stop();
  if (server.listening) server.close();
  database.close();
};

await channels.ready({ timeoutMs: 30_000 });

// `ready()` is NOT proof of life — it resolves on `setup_required` too. On the
// managed path that means the bot answers nothing, so the Slack template exits
// here. A direct adapter is different: Telegram ingress is this process's own
// grammY long-poll, which is already running, so an unprovisioned Intelligence
// Channel degrades rather than breaks. Warn loudly and keep serving.
const status = channels.status();
if (status.overall === "error") {
  console.error(`\n  Channel activation failed: ${JSON.stringify(status)}\n`);
  await teardown();
  process.exit(1);
}
if (status.overall !== "online") {
  console.warn(
    `\n  ⚠ Channel status is "${status.overall}", not "online".\n` +
      `    Telegram long-polling runs from this process, so the bot should still reply.\n` +
      `    Check the Channel Code in CopilotKit Intelligence if history or identity looks wrong.\n`,
  );
}

const port = Number(process.env.PORT ?? 3000);
server.listen(port, () => {
  console.log(`\n  ✓ Practice Agent online — listening on :${port}`);
  console.log(`    Database: ${dbPath()}`);
  console.log(
    `    Google Calendar: ${
      oauthConfigured()
        ? `on, consent at ${process.env.PUBLIC_BASE_URL}/oauth/google/callback`
        : "off (set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and PUBLIC_BASE_URL)"
    }`,
  );
  console.log(`    Open Telegram, find your bot, and send /start.\n`);
});
